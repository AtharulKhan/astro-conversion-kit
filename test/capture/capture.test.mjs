import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';

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
before(async () => {
  fixture = await startFixture();
  full = tempDir();
  fullRun = await capture([fixture.origin, '--out', full, '--delay', '0', '--seed', '/old-services']);
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
  assert.equal(short.to, '/services/');
  assert.equal(short.status, 301);
  assert.equal(short.source, 'shortlink');
  assert.deepEqual(short.hops, []);
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
  const blocking = await startFixture({ port: Number(port), blockAfter: 6 });
  const stopped = await capture([blocking.origin, '--out', out, '--delay', '0', '--seed', '/old-services']);
  await blocking.close();
  assert.equal(stopped.code, 3, stopped.stderr);
  assert.match(stopped.stderr, /--resume/);
  const state = readJson(out, 'state.json');
  assert.equal(state.phase, 'crawl');
  assert.ok(state.queue.length > 0);

  const open = await startFixture({ port: Number(port) });
  const resumed = await capture([open.origin, '--out', out, '--delay', '0', '--resume']);
  await open.close();
  assert.equal(resumed.code, 0, resumed.stderr);
  const paths = (dir) => readJson(dir, 'inventory.json').map((r) => r.path).sort();
  assert.deepEqual(paths(out), paths(full));
  assert.equal(readJson(out, 'inventory.json').length, 13);
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
