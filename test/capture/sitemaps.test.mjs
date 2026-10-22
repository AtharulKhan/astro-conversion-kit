import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { startFixture } from '../fixture/serve.mjs';
import { startStub } from './helpers.mjs';
import { expandSitemaps } from '../../skills/capture-site/scripts/lib/sitemaps.mjs';
import { fetchPaced } from '../../skills/capture-site/scripts/lib/http.mjs';

const fast = (url, options = {}) => fetchPaced(url, { ...options, delayMs: 0 });

let fixture;
before(async () => {
  fixture = await startFixture();
});
after(() => fixture.close());

test('the fixture sitemap index expands to every listed URL with its source', async () => {
  const entries = await expandSitemaps([`${fixture.origin}/sitemap_index.xml`], { fetch: fast });
  const paths = entries.map((e) => new URL(e.loc).pathname);
  // 11 indexable pages (13 minus /hidden-page/ and the noindex /private-page/) plus the 404 /deleted-post/.
  assert.equal(entries.length, 12);
  assert.ok(!paths.includes('/hidden-page/'));
  assert.ok(!paths.includes('/private-page/'));
  assert.ok(paths.includes('/deleted-post/'));
  for (const entry of entries) {
    assert.match(entry.source, /\/(page|post|category)-sitemap\.xml$/, entry.loc);
    assert.ok(entry.lastmod, entry.loc);
  }
  const deleted = entries.find((e) => e.loc.endsWith('/deleted-post/'));
  assert.equal(deleted.lastmod, '2025-11-02T09:00:00+00:00');
  assert.equal(new URL(deleted.source).pathname, '/post-sitemap.xml');
});

test('leaf sitemaps given directly and duplicates are deduplicated', async () => {
  const entries = await expandSitemaps(
    [`${fixture.origin}/sitemap_index.xml`, `${fixture.origin}/page-sitemap.xml`],
    { fetch: fast },
  );
  assert.equal(entries.length, 12);
  assert.equal(new Set(entries.map((e) => e.loc)).size, 12);
});

test('Drupal ?page=N pagination is followed until a page with no <loc>', async () => {
  const urlset = (origin, ...paths) => ({
    headers: { 'Content-Type': 'application/xml' },
    body: `<urlset>${paths.map((p) => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>`,
  });
  const stub = await startStub({
    '/sitemap.xml': (o) => urlset(o, '/', '/about'),
    '/sitemap.xml?page=1': (o) => urlset(o, '/', '/about'),
    '/sitemap.xml?page=2': (o) => urlset(o, '/node/3', '/news'),
    '/sitemap.xml?page=3': () => ({ headers: { 'Content-Type': 'application/xml' }, body: '<urlset></urlset>' }),
  });
  try {
    const entries = await expandSitemaps([`${stub.origin}/sitemap.xml`], { fetch: fast });
    assert.deepEqual(entries.map((e) => new URL(e.loc).pathname), ['/', '/about', '/node/3', '/news']);
    assert.equal(entries[2].source, `${stub.origin}/sitemap.xml?page=2`);
    assert.ok(!stub.requests.includes('/sitemap.xml?page=4'), 'stops at the empty page');
  } finally {
    await stub.close();
  }
});

test('Drupal pagination stops at the first non-200 page', async () => {
  const stub = await startStub({
    '/sitemap.xml': (o) => ({ body: `<urlset><url><loc>${o}/a</loc></url></urlset>` }),
    '/sitemap.xml?page=1': (o) => ({ body: `<urlset><url><loc>${o}/b</loc></url></urlset>` }),
  });
  try {
    const entries = await expandSitemaps([`${stub.origin}/sitemap.xml`], { fetch: fast });
    assert.deepEqual(entries.map((e) => new URL(e.loc).pathname), ['/a', '/b']);
    assert.ok(stub.requests.includes('/sitemap.xml?page=2'));
    assert.ok(!stub.requests.includes('/sitemap.xml?page=3'));
  } finally {
    await stub.close();
  }
});

test('a server that ignores ?page= does not loop forever', async () => {
  const stub = await startStub({});
  const same = (url) => ({ status: 200, headers: {}, body: `<urlset><url><loc>${stub.origin}/a</loc></url></urlset>`, finalUrl: url });
  try {
    const seen = [];
    const entries = await expandSitemaps([`${stub.origin}/sitemap.xml`], {
      fetch: async (url) => {
        seen.push(url);
        return same(url);
      },
    });
    assert.equal(entries.length, 1);
    assert.ok(seen.length <= 3, `fetched ${seen.length} times`);
  } finally {
    await stub.close();
  }
});

test('a gzipped sitemap is decompressed before parsing', async () => {
  const stub = await startStub({
    '/sitemap_index.xml': (o) => ({ body: `<sitemapindex><sitemap><loc>${o}/pages.xml.gz</loc></sitemap></sitemapindex>` }),
    '/pages.xml.gz': (o) => ({
      headers: { 'Content-Type': 'application/x-gzip' },
      body: gzipSync(`<urlset><url><loc>${o}/a/</loc></url><url><loc>${o}/b/</loc></url></urlset>`),
    }),
  });
  try {
    const entries = await expandSitemaps([`${stub.origin}/sitemap_index.xml`], { fetch: fast });
    assert.deepEqual(entries.map((e) => new URL(e.loc).pathname), ['/a/', '/b/']);
    assert.equal(entries[0].source, `${stub.origin}/pages.xml.gz`);
  } finally {
    await stub.close();
  }
});

test('a Drupal sitemap index of ?page= children is walked as an index', async () => {
  const stub = await startStub({
    '/sitemap.xml': (o) => ({
      body: `<sitemapindex><sitemap><loc>${o}/sitemap.xml?page=1</loc></sitemap>`
        + `<sitemap><loc>${o}/sitemap.xml?page=2</loc></sitemap></sitemapindex>`,
    }),
    '/sitemap.xml?page=1': (o) => ({ body: `<urlset><url><loc>${o}/a</loc><lastmod>2026-01-01</lastmod></url></urlset>` }),
    '/sitemap.xml?page=2': (o) => ({ body: `<urlset><url><loc>${o}/b</loc></url></urlset>` }),
  });
  try {
    const entries = await expandSitemaps([`${stub.origin}/sitemap.xml`], { fetch: fast });
    assert.deepEqual(entries.map((e) => [new URL(e.loc).pathname, e.lastmod]), [['/a', '2026-01-01'], ['/b', null]]);
    assert.ok(!stub.requests.includes('/sitemap.xml?page=3'), 'index children are not paginated');
  } finally {
    await stub.close();
  }
});
