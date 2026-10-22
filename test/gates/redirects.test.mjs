import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';
import { resolveVercel } from '../../skills/parity-gates/scripts/lib/vercel-resolver.mjs';
import { parseRedirectsFile, resolveCloudflare } from '../../skills/parity-gates/scripts/lib/cloudflare-resolver.mjs';

const exec = promisify(execFile);
const COMPILER = fileURLToPath(new URL('../../skills/parity-gates/scripts/build-redirects.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../../skills/convert-site/templates/site/vercel.json', import.meta.url));

let root;
let baseline;
let good;
let vercelDir;
let cloudflareDir;

// A site folder (cwd for the gate) holding redirects.csv and the host config compiled from it.
async function site(name, host, { rows = [], trailing = 'always' } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(root, 'redirects.csv'), join(dir, 'redirects.csv'));
  if (rows.length) appendFileSync(join(dir, 'redirects.csv'), `${rows.join('\n')}\n`);
  const out = host === 'vercel' ? 'vercel.json' : '_redirects';
  if (host === 'vercel') {
    const config = { ...JSON.parse(readFileSync(TEMPLATE, 'utf8')), ...(trailing === 'always' ? { trailingSlash: true } : { cleanUrls: true, trailingSlash: false }) };
    writeFileSync(join(dir, out), JSON.stringify(config));
  }
  await exec(process.execPath, [COMPILER, '--csv', 'redirects.csv', '--host', host, '--out', out, '--trailing-slash', trailing], { cwd: dir });
  return dir;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'redirects-gate-'));
  baseline = await buildFixtureBaseline(root);
  good = makeDist(join(root, 'dist-good'));
  vercelDir = await site('site-vercel', 'vercel');
  cloudflareDir = await site('site-cloudflare', 'cloudflare');
});
after(() => rmSync(root, { recursive: true, force: true }));

const gate = (cwd, dist, args = []) => runGate('redirects', ['--dist', dist, '--baseline', baseline, ...args], { cwd });
const vercelConfig = (dir) => JSON.parse(readFileSync(join(dir, 'vercel.json'), 'utf8'));

test('the live chain /old-services -> /old-services/ -> /services/ compiles to one rule', () => {
  const rules = vercelConfig(vercelDir).redirects.filter((r) => r.destination === '/services/' && !r.has);
  assert.deepEqual(rules, [{ source: '/old-services', destination: '/services/', statusCode: 301 }]);
  const lines = readFileSync(join(cloudflareDir, '_redirects'), 'utf8').split('\n');
  assert.deepEqual(lines.filter((l) => l.startsWith('/old-services')), ['/old-services /services/ 301']);
});

test('vercel: the chain resolves in one hop; the gate passes every baseline redirect', async () => {
  const resolved = resolveVercel('/old-services', { config: vercelConfig(vercelDir), dist: good });
  assert.deepEqual(resolved, { hops: [{ from: '/old-services', to: '/services/', status: 301 }], final: { path: '/services/', status: 200 } });
  const result = await gate(vercelDir, good);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^redirects: 14 checked, 0 failed$/m);
});

test('vercel trailingSlash: true runs before redirects, so a config that keeps it double-hops', async () => {
  const kept = { trailingSlash: true, redirects: [{ source: '/old-services/', destination: '/services/', statusCode: 301 }] };
  const resolved = resolveVercel('/old-services', { config: kept, dist: good });
  assert.deepEqual(resolved.hops, [
    { from: '/old-services', to: '/old-services/', status: 308 },
    { from: '/old-services/', to: '/services/', status: 301 },
  ]);
  const dir = join(root, 'site-kept');
  mkdirSync(dir);
  writeFileSync(join(dir, 'vercel.json'), JSON.stringify(kept));
  const result = await gate(dir, good, ['--paths', '/old-services']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/old-services hops: expected "1 hop to \/services\/", got "308 \/old-services\/ -> 301 \/services\/"/);
});

test('vercel never mode: compiled rules strip the slash only after the site redirects', async () => {
  const dist = makeDist(join(root, 'dist-file'), { bad: ['file-format'] });
  const dir = await site('site-never', 'vercel', { trailing: 'never', rows: ['/roofing-services/,/services/roofing,301,decision,'] });
  const config = vercelConfig(dir);
  assert.equal(config.cleanUrls, true);
  const resolved = resolveVercel('/roofing-services/', { config, dist });
  assert.deepEqual(resolved.hops, [{ from: '/roofing-services/', to: '/services/roofing', status: 301 }]);
  assert.deepEqual(resolved.final, { path: '/services/roofing', status: 200 });
  assert.deepEqual(resolveVercel('/contact/', { config, dist }).hops, [{ from: '/contact/', to: '/contact', status: 308 }]);
});

