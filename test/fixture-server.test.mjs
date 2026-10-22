import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './fixture/serve.mjs';

let fixture;
before(async () => {
  fixture = await startFixture();
});
after(() => fixture.close());

const get = (path, init = {}) => fetch(fixture.origin + path, { redirect: 'manual', ...init });

async function expectRedirect(path, status, toPath) {
  const res = await get(path);
  await res.arrayBuffer();
  assert.equal(res.status, status, `${path} status`);
  assert.equal(new URL(res.headers.get('location'), fixture.origin).pathname, toPath, `${path} location`);
}

test('the home page is 200 HTML', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const body = await res.text();
  assert.match(body, /<body class="home/);
  assert.ok(body.includes(`${fixture.origin}/hidden-page/`), 'origin placeholder is filled in');
  assert.ok(!body.includes('{{ORIGIN}}'));
});

test('/old-services is a two-hop 301 chain to /services/', async () => {
  await expectRedirect('/old-services', 301, '/old-services/');
  await expectRedirect('/old-services/', 301, '/services/');
  const res = await get('/services/');
  await res.arrayBuffer();
  assert.equal(res.status, 200);
});

test('an unslashed URL 301s to its slashed form', async () => {
  await expectRedirect('/about', 301, '/about/');
});

test('a ?p= shortlink 301s to its page', async () => {
  const res = await get('/?p=7');
  await res.arrayBuffer();
  assert.equal(res.status, 301);
  const location = new URL(res.headers.get('location'), fixture.origin);
  const page = await get(location.pathname);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<body class="[^"]*page/);
});

test('an unknown URL is 404 with the 404 page body', async () => {
  const res = await get('/missing/');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.match(await res.text(), /error404/);
});

test('the sitemap index lists 3 child sitemaps, each served as XML', async () => {
  const res = await get('/sitemap_index.xml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /xml/);
  const children = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(children.length, 3);
  const urls = [];
  for (const child of children) {
    const childRes = await get(new URL(child).pathname);
    assert.equal(childRes.status, 200, child);
    urls.push(...[...(await childRes.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname));
  }
  assert.ok(!urls.includes('/hidden-page/'), 'hidden page is not in any sitemap');
  const statuses = await Promise.all(urls.map(async (path) => {
    const r = await get(path);
    await r.arrayBuffer();
    return r.status;
  }));
  assert.equal(statuses.filter((s) => s === 404).length, 1, 'exactly one sitemap URL 404s');
});

test('robots.txt and the RSS feed are served', async () => {
  const robots = await get('/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Sitemap: .*\/sitemap_index\.xml/);
  const feed = await get('/feed/');
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /rss\+xml/);
  assert.match(await feed.text(), /<rss/);
});

test('wp-json pages are JSON with X-WP-TotalPages and paginate', async () => {
  const res = await get('/wp-json/wp/v2/pages?per_page=100');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('x-wp-totalpages'), '1');
  const pages = await res.json();
  assert.ok(pages.length >= 9);
  assert.equal(res.headers.get('x-wp-total'), String(pages.length));

  const first = await get('/wp-json/wp/v2/pages?per_page=2&page=1');
  assert.equal(first.headers.get('x-wp-totalpages'), String(Math.ceil(pages.length / 2)));
  assert.equal((await first.json()).length, 2);
  const beyond = await get('/wp-json/wp/v2/pages?per_page=100&page=2');
  assert.equal(beyond.status, 400);
  await beyond.arrayBuffer();

  for (const type of ['posts', 'media', 'categories', 'tags']) {
    const r = await get(`/wp-json/wp/v2/${type}`);
    assert.equal(r.status, 200, type);
    assert.ok(r.headers.get('x-wp-totalpages'), type);
    assert.ok(Array.isArray(await r.json()), type);
  }
});

test('media and fonts are served with the right content types', async () => {
  const cases = {
    '/wp-content/uploads/2026/01/hero.jpg': 'image/jpeg',
    '/wp-content/uploads/2026/01/hero-300x200.jpg': 'image/jpeg',
    '/wp-content/uploads/2026/01/hero-1024x683.jpg': 'image/jpeg',
    '/wp-content/uploads/2026/01/siding-sample.webp': 'image/webp',
    '/wp-content/uploads/2026/01/logo.svg': 'image/svg+xml',
    '/wp-content/uploads/2026/01/brochure.pdf': 'application/pdf',
    '/wp-content/themes/fixture/fonts/fixture-sans.woff2': 'font/woff2',
    '/wp-content/themes/fixture/fonts/fixture-serif.woff2': 'font/woff2',
    '/wp-content/themes/fixture/style.css': 'text/css',
  };
  for (const [path, type] of Object.entries(cases)) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), new RegExp(`^${type.replace('+', '\\+')}`), path);
    await res.arrayBuffer();
  }
});

test('path traversal outside the site is refused', async () => {
  const res = await get('/..%2F..%2Fpackage.json');
  assert.equal(res.status, 404);
  await res.arrayBuffer();
});

test('with blockAfter: 5 the sixth request is 429', async () => {
  const blocked = await startFixture({ blockAfter: 5 });
  try {
    for (let i = 1; i <= 5; i += 1) {
      const res = await fetch(`${blocked.origin}/`);
      await res.arrayBuffer();
      assert.equal(res.status, 200, `request ${i}`);
    }
    const sixth = await fetch(`${blocked.origin}/robots.txt`);
    await sixth.arrayBuffer();
    assert.equal(sixth.status, 429);
  } finally {
    await blocked.close();
  }
});

test('delayMs delays every response', async () => {
  const slow = await startFixture({ delayMs: 150 });
  try {
    const started = Date.now();
    const res = await fetch(`${slow.origin}/robots.txt`);
    await res.arrayBuffer();
    assert.ok(Date.now() - started >= 140);
  } finally {
    await slow.close();
  }
});
