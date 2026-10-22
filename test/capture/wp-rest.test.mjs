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
