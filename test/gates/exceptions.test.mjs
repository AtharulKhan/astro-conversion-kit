import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadExceptions, applyExceptions } from '../../skills/parity-gates/scripts/lib/exceptions.mjs';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'parity-gates', 'scripts', 'lib', 'exceptions.mjs');

const H1 = {
  path: '/about/',
  field: 'h1',
  from: 'About us',
  to: 'About Fixture Roofing',
  reason: 'client renamed the heading',
  approvedBy: 'client',
  date: '2026-10-22',
};

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exceptions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('applyExceptions substitutes a matching h1 exception', () => {
  const input = { title: 'About', h1: ['About us'] };
  const out = applyExceptions(input, '/about/', [H1]);
  assert.deepEqual(out, {
    expected: { title: 'About', h1: ['About Fixture Roofing'] },
    stale: false,
    staleExceptions: [],
  });
  assert.deepEqual(input.h1, ['About us'], 'input record is not mutated');
});

test('applyExceptions ignores an exception whose from does not match and flags it stale', () => {
  const out = applyExceptions({ h1: ['Our story'] }, '/about/', [H1]);
  assert.deepEqual(out.expected, { h1: ['Our story'] });
  assert.equal(out.stale, true);
  assert.deepEqual(out.staleExceptions, [H1]);
});

test('applyExceptions skips exceptions for other paths', () => {
  const out = applyExceptions({ h1: 'About us' }, '/contact/', [H1]);
  assert.deepEqual(out.expected, { h1: 'About us' });
  assert.equal(out.stale, false);
});

test('applyExceptions replaces a phrase inside visible text', () => {
  const exc = { ...H1, field: 'text', from: 'since 1999', to: 'since 2001' };
  const out = applyExceptions({ text: 'Serving you since 1999 with care' }, '/about/', [exc]);
  assert.equal(out.expected.text, 'Serving you since 2001 with care');
  assert.equal(out.stale, false);
});

test('applyExceptions can record a field the build adds or removes', () => {
  const added = { ...H1, field: 'description', from: '', to: 'New meta description' };
  const out = applyExceptions({ title: 'About' }, '/about/', [added]);
  assert.deepEqual(out.expected, { title: 'About', description: 'New meta description' });
  assert.equal(out.stale, false);

  const removed = { ...H1, field: 'description', from: 'Old description', to: '' };
  const gone = applyExceptions({ description: 'Old description' }, '/about/', [removed]);
  assert.equal(gone.expected.description, '');
  assert.equal(gone.stale, false);
});

test('loadExceptions validates every record', (t) => {
  const dir = tempDir(t);
  const good = join(dir, 'exceptions.json');
  writeFileSync(good, JSON.stringify([H1]));
  assert.deepEqual(loadExceptions(good, { env: {} }), [H1]);

  const missing = join(dir, 'missing-field.json');
  const { reason, ...noReason } = H1;
  writeFileSync(missing, JSON.stringify([noReason]));
  assert.throws(() => loadExceptions(missing, { env: {} }), /reason/);

  const noFrom = join(dir, 'no-from.json');
  const { from, ...withoutFrom } = H1;
  writeFileSync(noFrom, JSON.stringify([withoutFrom]));
  assert.throws(() => loadExceptions(noFrom, { env: {} }), /from/);

  const badField = join(dir, 'bad-field.json');
  writeFileSync(badField, JSON.stringify([{ ...H1, field: 'colour' }]));
  assert.throws(() => loadExceptions(badField, { env: {} }), /field/);
});

test('loadExceptions accepts a "no redirect" record { kind: "redirect", path, reason, action: "none", approvedBy, date } and validates it', (t) => {
  const dir = tempDir(t);
  const none = { kind: 'redirect', path: '/two words/', reason: 'a broken live href', action: 'none', approvedBy: 'client', date: '2026-10-23' };
  const good = join(dir, 'none.json');
  writeFileSync(good, JSON.stringify([none, H1]));
  assert.deepEqual(loadExceptions(good, { env: {} }), [none, H1]);
  const bad = [
    [{ ...none, reason: '' }, /reason/],
    [{ ...none, path: undefined }, /path/],
    [{ ...none, approvedBy: undefined }, /approvedBy/],
    [{ ...none, date: '' }, /date/],
    [{ ...none, action: 'redirect' }, /action/],
    [{ ...none, kind: 'link' }, /kind/],
  ];
  bad.forEach(([record, message], i) => {
    const file = join(dir, `bad-${i}.json`);
    writeFileSync(file, JSON.stringify([record]));
    assert.throws(() => loadExceptions(file, { env: {} }), message);
  });
});

test('loadExceptions accepts an empty from or to', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'exceptions.json');
  const records = [
    { ...H1, field: 'description', from: '', to: 'Added' },
    { ...H1, field: 'description', from: 'Removed', to: '' },
  ];
  writeFileSync(file, JSON.stringify(records));
  assert.deepEqual(loadExceptions(file, { env: {} }), records);
});

test('loadExceptions adds proposals.json only when PROPOSALS=on', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'exceptions.json');
  const proposals = join(dir, 'proposals.json');
  const proposal = { ...H1, path: '/contact/', field: 'title' };
  writeFileSync(file, JSON.stringify([H1]));
  writeFileSync(proposals, JSON.stringify([proposal]));
  assert.deepEqual(loadExceptions(file, { proposals, env: {} }), [H1]);
  assert.deepEqual(loadExceptions(file, { proposals, env: { PROPOSALS: 'on' } }), [H1, proposal]);
});

test('a markup record loads from proposals.json; an unknown field is still rejected', (t) => {
  const dir = tempDir(t);
  const proposals = join(dir, 'proposals.json');
  writeFileSync(join(dir, 'exceptions.json'), '[]');
  const markup = { ...H1, field: 'markup', from: '<a href="https://www.example.com/">', to: '<a href="/">' };
  writeFileSync(proposals, JSON.stringify([markup]));
  assert.deepEqual(loadExceptions(join(dir, 'exceptions.json'), { proposals, env: { PROPOSALS: 'on' } }), [markup]);
  writeFileSync(proposals, JSON.stringify([{ ...markup, field: 'markupp' }]));
  assert.throws(() => loadExceptions(join(dir, 'exceptions.json'), { proposals, env: { PROPOSALS: 'on' } }), /field "markupp" is not one of/);
});

function runLoad(cwd, call) {
  const code = `import { loadExceptions } from ${JSON.stringify(pathToFileURL(LIB).href)};
const out = ${call};
process.stdout.write(JSON.stringify(out));`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8' });
}

test('loadExceptions allows only the default file to be missing', (t) => {
  const dir = tempDir(t);
  const dflt = runLoad(dir, "loadExceptions('exceptions.json', { env: { PROPOSALS: 'on' } })");
  assert.equal(dflt.status, 0, dflt.stderr);
  assert.equal(dflt.stdout, '[]');

  const explicit = runLoad(dir, "loadExceptions('chosen/exceptions.json', { env: {} })");
  assert.equal(explicit.status, 2);
  assert.match(explicit.stderr, /chosen\/exceptions\.json: exceptions file not found/);

  const proposals = runLoad(dir, "loadExceptions('exceptions.json', { proposals: 'p.json', env: { PROPOSALS: 'on' } })");
  assert.equal(proposals.status, 2);
  assert.match(proposals.stderr, /p\.json/);
});
