import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { makeDist } from './fixtures/make-dist.mjs';

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../skills/parity-gates/scripts/verify-live.mjs', import.meta.url));

async function verifyLive(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [SCRIPT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

const TYPES = { '.html': 'text/html', '.xml': 'application/xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

// A static host for a built dist/, the way a deploy serves it: the baseline's redirects (or the
// given ones) answered in one hop, <path>/index.html or index.xml for directory paths, 404 for anything else.
// `noindex` adds X-Robots-Tag: noindex to every response, `blockAfter` answers 429 from then on.
// `headers` records each request's headers.
function serveDist(dist, { redirects, noindex = false, blockAfter = Infinity } = {}) {
  const root = resolve(dist);
  const headers = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    const url = new URL(req.url, 'http://host');
    const extra = noindex ? { 'X-Robots-Tag': 'noindex' } : {};
    if (headers.length > blockAfter) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      return res.end('Too Many Requests');
    }
    const rule = redirects.find((r) => r.from === `${url.pathname}${url.search}`) ?? redirects.find((r) => r.from === url.pathname);
    if (rule) {
      res.writeHead(rule.status, { Location: rule.to, ...extra });
      return res.end();
    }
    const target = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    const candidates = url.pathname.endsWith('/') ? [join(target, 'index.html'), join(target, 'index.xml')] : [target];
    let body;
    let file;
    for (const candidate of candidates) {
      try {
        if (candidate.startsWith(root + sep) && statSync(candidate).isFile()) [file, body] = [candidate, readFileSync(candidate)];
      } catch {
        // not built
      }
      if (body) break;
    }
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/html', ...extra });
      return res.end('<h1>Not found</h1>');
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length, ...extra });
    return res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () =>
      done({
        origin: `http://127.0.0.1:${server.address().port}`,
        headers,
        close: () => new Promise((closed) => {
          server.closeAllConnections();
          server.close(closed);
        }),
      }),
    );
  });
}

let root;
let baseline;
let good;
let baselineRedirects;
const servers = [];
async function serve(dist, options = {}) {
  const host = await serveDist(dist, { redirects: baselineRedirects, ...options });
  servers.push(host);
  return host;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'verify-live-'));
  baseline = await buildFixtureBaseline(root);
  baselineRedirects = JSON.parse(readFileSync(join(baseline, 'redirects.json'), 'utf8'));
  good = makeDist(join(root, 'dist-good'));
});
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  rmSync(root, { recursive: true, force: true });
});

const live = (base, args = []) => verifyLive(['--base', base, '--baseline', baseline, '--delay', '0', ...args]);

// 15 routes at 200 (13 pages, the feed, the brochure PDF), 14 redirects, the sitemap, 19 media.
test('a dist-good build served live passes every check', async () => {
  const host = await serve(good);
  const result = await live(host.origin);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^verify-live: 49 checked, 0 failed$/m);
  assert.match(result.stdout, /^ {2}ok route \/hidden-page\/$/m);
  assert.match(result.stdout, /^ {2}ok redirect \/old-services -> \/services\/$/m);
});

test('a route missing from the deploy fails, naming it', async () => {
  const host = await serve(makeDist(join(root, 'dist-missing'), { bad: ['missing-page'] }));
  const result = await live(host.origin);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}FAIL route \/hidden-page\/ status: expected 200, got 404$/m);
  assert.match(result.stdout, /^verify-live: 49 checked, 1 failed$/m);
});

