import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { DIST_ORIGIN, edit, makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';

let root;
let baseline;
let capture;
let good;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'sitemaps-gate-'));
  baseline = await buildFixtureBaseline(root);
  capture = join(root, 'capture');
  good = makeDist(join(root, 'dist-good'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const sitemaps = (dist, args = [], origin = ['--origin', DIST_ORIGIN]) =>
  runGate('sitemaps', ['--dist', dist, '--baseline', baseline, '--capture', capture, ...origin, ...args], { cwd: root });

// 12 indexable pages (13 at 200 less the noindex /private-page/) plus the /feed/ feed.
test('dist-good passes: the sitemap lists exactly the indexable routes and the feed matches', async () => {
  const result = await sitemaps(good);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^sitemaps: 13 checked, 0 failed$/m);
});

test('a sitemap URL on another origin fails', async () => {
  const result = await sitemaps(good, ['--paths', '/about/'], []);
  assert.equal(result.code, 1);
  assert.match(result.stdout, new RegExp(`/about/ sitemap: expected "[^"]+/about/", got "${DIST_ORIGIN}/about/"`));
});

test('a page left out of the sitemap fails; an extra one fails', async () => {
  const dist = makeDist(join(root, 'dist-sitemap'), { bad: ['sitemap-missing-page'] });
  edit(dist, 'sitemap-0.xml', '</urlset>', `<url><loc>${DIST_ORIGIN}/private-page/</loc></url></urlset>`);
  const result = await sitemaps(dist);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/about\/ sitemap: expected "https:\/\/www\.example\.com\/about\/", got null$/m);
  assert.match(result.stdout, /^ {2}\/private-page\/ sitemap: expected null, got "https:\/\/www\.example\.com\/private-page\/"$/m);
  assert.match(result.stdout, /^sitemaps: 13 checked, 2 failed$/m);
});

test('a single sitemap.xml is read when there is no sitemap index', async () => {
  const dist = makeDist(join(root, 'dist-single'));
  rmSync(join(dist, 'sitemap-index.xml'));
  renameSync(join(dist, 'sitemap-0.xml'), join(dist, 'sitemap.xml'));
  const result = await sitemaps(dist);
  assert.equal(result.code, 0, result.stdout);
  rmSync(join(dist, 'sitemap.xml'));
  const none = await sitemaps(dist);
  assert.equal(none.code, 1);
  assert.match(none.stdout, /\/ sitemap: expected "sitemap-index\.xml", got null/);
});

test("WordPress's sitemap_index.xml, kept at its live URL, is read as the sitemap index", async () => {
  const dist = makeDist(join(root, 'dist-wp-index'));
  renameSync(join(dist, 'sitemap-index.xml'), join(dist, 'sitemap_index.xml'));
  const result = await sitemaps(dist);
  assert.equal(result.code, 0, result.stdout);
});

test('a sitemap index pointing at a missing child sitemap fails', async () => {
  const dist = makeDist(join(root, 'dist-no-child'));
  rmSync(join(dist, 'sitemap-0.xml'));
  const result = await sitemaps(dist, ['--paths', '/about/']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/sitemap-0\.xml sitemap: expected "sitemap-0\.xml", got null/);
});

test('a missing feed fails', async () => {
  const dist = makeDist(join(root, 'dist-no-feed'), { bad: ['missing-feed'] });
  const result = await sitemaps(dist);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/feed\/ feed: expected "feed\/index\.xml", got null$/m);
});

test('a feed with fewer items than the captured feed fails', async () => {
  const dist = makeDist(join(root, 'dist-feed-item'), { bad: ['dropped-feed-item'] });
  const result = await sitemaps(dist);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/feed\/ items: expected 3, got 2$/m);
});

test('--paths limits the check', async () => {
  const dist = makeDist(join(root, 'dist-paths'), { bad: ['missing-feed'] });
  const result = await sitemaps(dist, ['--paths', '/services/*']);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /^sitemaps: 3 checked, 0 failed$/m);
});

test('usage and missing inputs exit 2; --help exits 0', async () => {
  assert.equal((await sitemaps(good, ['--bogus'])).code, 2);
  assert.equal((await sitemaps(good, ['--capture', join(root, 'nope')])).code, 2);
  assert.equal((await sitemaps(good, [], ['--origin', 'not a url'])).code, 2);
  assert.equal((await runGate('sitemaps', ['--dist', good, '--baseline', join(root, 'nope')], { cwd: root })).code, 2);
  const help = await runGate('sitemaps', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--capture/);
});
