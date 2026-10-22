import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';

let root;
let baseline;
let good;
let bad;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'text-gate-'));
  baseline = await buildFixtureBaseline(root);
  good = makeDist(join(root, 'dist-good'));
  bad = makeDist(join(root, 'dist-bad'), { bad: ['missing-page', 'extra-page', 'changed-title', 'changed-h1', 'changed-paragraph'] });
});
after(() => rmSync(root, { recursive: true, force: true }));

const text = (dist, args = []) => runGate('text', ['--dist', dist, '--baseline', baseline, ...args], { cwd: root });

test('dist-good passes', async () => {
  const result = await text(good);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^text: 13 checked, 0 failed$/m);
});

test('dist-bad fails with a word diff of the changed words in 5 words of context', async () => {
  const result = await text(bad);
  assert.equal(result.code, 1);
  const contact = result.stdout.split('\n').find((line) => line.includes('/contact/ text:'));
  assert.ok(contact, result.stdout);
  assert.match(contact, /get back to you within \[-one-\] \{\+two\+\} business \[-day\.-\] \{\+days\.\+\}/);
  assert.match(contact, /^ {2}\/contact\/ text: \.\.\. /, 'leading context is cut to 5 words');
  assert.match(result.stdout, /\/services\/ text: \[-Services-\] \{\+Our services\+\}/);
  assert.match(result.stdout, /\/hidden-page\/ page: /);
  assert.doesNotMatch(result.stdout, /\/about\/ text/, 'a title change is not a text change');
  assert.match(result.stdout, /^text: 13 checked, 3 failed$/m);
});

test('a phrase exception makes the changed paragraph pass', async () => {
  const exceptions = join(root, 'text-exceptions.json');
  writeFileSync(
    exceptions,
    JSON.stringify([
      { path: '/contact/', field: 'text', from: 'within one business day', to: 'within two business days', reason: 'new service level', approvedBy: 'client', date: '2026-10-22' },
    ]),
  );
  const result = await text(bad, ['--exceptions', exceptions, '--paths', '/contact/']);
  assert.equal(result.code, 0, result.stdout);
});

test('a stale text exception and one for a path not checked fail the gate', async () => {
  const exceptions = join(root, 'stale-text-exceptions.json');
  const base = { field: 'text', reason: 'test', approvedBy: 'client', date: '2026-10-22' };
  writeFileSync(
    exceptions,
    JSON.stringify([
      { ...base, path: '/about/', from: 'since 1999', to: 'since 2001' },
      { ...base, path: '/feed/', from: 'a', to: 'b' },
    ]),
  );
  const result = await text(good, ['--exceptions', exceptions]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/about\/ exception: .*"no longer matches the baseline"/);
  assert.match(result.stdout, /\/feed\/ exception: .*"path not checked"/);
  assert.match(result.stdout, /^text: 13 checked, 2 failed$/m);
});

test('usage errors exit 2 and --help exits 0', async () => {
  assert.equal((await text(good, ['--bogus'])).code, 2);
  assert.equal((await runGate('text', ['--dist', join(root, 'nope'), '--baseline', baseline], { cwd: root })).code, 2);
  assert.equal((await runGate('text', ['--help'])).code, 0);
});
