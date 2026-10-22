import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, TMP } from './helpers.mjs';

const ROOT = join(TMP, 'visual-check');

const pair = (route, width, percent, extra = {}) => ({
  route, width, percent, pass: percent <= 0.5, heightA: 2000, heightB: 2000, heightMismatch: false,
  percentUnaligned: percent, offset: [0, 0], threshold: 0.5, reason: null, decision: null, ...extra,
});
const style = (pass) => ({ route: 'home', path: '/', width: 390, selector: 'h1', property: 'font-size', live: '32px', new: pass ? '32px' : '40px', pass });

// A review folder holding the given files ({ 'diff/diff.json': rows, ... }).
function review(name, files) {
  const dir = join(ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  for (const [file, rows] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), typeof rows === 'string' ? rows : JSON.stringify(rows));
  }
  return dir;
}

const check = (dir) => run('check.mjs', ['--review', dir]);
const PASSING = {
  'diff/diff.json': [pair('home', 390, 0), pair('home', 1440, 0.2)],
  'diff-all/diff.json': [pair('home', 390, 0.1), pair('about', 390, 0)],
  'styles.json': [style(true)],
};

test('every row passing exits 0 and says how many rows were checked', async () => {
  const result = await check(review('pass', PASSING));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /diff\/diff\.json: 2 of 2 pairs pass/);
  assert.match(result.stdout, /diff-all\/diff\.json: 2 of 2 pairs pass/);
  assert.match(result.stdout, /styles\.json: 1 of 1 style rows pass/);
});

test('diff-all is optional', async () => {
  const { 'diff-all/diff.json': _, ...templatesOnly } = PASSING;
  const result = await check(review('no-all', templatesOnly));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /diff-all\/diff\.json: not present/);
});

test('a failing pair in either diff exits 1 and prints the worst pair', async () => {
  const result = await check(review('fail', {
    ...PASSING,
    'diff/diff.json': [pair('home', 390, 0.9), pair('home', 1440, 0)],
    'diff-all/diff.json': [pair('about', 390, 3.25, { heightMismatch: true, heightB: 1900 }), pair('blog', 1440, 0.7)],
  }));
  assert.equal(result.code, 1);
  assert.match(result.stdout, /worst pair: about\/390 3\.25% \(limit 0\.5%\)/);
  assert.match(result.stdout, /diff-all\/diff\.json: 0 of 2 pairs pass/);
});

test('a failing style row exits 1 and is printed', async () => {
  const result = await check(review('style-fail', { ...PASSING, 'styles.json': [style(true), style(false)] }));
  assert.equal(result.code, 1);
  assert.match(result.stdout, /styles\.json: 1 of 2 style rows pass/);
  assert.match(result.stdout, /home \(\/\) @390 h1 font-size: live 32px \| new 40px/);
});

test('a row marked pass is re-judged: over its threshold, a threshold above 2 %, or a loose one with no decision fails', async () => {
  for (const [name, row] of [
    ['over', pair('home', 390, 0.8, { pass: true })],
    ['cap', pair('home', 390, 3, { pass: true, threshold: 5, reason: 'x', decision: 'd1' })],
    ['undecided', pair('home', 390, 1, { pass: true, threshold: 1 })],
    ['errored', pair('home', 390, 0, { error: 'missing from review/new' })],
  ]) {
    const result = await check(review(`rejudge-${name}`, { ...PASSING, 'diff/diff.json': [row] }));
    assert.equal(result.code, 1, name);
  }
  const allowed = pair('home', 390, 1.5, { pass: true, threshold: 2, reason: 'rotating testimonial', decision: 'd12' });
  assert.equal((await check(review('rejudge-allowed', { ...PASSING, 'diff/diff.json': [allowed] }))).code, 0);
});

test('a missing diff or styles file, or an empty one, fails with exit 1', async () => {
  for (const [name, files] of [
    ['no-diff', { 'styles.json': [style(true)] }],
    ['no-styles', { 'diff/diff.json': [pair('home', 390, 0)] }],
    ['empty-diff', { ...PASSING, 'diff/diff.json': [] }],
    ['empty-styles', { ...PASSING, 'styles.json': [] }],
  ]) {
    const result = await check(review(name, files));
    assert.equal(result.code, 1, name);
    assert.match(result.stdout, /(not present|no rows)/, name);
  }
});

test('unreadable JSON and bad usage exit 2; --help exits 0', async () => {
  assert.equal((await check(review('corrupt', { ...PASSING, 'diff/diff.json': '{nope' }))).code, 2);
  assert.equal((await check(review('object', { ...PASSING, 'styles.json': { rows: [] } }))).code, 2);
  assert.equal((await run('check.mjs', ['--nope'])).code, 2);
  assert.equal((await run('check.mjs', ['--review', join(ROOT, 'does-not-exist')])).code, 2);
  const help = await run('check.mjs', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--review/);
});
