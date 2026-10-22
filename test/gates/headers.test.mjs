import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edit, makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';

let root;
let good;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'headers-gate-'));
  good = makeDist(join(root, 'dist-good'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const headers = (dist, args = [], { cwd = root, indexable = '' } = {}) =>
  runGate('headers', ['--dist', dist, ...args], { cwd, env: { PUBLIC_INDEXABLE: indexable } });

// A site root holding a vercel.json with `entries` on every path, and an empty dist.
function vercelSite(name, entries, source = '/(.*)') {
  const dir = join(root, name);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  const config = { headers: [{ source, headers: Object.entries(entries).map(([key, value]) => ({ key, value })) }] };
  writeFileSync(join(dir, 'vercel.json'), JSON.stringify(config));
  return dir;
}

const SECURE = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
};

test('dist-good passes: _headers carries the security headers and noindex', async () => {
  const result = await headers(good);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^headers: 4 checked, 0 failed$/m);
});

test('a missing header fails', async () => {
  const bad = makeDist(join(root, 'dist-missing'), { bad: ['missing-header'] });
  const result = await headers(bad);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/\* X-Content-Type-Options: expected "nosniff", got null$/m);
  assert.match(result.stdout, /^headers: 4 checked, 1 failed$/m);
});

test('noindex is required unless PUBLIC_INDEXABLE=true, and forbidden when it is', async () => {
  const dist = makeDist(join(root, 'dist-indexable'));
  assert.equal((await headers(dist, [], { indexable: 'true' })).code, 1);
  edit(dist, '_headers', '  X-Robots-Tag: noindex\n', '');
  const staging = await headers(dist);
  assert.equal(staging.code, 1);
  assert.match(staging.stdout, /\/\* X-Robots-Tag: expected "noindex", got null/);
  const production = await headers(dist, [], { indexable: 'true' });
  assert.equal(production.code, 0, production.stdout);
});

test('vercel.json headers on a catch-all source are read', async () => {
  const site = vercelSite('site-vercel', { ...SECURE, 'X-Robots-Tag': 'noindex' });
  const passed = await headers(join(site, 'dist'), [], { cwd: site });
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  const partial = vercelSite('site-vercel-blog', { ...SECURE, 'X-Robots-Tag': 'noindex' }, '/blog/(.*)');
  const failed = await headers(join(partial, 'dist'), [], { cwd: partial });
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\/\(\.\*\) X-Content-Type-Options: expected "nosniff", got null/);
});

test('a vercel.json rule with has or missing conditions does not count', async () => {
  const site = vercelSite('site-vercel-has', { ...SECURE, 'X-Robots-Tag': 'noindex' });
  const file = join(site, 'vercel.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.headers[0].has = [{ type: 'host', value: 'preview.example.com' }];
  writeFileSync(file, JSON.stringify(config));
  const result = await headers(join(site, 'dist'), [], { cwd: site });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^headers: 4 checked, 4 failed$/m);
});

test('a _headers whole-host pattern counts for X-Robots-Tag only', async () => {
  const dist = makeDist(join(root, 'dist-host-pattern'));
  edit(dist, '_headers', '  X-Robots-Tag: noindex\n', '');
  writeFileSync(join(dist, '_headers'), `${readFileSync(join(dist, '_headers'), 'utf8')}https://*.pages.dev/*\n  X-Robots-Tag: noindex\n`);
  const passed = await headers(dist);
  assert.equal(passed.code, 0, passed.stdout);
  const moved = makeDist(join(root, 'dist-host-nosniff'), { bad: ['missing-header'] });
  writeFileSync(join(moved, '_headers'), `${readFileSync(join(moved, '_headers'), 'utf8')}https://*.pages.dev/*\n  X-Content-Type-Options: nosniff\n`);
  const failed = await headers(moved);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\/\* X-Content-Type-Options: expected "nosniff", got null/);
});

test('CSP frame-ancestors stands in for X-Frame-Options', async () => {
  const { 'X-Frame-Options': _, ...rest } = SECURE;
  const csp = vercelSite('site-csp', { ...rest, 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Robots-Tag': 'noindex' });
  assert.equal((await headers(join(csp, 'dist'), [], { cwd: csp })).code, 0);
  const none = vercelSite('site-no-frame', { ...rest, 'X-Robots-Tag': 'noindex' });
  const result = await headers(join(none, 'dist'), [], { cwd: none });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /X-Frame-Options: expected "X-Frame-Options or CSP frame-ancestors", got null/);
});

test('no vercel.json and no _headers fails', async () => {
  const dist = makeDist(join(root, 'dist-none'));
  rmSync(join(dist, '_headers'));
  const result = await headers(dist);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /config: expected "vercel\.json or _headers", got null/);
});

test('usage errors exit 2 and --help exits 0', async () => {
  assert.equal((await headers(good, ['--bogus'])).code, 2);
  assert.equal((await headers(good, ['--vercel', 'missing.json'])).code, 2);
  const broken = join(root, 'site-broken');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'vercel.json'), '{ not json');
  assert.equal((await headers(good, [], { cwd: broken })).code, 2);
  const help = await runGate('headers', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /PUBLIC_INDEXABLE/);
});
