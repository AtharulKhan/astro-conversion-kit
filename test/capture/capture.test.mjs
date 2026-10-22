import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';
import { startStub } from './helpers.mjs';

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../skills/capture-site/scripts/capture.mjs', import.meta.url));
const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-test-'));
  dirs.push(dir);
  return dir;
};
const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));

async function capture(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [SCRIPT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

let fixture;
let full;
let fullRun;
let fullRequests;
before(async () => {
  fixture = await startFixture();
  full = tempDir();
  fullRun = await capture([fixture.origin, '--out', full, '--delay', '0', '--seed', '/old-services']);
  fullRequests = [...fixture.requests];
});
after(async () => {
  await fixture.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('a full capture inventories 12 pages and the sitemap 404', () => {
  assert.equal(fullRun.code, 0, fullRun.stderr);
  const inventory = readJson(full, 'inventory.json');
  assert.equal(inventory.length, 13);
  assert.equal(inventory.filter((r) => r.status === 200).length, 12);
  const deleted = inventory.find((r) => r.path === '/deleted-post/');
  assert.equal(deleted.status, 404);
  assert.deepEqual(deleted.foundBy, ['sitemap']);
  assert.ok(!inventory.some((r) => r.path === '/private-page/'), 'only REST knows the noindex page');
  assert.ok(!inventory.some((r) => r.path === '/feed/'), 'feeds are not pages');

  const hidden = inventory.find((r) => r.path === '/hidden-page/');
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.foundBy, ['crawl']);
  const home = inventory.find((r) => r.path === '/');
  assert.ok(home.foundBy.includes('sitemap') && home.foundBy.includes('crawl'));
  assert.equal(home.snapshot, 'pages/home.html');
  assert.equal(home.finalUrl, `${fixture.origin}/`);
  assert.ok(home.text.length > 0);
});

test('redirect chains collapse to their final target and shortlinks are recorded', () => {
  const redirects = readJson(full, 'redirects.json');
  const old = redirects.find((r) => r.from === '/old-services');
  assert.deepEqual(old, { from: '/old-services', to: '/services/', status: 301, source: 'seed', hops: ['/old-services/'] });
  const short = redirects.find((r) => r.from === '/?p=7');
  assert.deepEqual(short, { from: '/?p=7', to: '/services/', status: 301, source: 'shortlink', verified: false, hops: [] });
  assert.ok(!fullRequests.some((url) => url.includes('?p=')), 'shortlinks are not requested by default');
  const services = readJson(full, 'inventory.json').find((r) => r.path === '/services/');
  assert.equal(services.shortlink, '/?p=7');
  const meta = readJson(full, 'meta.json');
  assert.equal(meta.canonicalOrigin, fixture.origin);
  assert.ok(meta.finishedAt);
});

test('--verify-shortlinks requests each shortlink and records where it goes', async () => {
  const out = tempDir();
  const before = fixture.requests.length;
  const run = await capture([fixture.origin, '--out', out, '--delay', '0', '--verify-shortlinks']);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(fixture.requests.slice(before).includes('/?p=7'));
  const redirects = readJson(out, 'redirects.json');
  const short = redirects.find((r) => r.from === '/?p=7');
  assert.deepEqual(short, { from: '/?p=7', to: '/services/', status: 301, source: 'shortlink', verified: true, hops: [] });
  assert.ok(redirects.filter((r) => r.source === 'shortlink').every((r) => r.verified));
  assert.equal(readJson(out, 'inventory.json').length, 13);
});

test('a page that is always 403 is recorded with its status, not treated as a block', async () => {
  const stub = await startStub({
    '/': { body: '<html><body><a href="/forbidden/">f</a></body></html>' },
    '/forbidden/': { status: 403, body: '<html><body>no</body></html>' },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    const inventory = readJson(out, 'inventory.json');
    assert.deepEqual(inventory.map((r) => `${r.path}:${r.status}`), ['/:200', '/forbidden/:403']);
    assert.equal(stub.requests.filter((u) => u === '/forbidden/').length, 3);
  } finally {
    await stub.close();
  }
});

test('a URL that keeps answering 429 stops the run with exit 3 and stays queued', async () => {
  const stub = await startStub({
    '/': { body: '<html><body><a href="/a/">a</a> <a href="/slow/">s</a></body></html>' },
    '/a/': { body: '<html><body>a</body></html>' },
    '/slow/': { status: 429, body: 'slow down' },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 3, run.stderr);
    const state = readJson(out, 'state.json');
    assert.equal(state.phase, 'crawl');
    assert.deepEqual(state.queue.map((q) => new URL(q.url).pathname), ['/slow/']);
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => r.path), ['/', '/a/']);
    assert.equal(stub.requests.filter((u) => u === '/slow/').length, 3);
  } finally {
    await stub.close();
  }
});

test('robots.txt and sitemaps that always answer 403 are noted, not fatal', async () => {
  const stub = await startStub({
    '/': { body: '<html><body>home</body></html>' },
    '/robots.txt': { status: 403 },
    '/sitemap_index.xml': { status: 403 },
    '/sitemap.xml': { status: 403 },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => r.path), ['/']);
    const meta = readJson(out, 'meta.json');
    assert.deepEqual(
      meta.discoveryErrors.map((e) => `${new URL(e.url).pathname}:${e.status}`),
      ['/robots.txt:403', '/sitemap_index.xml:403', '/sitemap.xml:403'],
    );
    assert.equal(readJson(out, 'state.json').phase, 'done');
  } finally {
    await stub.close();
  }
});

test('a blocked --verify-shortlinks pass resumes without the flag', async () => {
  const probe = await startFixture();
  const port = Number(new URL(probe.origin).port);
  const plainOut = tempDir();
  assert.equal((await capture([probe.origin, '--out', plainOut, '--delay', '0'])).code, 0);
  const crawlRequests = probe.requests.length;
  await probe.close();

  const out = tempDir();
  const blocking = await startFixture({ port, blockAfter: crawlRequests + 1 });
  const stopped = await capture([blocking.origin, '--out', out, '--delay', '0', '--verify-shortlinks']);
  await blocking.close();
  assert.equal(stopped.code, 3, stopped.stderr);
  const state = readJson(out, 'state.json');
  assert.equal(state.options.verifyShortlinks, true);
  assert.ok(state.verifyQueue.length > 0);
  assert.equal(readJson(out, 'meta.json').finishedAt, null);

  const open = await startFixture({ port });
  const resumed = await capture([open.origin, '--out', out, '--delay', '0', '--resume']);
  await open.close();
  assert.equal(resumed.code, 0, resumed.stderr);
  const shortlinks = readJson(out, 'redirects.json').filter((r) => r.source === 'shortlink');
  assert.equal(shortlinks.length, 11);
  assert.ok(shortlinks.every((r) => r.verified && r.status === 301), JSON.stringify(shortlinks));
  assert.deepEqual(readJson(out, 'state.json').verifyQueue, []);
});

test('only HTML and hreflang alternates are followed; feeds go to feeds/, wp-json is never requested', async () => {
  const head = `<link rel="alternate" type="application/json" href="/wp-json/wp/v2/pages/2">
    <link rel="alternate" type="application/json+oembed" href="/wp-json/oembed/1.0/embed?url=x">
    <link rel="alternate" type="text/xml+oembed" href="/oembed.xml?url=x">
    <link rel="alternate" type="application/rss+xml" href="/news-feed/">
    <link rel="alternate" hreflang="fr" href="/fr/">`;
  const stub = await startStub({
    '/': { body: `<html><head>${head}</head><body><a href="/wp-json/">api</a></body></html>` },
    '/fr/': { body: '<html><body>bonjour</body></html>' },
    '/news-feed/': { headers: { 'Content-Type': 'application/rss+xml' }, body: '<rss version="2.0"></rss>' },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(!stub.requests.some((u) => u.startsWith('/wp-json') || u.includes('oembed')), stub.requests.join(' '));
    assert.ok(stub.requests.includes('/fr/'));
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => r.path), ['/', '/fr/']);
    assert.deepEqual(readJson(out, 'feeds/index.json').map((f) => f.path), ['/news-feed/']);
  } finally {
    await stub.close();
  }
});

