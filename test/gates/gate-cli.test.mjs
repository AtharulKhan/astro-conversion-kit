import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateArgs, builtPages, report } from '../../skills/parity-gates/scripts/lib/gate-cli.mjs';

test('gateArgs has defaults', () => {
  const args = gateArgs([], 'seo');
  assert.equal(args.dist, 'dist');
  assert.equal(args.baseline, 'baseline');
  assert.equal(args.exceptions, 'exceptions.json');
  assert.equal(args.proposals, 'proposals.json');
  assert.equal(args.json, false);
  assert.equal(args.paths('/anything/'), true);
});

test('gateArgs applies --paths /a/,/blog/*', () => {
  const args = gateArgs(['--paths', '/a/,/blog/*', '--dist', 'out', '--json'], 'seo');
  assert.equal(args.dist, 'out');
  assert.equal(args.json, true);
  assert.equal(args.paths('/a/'), true);
  assert.equal(args.paths('/a/b/'), false);
  assert.equal(args.paths('/blog/'), true);
  assert.equal(args.paths('/blog/first-post/'), true);
  assert.equal(args.paths('/about/'), false);
});

test('gateArgs accepts --flag=value', () => {
  const args = gateArgs(['--baseline=capture', '--exceptions=ex.json', '--proposals=p.json'], 'seo');
  assert.equal(args.baseline, 'capture');
  assert.equal(args.exceptions, 'ex.json');
  assert.equal(args.proposals, 'p.json');
});

test('builtPages maps HTML files to URL paths', (t) => {
  const dist = mkdtempSync(join(tmpdir(), 'dist-'));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  mkdirSync(join(dist, 'about'));
  mkdirSync(join(dist, 'services', 'roofing'), { recursive: true });
  mkdirSync(join(dist, '_astro'));
  writeFileSync(join(dist, 'index.html'), '');
  writeFileSync(join(dist, '404.html'), '');
  writeFileSync(join(dist, 'about', 'index.html'), '');
  writeFileSync(join(dist, 'services', 'roofing', 'index.html'), '');
  writeFileSync(join(dist, '_astro', 'app.css'), '');
  assert.deepEqual(builtPages(dist), [
    { path: '/', file: join(dist, 'index.html') },
    { path: '/404.html', file: join(dist, '404.html') },
    { path: '/about/', file: join(dist, 'about', 'index.html') },
    { path: '/services/roofing/', file: join(dist, 'services', 'roofing', 'index.html') },
  ]);
});

function capture() {
  const chunks = [];
  let code = null;
  return {
    out: { write: (s) => chunks.push(s) },
    exit: (c) => {
      code = c;
    },
    text: () => chunks.join(''),
    code: () => code,
  };
}

test('report prints the summary and exits 0 when nothing failed', () => {
  const c = capture();
  report('seo', { checked: 3, failures: [] }, { json: false, out: c.out, exit: c.exit });
  assert.match(c.text(), /^seo: 3 checked, 0 failed$/m);
  assert.equal(c.code(), 0);
});

test('report lists failures and exits 1', () => {
  const c = capture();
  const failure = { path: '/about/', field: 'title', expected: 'About', actual: 'Aboot' };
  report('seo', { checked: 2, failures: [failure] }, { json: false, out: c.out, exit: c.exit });
  assert.match(c.text(), /\/about\/ title/);
  assert.match(c.text(), /^seo: 2 checked, 1 failed$/m);
  assert.equal(c.code(), 1);
});

test('report --json prints the machine-readable shape', () => {
  const c = capture();
  const failure = {
    path: '/',
    field: 'text',
    expected: 'a b',
    actual: 'a c',
    diff: [
      { op: 'equal', text: 'a' },
      { op: 'delete', text: 'b' },
      { op: 'insert', text: 'c' },
    ],
  };
  report('text', { checked: 1, failures: [failure] }, { json: true, out: c.out, exit: c.exit });
  assert.deepEqual(JSON.parse(c.text()), { gate: 'text', checked: 1, failed: 1, failures: [failure] });
  assert.equal(c.code(), 1);
});
