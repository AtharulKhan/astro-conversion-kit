import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';
import { startStub } from './helpers.mjs';
import { excludedBy, parseExclude } from '../../skills/capture-site/scripts/lib/exclude.mjs';
import { collectMedia } from '../../skills/capture-site/scripts/media.mjs';

const exec = promisify(execFile);
const script = (path) => fileURLToPath(new URL(`../../skills/${path}`, import.meta.url));
const CAPTURE = script('capture-site/scripts/capture.mjs');
const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));

async function run(path, args, env = process.env) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [path, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'exclude-test-'));
  dirs.push(dir);
  return dir;
};

let fixture;
let cap;
let base;
let captured;
let requests;
before(async () => {
  fixture = await startFixture();
  const root = tempDir();
  cap = join(root, 'capture');
  base = join(root, 'baseline');
  captured = await run(CAPTURE, [fixture.origin, '--out', cap, '--delay', '0', '--no-wayback', '--seed', '/old-services', '--exclude', '/services/']);
  requests = [...fixture.requests];
  for (const [name, args] of [
    ['capture-site/scripts/media.mjs', ['--capture', cap, '--delay', '0']],
    ['capture-site/scripts/templates.mjs', ['--capture', cap]],
    ['parity-gates/scripts/build-baseline.mjs', ['--capture', cap, '--out', base]],
  ]) {
    const result = await run(script(name), args);
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
  }
});
after(async () => {
  await fixture.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('parseExclude splits commas, keeps URL paths and refuses / and bare words', () => {
  assert.deepEqual(parseExclude(['/president/,/media-relations/', 'https://www.example.com/team/', '/president/']), ['/president/', '/media-relations/', '/team/']);
  assert.throws(() => parseExclude(['/']), /whole site/);
  assert.throws(() => parseExclude(['president']), /starting with \//);
  assert.equal(excludedBy(['/services/'], '/services/roofing/'), '/services/');
  assert.equal(excludedBy(['/services/'], '/services'), '/services/');
  assert.equal(excludedBy(['/services/'], '/services-old/'), null);
});

test('--exclude /services/: no page under it is requested or inventoried, and meta.json lists it', () => {
  assert.equal(captured.code, 0, captured.stderr);
  const asked = requests.map((u) => new URL(u, fixture.origin).pathname);
  assert.deepEqual(asked.filter((p) => p.startsWith('/services')), [], 'nothing under /services/ is requested');
  const inventory = readJson(cap, 'inventory.json');
  assert.deepEqual(inventory.filter((r) => r.path.startsWith('/services')), []);
  // 13 pages at 200 less the three services pages, plus the sitemap's 404.
  assert.equal(inventory.length, 11);
  assert.equal(inventory.filter((r) => r.status === 200).length, 10);
  assert.deepEqual(readJson(cap, 'meta.json').excluded, ['/services/']);
  assert.deepEqual(readJson(cap, 'state.json').options.exclude, ['/services/']);
});

test('a redirect into an excluded path is recorded and its target never requested', () => {
  const old = readJson(cap, 'redirects.json').find((r) => r.from === '/old-services');
  assert.deepEqual(old, { from: '/old-services', to: '/services/', status: 301, source: 'seed', hops: ['/old-services/'] });
});

test('links to excluded paths stay in the HTML and move to links.json excluded', () => {
  assert.match(readFileSync(join(cap, 'pages/home.html'), 'utf8'), /href="[^"]*\/services\/roofing\/"/);
  const links = readJson(cap, 'links.json');
  assert.deepEqual(Object.keys(links.internal).filter((p) => p.startsWith('/services')), []);
  assert.ok(links.excluded['/services/'].includes('/'), 'the home page links to /services/');
  assert.ok(links.excluded['/services/roofing/'].length > 0);
});

test('media lists no page under the excluded prefix, and media under a prefix is not listed', () => {
  const media = readJson(cap, 'media.json');
  assert.ok(media.length > 0);
  assert.deepEqual(media.flatMap((m) => m.referencedBy).filter((p) => p.startsWith('/services')), []);
  const none = collectMedia(cap, { exclude: ['/wp-content/uploads/'] });
  assert.deepEqual(none.filter((m) => m.path.startsWith('/wp-content/uploads/')), []);
  assert.ok(none.some((m) => m.path.startsWith('/wp-content/themes/')), 'other media is still listed');
});

test('the baseline carries the excluded prefixes in meta.json and has no route under them', () => {
  assert.deepEqual(readJson(base, 'meta.json').excluded, ['/services/']);
  assert.deepEqual(readJson(base, 'routes.json').filter((r) => r.path.startsWith('/services')), []);
});

test('assets.mjs --exclude leaves out an asset under the prefix without asking for it', async () => {
  const before = fixture.requests.length;
  const result = await run(script('capture-site/scripts/assets.mjs'), ['--capture', cap, '--delay', '0', '--exclude', '/wp-content/themes/fixture/fonts/']);
  assert.equal(result.code, 0, result.stderr);
  const asked = fixture.requests.slice(before);
  assert.deepEqual(asked.filter((u) => u.includes('/fonts/')), []);
  const fonts = readJson(cap, 'assets/index.json').filter((e) => e.kind === 'font');
  assert.equal(fonts.length, 2);
  for (const font of fonts) assert.deepEqual([font.file, font.status, font.note], [null, null, 'excluded (under /wp-content/themes/fixture/fonts/)']);
});

test('a sitemap index under an excluded prefix is listed skipped, and nothing under it is asked for', async () => {
  const home = (origin) => ({ body: `<html><head><title>Home</title></head><body><a href="${origin}/president/">President</a><a href="/news/">News</a></body></html>` });
  const page = { body: '<html><head><title>News</title></head><body>news</body></html>' };
  const stub = await startStub({
    '/': home,
    '/robots.txt': (origin) => ({ headers: { 'Content-Type': 'text/plain' }, body: `Sitemap: ${origin}/president/sitemap_index.xml\nSitemap: ${origin}/sitemap_index.xml\n` }),
    '/sitemap_index.xml': (origin) => ({ headers: { 'Content-Type': 'application/xml' }, body: `<sitemapindex><sitemap><loc>${origin}/page-sitemap.xml</loc></sitemap><sitemap><loc>${origin}/president/page-sitemap.xml</loc></sitemap></sitemapindex>` }),
    '/page-sitemap.xml': (origin) => ({ headers: { 'Content-Type': 'application/xml' }, body: `<urlset><url><loc>${origin}/news/</loc></url><url><loc>${origin}/president/bio/</loc></url></urlset>` }),
    '/news/': page,
  });
  try {
    const out = tempDir();
    const result = await run(CAPTURE, [stub.origin, '--out', out, '--delay', '0', '--no-wayback', '--exclude', '/president/']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(stub.requests.filter((u) => u.startsWith('/president')), []);
    const index = readJson(out, 'sitemaps/index.json');
    assert.deepEqual(index.filter((e) => e.skipped), [
      { url: `${stub.origin}/president/page-sitemap.xml`, skipped: 'excluded' },
      { url: `${stub.origin}/president/sitemap_index.xml`, skipped: 'excluded' },
    ]);
    const meta = readJson(out, 'meta.json');
    assert.deepEqual(meta.discoveryErrors, []);
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => r.path), ['/', '/news/']);
    assert.deepEqual(readJson(out, 'links.json').excluded, { '/president/': ['/'] });
  } finally {
    await stub.close();
  }
});

test('--resume keeps the excluded prefixes, and one added on --resume drops what is queued under it', async () => {
  const fresh = await startFixture();
  try {
    const out = tempDir();
    const first = await run(CAPTURE, [fresh.origin, '--out', out, '--delay', '0', '--no-wayback', '--no-rest', '--max', '2', '--exclude', '/services/']);
    assert.equal(first.code, 0, first.stderr);
    const queued = readJson(out, 'state.json').queue.map((q) => new URL(q.url).pathname);
    assert.ok(queued.some((p) => p.startsWith('/blog/')), `blog is still queued: ${queued}`);
    const again = await run(CAPTURE, [fresh.origin, '--out', out, '--delay', '0', '--no-wayback', '--resume', '--exclude', '/blog/']);
    assert.equal(again.code, 0, again.stderr);
    const asked = fresh.requests.map((u) => new URL(u, fresh.origin).pathname);
    assert.deepEqual(asked.filter((p) => p.startsWith('/services') || p.startsWith('/blog')), []);
    assert.deepEqual(readJson(out, 'meta.json').excluded, ['/services/', '/blog/']);
  } finally {
    await fresh.close();
  }
});

test('Wayback paths under an excluded prefix are not listed for a second pass', async () => {
  const server = createServer((req, res) => {
    const host = new URL(req.url, 'http://cdx').searchParams.get('url').replace(/\/\*$/, '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([['original'], [`http://${host}/old-team/`], [`http://${host}/services/old-gutters/`]]));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const stub = await startStub({ '/': { body: '<html><head><title>Home</title></head><body>home</body></html>' } });
  try {
    const out = tempDir();
    const env = { ...process.env, CAPTURE_WAYBACK_CDX: `http://127.0.0.1:${server.address().port}/cdx/search/cdx`, CAPTURE_WAYBACK_RETRY_MS: '0' };
    const result = await run(CAPTURE, [stub.origin, '--out', out, '--delay', '0', '--exclude', '/services/'], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(join(out, 'wayback-unverified.txt'), 'utf8'), '/old-team/\n');
  } finally {
    await stub.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test('--exclude needs a value and refuses /', async () => {
  const out = tempDir();
  const bare = await run(CAPTURE, ['http://127.0.0.1:9', '--out', out, '--exclude']);
  assert.equal(bare.code, 2);
  const all = await run(CAPTURE, ['http://127.0.0.1:9', '--out', out, '--exclude', '/']);
  assert.equal(all.code, 2);
  assert.match(all.stderr, /whole site/);
});