test('an unreachable site exits 3 so it can be resumed', async () => {
  const stub = await startStub({});
  await stub.close();
  const out = tempDir();
  const run = await capture([stub.origin, '--out', out, '--delay', '0']);
  assert.equal(run.code, 3, run.stderr);
  assert.equal(readJson(out, 'state.json').phase, 'discover');
});

test('snapshots, text, robots, sitemaps, feeds, links and scripts are written', () => {
  assert.ok(existsSync(join(full, 'pages/home.html')));
  assert.match(readFileSync(join(full, 'text/home.txt'), 'utf8'), /Roofs and siding built to last/);
  assert.ok(existsSync(join(full, 'pages/deleted-post.html')));
  assert.match(readFileSync(join(full, 'robots.txt'), 'utf8'), /Sitemap:/);
  for (const name of ['sitemap_index.xml', 'page-sitemap.xml', 'post-sitemap.xml', 'category-sitemap.xml']) {
    assert.ok(existsSync(join(full, 'sitemaps', name)), name);
  }
  assert.match(readFileSync(join(full, 'feeds/feed.xml'), 'utf8'), /<rss/);
  assert.deepEqual(readJson(full, 'feeds/index.json').map((f) => f.path), ['/feed/']);

  const links = readJson(full, 'links.json');
  assert.deepEqual(links.internal['/hidden-page/'], ['/']);
  assert.ok(links.internal['/wp-content/uploads/2026/01/brochure.pdf'].length > 0);

  const scripts = readJson(full, 'scripts.json');
  assert.equal(scripts.ga4.id, 'G-FIXTURE1');
  assert.equal(scripts.gtm.id, 'GTM-FIXTURE');
  assert.ok(scripts.ga4.pages.includes('/'));
  assert.ok(!('other' in scripts));

  const state = readJson(full, 'state.json');
  assert.equal(state.phase, 'done');
  assert.deepEqual(state.queue, []);
});

