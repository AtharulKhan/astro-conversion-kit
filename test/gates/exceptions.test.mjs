import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExceptions, applyExceptions } from '../../skills/parity-gates/scripts/lib/exceptions.mjs';

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
  const expected = { title: 'About', h1: ['About us'] };
  const out = applyExceptions(expected, '/about/', [H1]);
  assert.deepEqual(out.h1, ['About Fixture Roofing']);
  assert.equal(out.title, 'About');
  assert.equal(out.stale, false);
  assert.deepEqual(expected.h1, ['About us'], 'input record is not mutated');
});

test('applyExceptions ignores an exception whose from does not match and flags it stale', () => {
  const out = applyExceptions({ h1: ['Our story'] }, '/about/', [H1]);
  assert.deepEqual(out.h1, ['Our story']);
  assert.equal(out.stale, true);
  assert.deepEqual(out.staleExceptions, [H1]);
});

test('applyExceptions skips exceptions for other paths', () => {
  const out = applyExceptions({ h1: 'About us' }, '/contact/', [H1]);
  assert.equal(out.h1, 'About us');
  assert.equal(out.stale, false);
});

test('applyExceptions replaces a phrase inside visible text', () => {
  const exc = { ...H1, field: 'text', from: 'since 1999', to: 'since 2001' };
  const out = applyExceptions({ text: 'Serving you since 1999 with care' }, '/about/', [exc]);
  assert.equal(out.text, 'Serving you since 2001 with care');
  assert.equal(out.stale, false);
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

  const badField = join(dir, 'bad-field.json');
  writeFileSync(badField, JSON.stringify([{ ...H1, field: 'colour' }]));
  assert.throws(() => loadExceptions(badField, { env: {} }), /field/);

  assert.deepEqual(loadExceptions(join(dir, 'absent.json'), { env: {} }), []);
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
