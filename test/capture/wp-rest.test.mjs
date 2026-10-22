import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixture/serve.mjs';
import { dumpWpRest } from '../../skills/capture-site/scripts/lib/wp-rest.mjs';
import { fetchPaced } from '../../skills/capture-site/scripts/lib/http.mjs';

const fast = (url, options = {}) => fetchPaced(url, { ...options, delayMs: 0 });
const UPLOADS = '/wp-content/uploads/2026/01/';
const IMAGES = ['hero.jpg', 'team.jpg', 'roof-detail.jpg', 'siding-sample.webp', 'storm-clouds.webp'];

let fixture;
let out;
before(async () => {
  fixture = await startFixture();
  out = mkdtempSync(join(tmpdir(), 'wp-rest-test-'));
});
after(async () => {
  await fixture.close();
  rmSync(out, { recursive: true, force: true });
});

test('dumpWpRest saves every type and returns page paths, post paths and every media size', async () => {
  const before = fixture.requests.length;
  const result = await dumpWpRest(fixture.origin, out, { fetch: fast });
  assert.deepEqual(result.pagePaths, [
    '/', '/about/', '/contact/', '/services/', '/services/roofing/', '/services/siding/', '/blog/',
    '/hidden-page/', '/private-page/',
  ]);
  assert.deepEqual(result.postPaths, ['/spring-roof-checklist/', '/choosing-siding-colors/', '/storm-season-prep/']);

  // 5 image originals x 3 sizes (original, -300x200, -1024x683) = 15, plus the PDF attachment,
  // which has a source_url but no registered sizes: 16.
  const expected = IMAGES.flatMap((name) => {
    const [stem, ext] = name.split('.');
    return [name, `${stem}-300x200.${ext}`, `${stem}-1024x683.${ext}`];
  });
  const paths = result.mediaUrls.map((u) => new URL(u).pathname);
  assert.equal(paths.filter((p) => !p.endsWith('.pdf')).length, 15);
  assert.deepEqual([...paths].sort(), [...expected, 'brochure.pdf'].map((f) => UPLOADS + f).sort());
  assert.equal(result.mediaUrls.length, 16);

  for (const type of ['pages', 'posts', 'media', 'categories', 'tags']) {
    const saved = JSON.parse(readFileSync(join(out, 'wp-rest', `${type}.json`), 'utf8'));
    assert.ok(Array.isArray(saved) && saved.length > 0, type);
  }
  assert.equal(JSON.parse(readFileSync(join(out, 'wp-rest/pages.json'), 'utf8')).length, 9);
  assert.ok(!existsSync(join(out, 'wp-rest/users.json')), 'users is optional: the fixture does not serve it');
  assert.deepEqual(result.errors, [], 'a missing users endpoint is not an error');
  const requested = fixture.requests.slice(before);
  assert.ok(requested.every((u) => u.startsWith('/wp-json/wp/v2/') && u.includes('per_page=100')), requested.join(' '));
});

// A stub REST API without X-WP-TotalPages: `counts` gives each type's item total; `afterLast`
// is what a page past the end answers (WordPress answers 400).
function headerless(counts, afterLast = 400) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const { pathname, searchParams } = new URL(url);
    const type = pathname.split('/').filter(Boolean).pop();
    const page = Number(searchParams.get('page'));
    const perPage = Number(searchParams.get('per_page'));
    const total = counts[type] ?? 0;
    const start = (page - 1) * perPage;
    if (start >= total && page > 1) {
      return afterLast === 'empty' ? { status: 200, headers: {}, body: '[]' } : { status: afterLast, headers: {}, body: '{}' };
    }
    const items = Array.from({ length: Math.max(0, Math.min(perPage, total - start)) }, (_, i) => ({
      link: `https://example.com/${type}-${start + i}/`,
    }));
    return { status: 200, headers: {}, body: JSON.stringify(items) };
  };
  return { fetch, calls };
}

test('without X-WP-TotalPages, paging goes on while pages are full and stops on a 400 or an empty page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-rest-headerless-'));
  try {
    const short = headerless({ pages: 237, posts: 200 });
    const result = await dumpWpRest('https://example.com', dir, { fetch: short.fetch });
    assert.equal(result.pagePaths.length, 237);
    assert.equal(result.postPaths.length, 200);
    assert.equal(short.calls.filter((u) => u.includes('/pages?')).length, 3, '100 + 100 + 37: a short page is the last');
    assert.equal(short.calls.filter((u) => u.includes('/posts?')).length, 3, '100 + 100, then the 400 past the end');
    assert.deepEqual(result.errors, [], 'a 400 past the last page is the end, not an error');
    assert.equal(JSON.parse(readFileSync(join(dir, 'wp-rest/posts.json'), 'utf8')).length, 200);

    const empty = headerless({ posts: 100 }, 'empty');
    const again = await dumpWpRest('https://example.com', dir, { fetch: empty.fetch });
    assert.equal(again.postPaths.length, 100);
    assert.equal(empty.calls.filter((u) => u.includes('/posts?')).length, 2, 'an empty page ends it');
    assert.deepEqual(again.errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the page cap stops a list and is recorded as an error, with or without the header', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-rest-cap-'));
  try {
    const big = headerless({ pages: 1000 });
    const result = await dumpWpRest('https://example.com', dir, { fetch: big.fetch, maxPages: 3 });
    assert.equal(result.pagePaths.length, 300);
    assert.equal(big.calls.filter((u) => u.includes('/pages?')).length, 3);
    assert.deepEqual(result.errors, [
      { url: 'https://example.com/wp-json/wp/v2/pages?per_page=100&page=4', status: null, error: 'stopped at the 3-page cap' },
    ]);

    const declared = async (url) => ({
      status: 200,
      headers: { 'x-wp-totalpages': url.includes('/pages?') ? '9' : '1' },
      body: JSON.stringify(url.includes('/pages?') ? [{ link: `https://example.com/${url.length}-${Math.random()}/` }] : []),
    });
    const capped = await dumpWpRest('https://example.com', dir, { fetch: declared, maxPages: 2 });
    assert.equal(capped.pagePaths.length, 2);
    assert.deepEqual(capped.errors.map((e) => e.error), ['stopped at the 2-page cap']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dumpWpRest follows X-WP-TotalPages and reports a type that fails', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const { pathname, searchParams } = new URL(url);
    const type = pathname.split('/').filter(Boolean).pop();
    const page = Number(searchParams.get('page'));
    if (type === 'posts') return { status: 500, headers: {}, body: 'oops' };
    if (type !== 'pages') return { status: 200, headers: { 'x-wp-totalpages': '1' }, body: '[]' };
    const item = { link: `https://www.example.com/p${page}/` };
    return { status: 200, headers: { 'x-wp-totalpages': '3' }, body: JSON.stringify([item]) };
  };
  const dir = mkdtempSync(join(tmpdir(), 'wp-rest-pages-'));
  try {
    const result = await dumpWpRest('https://example.com', dir, { fetch });
    assert.deepEqual(result.pagePaths, ['/p1/', '/p2/', '/p3/'], 'www and bare host are the same site');
    assert.equal(calls.filter((u) => u.includes('/pages')).length, 3);
    assert.deepEqual(result.errors, [{ url: 'https://example.com/wp-json/wp/v2/posts?per_page=100&page=1', status: 500 }]);
    assert.ok(!existsSync(join(dir, 'wp-rest/posts.json')));
    assert.equal(JSON.parse(readFileSync(join(dir, 'wp-rest/pages.json'), 'utf8')).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