test('a blocked crawl exits 3 with a resumable state, and --resume finishes it', async () => {
  const probe = await startFixture();
  const { port } = new URL(probe.origin);
  await probe.close();

  const out = tempDir();
  const blocking = await startFixture({ port: Number(port), blockAfter: 12 });
  const stopped = await capture([blocking.origin, '--out', out, '--delay', '0', '--seed', '/old-services']);
  await blocking.close();
  assert.equal(stopped.code, 3, stopped.stderr);
  assert.match(stopped.stderr, /--resume/);
  const state = readJson(out, 'state.json');
  assert.equal(state.phase, 'crawl');
  assert.ok(state.queue.length > 0);
  assert.ok(state.records.length > 0, 'some pages were captured before the block');
  assert.ok(state.records.every((r) => !('text' in r) && !('jsonLd' in r)), 'text and JSON-LD stay on disk');

  const open = await startFixture({ port: Number(port) });
  const resumed = await capture([open.origin, '--out', out, '--delay', '0', '--resume']);
  await open.close();
  assert.equal(resumed.code, 0, resumed.stderr);
  const paths = (dir) => readJson(dir, 'inventory.json').map((r) => r.path).sort();
  assert.deepEqual(paths(out), paths(full));
  assert.equal(readJson(out, 'inventory.json').length, 13);
  const froms = readJson(out, 'redirects.json').map((r) => r.from);
  assert.equal(new Set(froms).size, froms.length, 'no duplicate redirects');
  assert.deepEqual(froms, readJson(full, 'redirects.json').map((r) => r.from));
  const home = readJson(out, 'inventory.json').find((r) => r.path === '/');
  assert.match(home.text, /Roofs and siding/, 'text of a page captured before the block is read back');
  assert.ok(readJson(out, 'redirects.json').some((r) => r.from === '/old-services'));
});

test('--max 3 fetches exactly 3 pages', async () => {
  const out = tempDir();
  const run = await capture([fixture.origin, '--out', out, '--delay', '0', '--max', '3']);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(readJson(out, 'inventory.json').length, 3);
});

test('usage errors exit 2 and --help prints usage', async () => {
  const help = await capture(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: node capture\.mjs <origin> --out <dir>/);
  assert.equal((await capture([fixture.origin])).code, 2, 'missing --out');
  assert.equal((await capture(['not-a-url', '--out', tempDir()])).code, 2);
  assert.equal((await capture([fixture.origin, '--out', tempDir(), '--resume'])).code, 2, 'nothing to resume');
});