test('--bypass is sent as x-vercel-protection-bypass on every request', async () => {
  const host = await serve(good);
  const result = await live(host.origin, ['--bypass', 'secret-value']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(host.headers.length, 49);
  assert.ok(host.headers.every((h) => h['x-vercel-protection-bypass'] === 'secret-value'));
});

test('X-Robots-Tag noindex must be present iff --expect-noindex', async () => {
  const open = await serve(good);
  const staging = await serve(good, { noindex: true });
  const expectMissing = await live(open.origin, ['--expect-noindex']);
  assert.equal(expectMissing.code, 1);
  assert.match(expectMissing.stdout, /^ {2}FAIL route \/about\/ x-robots-tag: expected "noindex", got null$/m);
  assert.equal((await live(staging.origin, ['--expect-noindex'])).code, 0);
  const leaked = await live(staging.origin);
  assert.equal(leaked.code, 1);
  assert.match(leaked.stdout, /^ {2}FAIL route \/ x-robots-tag: expected null, got "noindex"$/m);
});

test('a redirect that takes two hops fails; a failing unverified shortlink fails as unverified live', async () => {
  const redirects = [
    ...baselineRedirects.filter((r) => r.from !== '/old-services' && r.from !== '/?p=10'),
    { from: '/old-services', to: '/old-services/', status: 301 },
    { from: '/old-services/', to: '/services/', status: 301 },
  ];
  const host = await serve(good, { redirects });
  const text = await live(host.origin);
  assert.equal(text.code, 1);
  assert.match(text.stdout, /^ {2}FAIL redirect \/\?p=10 status \(unverified live\): expected 301, got 200$/m);
  const result = await live(host.origin, ['--json']);
  assert.equal(result.code, 1);
  const json = JSON.parse(result.stdout);
  assert.equal(json.failed, 2);
  assert.deepEqual(json.failures, [
    { check: 'redirect', path: '/?p=10', field: 'status', expected: 301, actual: 200, unverified: true },
    { check: 'redirect', path: '/old-services', field: 'location', expected: '/services/', actual: '/old-services/' },
  ]);
  assert.deepEqual(json.skipped, []);
});

test('a media file whose size changed fails', async () => {
  const dist = makeDist(join(root, 'dist-media'));
  writeFileSync(join(dist, 'wp-content/uploads/2026/01/logo.svg'), '<svg/>');
  const host = await serve(dist);
  const result = await live(host.origin);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}FAIL media \/wp-content\/uploads\/2026\/01\/logo\.svg bytes: expected 354, got 6$/m);
});

test('--media-manifest checks each sampled object at its url against the manifest bytes', async () => {
  const host = await serve(good);
  const manifest = join(root, 'media-manifest.json');
  writeFileSync(manifest, JSON.stringify([
    { path: '/wp-content/uploads/2026/01/hero.jpg', bytes: 13713, url: `${host.origin}/wp-content/uploads/2026/01/hero.jpg` },
    { path: '/wp-content/uploads/2026/01/team.jpg', bytes: 1, url: `${host.origin}/wp-content/uploads/2026/01/team.jpg` },
  ]));
  const result = await live(host.origin, ['--media-manifest', manifest, '--json']);
  assert.equal(result.code, 1);
  const json = JSON.parse(result.stdout);
  assert.equal(json.checked, 32);
  assert.deepEqual(json.failures, [{ check: 'media', path: '/wp-content/uploads/2026/01/team.jpg', field: 'bytes', expected: 1, actual: 13704 }]);
});

test('a missing sitemap fails', async () => {
  const dist = makeDist(join(root, 'dist-no-sitemap'));
  rmSync(join(dist, 'sitemap-index.xml'));
  const host = await serve(dist);
  const result = await live(host.origin);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}FAIL sitemap \/sitemap-index\.xml status: expected 200, got 404$/m);
});

test('--sample N checks N routes, always / and one route per template', async () => {
  const host = await serve(good);
  const routes = JSON.parse(readFileSync(join(baseline, 'routes.json'), 'utf8')).filter((r) => r.status === 200);
  const templates = new Set(routes.map((r) => r.template));
  const result = await live(host.origin, ['--sample', '8', '--json']);
  assert.equal(result.code, 0, result.stdout);
  const json = JSON.parse(result.stdout);
  const skipped = json.skipped.filter((s) => s.check === 'route').map((s) => s.path);
  assert.equal(skipped.length, routes.length - 8);
  const checked = routes.filter((r) => !skipped.includes(r.path));
  assert.ok(checked.some((r) => r.path === '/'));
  assert.deepEqual(new Set(checked.map((r) => r.template)), templates);
  assert.equal(json.checked, 8 + 14 + 1 + 19);
});

test('three consecutive 429s stop the run with exit 3', async () => {
  const host = await serve(good, { blockAfter: 2 });
  const result = await live(host.origin);
  assert.equal(result.code, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /verify-live: stopped after 3 consecutive blocked responses \(429\)/);
  assert.equal(host.headers.length, 5);
});

test('--help exits 0; a missing --base or baseline exits 2', async () => {
  const help = await verifyLive(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--expect-noindex/);
  assert.equal((await verifyLive(['--baseline', baseline])).code, 2);
  assert.equal((await verifyLive(['--base', 'http://127.0.0.1:1', '--baseline', join(root, 'nope')])).code, 2);
  assert.equal((await verifyLive(['--base', 'not a url', '--baseline', baseline])).code, 2);
});