test('cloudflare: the chain resolves in one hop; unverified shortlinks fail as "unverified live"', async () => {
  const rules = parseRedirectsFile(readFileSync(join(cloudflareDir, '_redirects'), 'utf8'));
  const resolved = resolveCloudflare('/old-services', { rules, dist: good });
  assert.deepEqual(resolved, { hops: [{ from: '/old-services', to: '/services/', status: 301 }], final: { path: '/services/', status: 200 } });
  // Pages' own slash handling: /about/index.html is served at /about/, /about redirects to it.
  assert.deepEqual(resolveCloudflare('/contact', { rules, dist: good }).hops, [{ from: '/contact', to: '/contact/', status: 308 }]);
  const seeds = await gate(cloudflareDir, good, ['--paths', '/old-services,/about']);
  assert.equal(seeds.code, 0, seeds.stdout + seeds.stderr);
  assert.match(seeds.stdout, /^redirects: 2 checked, 0 failed$/m);
  // _redirects cannot match a query string, so /?p=7 serves the home page.
  const all = await gate(cloudflareDir, good);
  assert.equal(all.code, 1);
  assert.match(all.stdout, /\/\?p=7 redirect: expected "\/services\/", got "no redirect: 200 at \/ \[unverified live\]"/);
  assert.match(all.stdout, /^redirects: 14 checked, 12 failed$/m);
});

test('the host is read from the config that exists, or from --host', async () => {
  const auto = await gate(cloudflareDir, good, ['--paths', '/old-services', '--json']);
  assert.equal(JSON.parse(auto.stdout).failed, 0);
  const empty = join(root, 'site-empty');
  mkdirSync(empty);
  const none = await gate(empty, good);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /build-redirects/);
  const forced = await gate(vercelDir, good, ['--host', 'cloudflare']);
  assert.equal(forced.code, 2, 'no _redirects for --host cloudflare');
});

test('a redirect whose target is missing from dist fails', async () => {
  const dist = makeDist(join(root, 'dist-target-missing'), { bad: ['redirect-target-missing'] });
  const result = await gate(vercelDir, dist);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/old-services target: expected "a page or file in dist", got "404 at \/services\/"/);
  assert.match(result.stdout, /\/\?p=7 target: .*\[unverified live\]/);
});

test('a redirect source that is also a built page fails', async () => {
  const dist = makeDist(join(root, 'dist-source-page'), { bad: ['redirect-source-page'] });
  const result = await gate(vercelDir, dist);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/old-services collision: expected null, got "old-services\.html"/);
  assert.match(result.stdout, /^redirects: 14 checked, 1 failed$/m);
});

test('decision rows in redirects.csv are checked too', async () => {
  const dir = await site('site-decision', 'vercel', { rows: ['/promo,/contact/,301,decision,merged promo', '/gone,/missing/,301,decision,'] });
  const result = await gate(dir, good);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^redirects: 16 checked, 1 failed$/m);
  assert.match(result.stdout, /\/gone target: expected "a page or file in dist", got "404 at \/missing\/"/);
});

test('a changed target needs a redirect exception; a stale one fails', async () => {
  const dir = join(root, 'site-changed');
  mkdirSync(dir);
  const csvText = readFileSync(join(root, 'redirects.csv'), 'utf8').replace('/old-services,/services/', '/old-services,/services/roofing/');
  writeFileSync(join(dir, 'redirects.csv'), csvText);
  await exec(process.execPath, [COMPILER, '--csv', 'redirects.csv', '--host', 'vercel', '--out', 'vercel.json'], { cwd: dir });
  const failed = await gate(dir, good, ['--paths', '/old-services']);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\/old-services redirect: expected "\/services\/", got "301 \/services\/roofing\/"/);
  const base = { path: '/old-services', field: 'redirect', reason: 'roofing is the service people want', approvedBy: 'client', date: '2026-10-22' };
  writeFileSync(join(dir, 'exceptions.json'), JSON.stringify([{ ...base, from: '/services/', to: '/services/roofing/' }]));
  const passed = await gate(dir, good, ['--paths', '/old-services']);
  assert.equal(passed.code, 0, passed.stdout);
  writeFileSync(join(dir, 'exceptions.json'), JSON.stringify([{ ...base, from: '/elsewhere/', to: '/services/roofing/' }, { ...base, path: '/nowhere', from: '/a/', to: '/b/' }]));
  const stale = await gate(dir, good);
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /\/old-services exception: .*"no longer matches the baseline"/);
  assert.match(stale.stdout, /\/nowhere exception: .*"path not checked"/);
});

test('usage and missing inputs exit 2; --help exits 0', async () => {
  assert.equal((await gate(vercelDir, good, ['--bogus'])).code, 2);
  assert.equal((await gate(vercelDir, join(root, 'nope'))).code, 2);
  assert.equal((await gate(vercelDir, good, ['--host', 'netlify'])).code, 2);
  assert.equal((await gate(vercelDir, good, ['--csv', 'missing.csv'])).code, 2);
  const help = await runGate('redirects', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--host/);
});
