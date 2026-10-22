import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';
import { startStub } from './helpers.mjs';
import { fingerprint } from '../../skills/capture-site/scripts/fingerprint.mjs';
import { fetchPaced, http, resetBlocked } from '../../skills/capture-site/scripts/lib/http.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../skills/capture-site/scripts/fingerprint.mjs', import.meta.url));
const fast = (url, options = {}) => fetchPaced(url, { ...options, delayMs: 0 });

let fixture;
before(async () => {
  fixture = await startFixture();
});
after(() => fixture.close());

test('the fixture fingerprints as WordPress with REST and 3 sitemaps', async () => {
  const calls = [];
  const counting = (url, options) => {
    calls.push(url);
    return fast(url, options);
  };
  const result = await fingerprint(fixture.origin, { fetch: counting });
  assert.equal(result.platform, 'wordpress');
  assert.equal(result.platformVersion, '6.6.2');
  assert.equal(result.generator, 'WordPress 6.6.2');
  assert.equal(result.theme, 'fixture');
  assert.equal(result.hasRest, true);
  assert.equal(result.hasSitemap, true);
  assert.deepEqual(
    result.sitemapUrls.map((u) => new URL(u).pathname),
    ['/page-sitemap.xml', '/post-sitemap.xml', '/category-sitemap.xml'],
  );
  assert.match(result.robots, /Sitemap: .*\/sitemap_index\.xml/);
  assert.ok(Array.isArray(result.plugins));
  assert.ok(calls.length <= 4, `used ${calls.length} requests`);
});

test('a page whose generator is Webflow fingerprints as webflow', async () => {
  const stub = await startStub({
    '/': { body: '<html><head><meta name="generator" content="Webflow"></head><body></body></html>' },
  });
  try {
    const result = await fingerprint(stub.origin, { fetch: fast });
    assert.equal(result.platform, 'webflow');
    assert.equal(result.generator, 'Webflow');
    assert.equal(result.hasRest, false);
    assert.equal(result.hasSitemap, false);
    assert.deepEqual(result.sitemapUrls, []);
    assert.equal(result.robots, '');
    assert.ok(stub.requests.length <= 4);
  } finally {
    await stub.close();
  }
});

test('a Drupal 10 site is drupal with version, theme and /sitemap.xml', async () => {
  const stub = await startStub({
    '/': {
      headers: { 'X-Generator': 'Drupal 10 (https://www.drupal.org)', Server: 'nginx' },
      body: '<html><head><meta name="Generator" content="Drupal 10 (https://www.drupal.org)">'
        + '<link rel="stylesheet" href="/themes/custom/acme/css/base.css">'
        + '<script src="/modules/contrib/webform/js/webform.js"></script></head>'
        + '<body><img src="/sites/default/files/hero.jpg"></body></html>',
    },
    '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'User-agent: *\nDisallow: /admin/\n' },
    '/sitemap.xml': (origin) => ({
      headers: { 'Content-Type': 'application/xml' },
      body: `<urlset><url><loc>${origin}/</loc></url></urlset>`,
    }),
  });
  try {
    const result = await fingerprint(stub.origin, { fetch: fast });
    assert.equal(result.platform, 'drupal');
    assert.equal(result.platformVersion, '10');
    assert.equal(result.theme, 'acme');
    assert.deepEqual(result.plugins, ['webform']);
    assert.equal(result.server, 'nginx');
    assert.deepEqual(result.sitemapUrls, [`${stub.origin}/sitemap.xml`]);
    assert.ok(!stub.requests.includes('/sitemap_index.xml'), 'Drupal goes straight to /sitemap.xml');
    assert.ok(stub.requests.length <= 4);
  } finally {
    await stub.close();
  }
});

test('a Drupal 7 site is recognised by /sites/default/files/ alone', async () => {
  const stub = await startStub({
    '/': { body: '<html><body><img src="/sites/default/files/logo.png"></body></html>' },
  });
  try {
    const result = await fingerprint(stub.origin, { fetch: fast });
    assert.equal(result.platform, 'drupal');
    assert.equal(result.platformVersion, null);
  } finally {
    await stub.close();
  }
});

test('a Drupal 7 generator string gives version 7', async () => {
  const stub = await startStub({
    '/': { body: '<html><head><meta name="Generator" content="Drupal 7 (http://drupal.org)"></head></html>' },
  });
  try {
    const result = await fingerprint(stub.origin, { fetch: fast });
    assert.equal(result.platform, 'drupal');
    assert.equal(result.platformVersion, '7');
  } finally {
    await stub.close();
  }
});

test('other platforms and plain HTML', async () => {
  const cases = [
    ['<script src="https://cdn.shopify.com/s/x.js"></script>', 'shopify'],
    ['<link href="https://static1.squarespace.com/static/x.css"> Squarespace', 'squarespace'],
    ['<script src="https://static.parastorage.com/x.js"></script><!-- wix.com -->', 'wix'],
    ['<meta name="generator" content="Joomla! - Open Source Content Management">', 'joomla'],
    ['<p>hello</p>', 'static'],
  ];
  for (const [html, platform] of cases) {
    const stub = await startStub({ '/': { body: `<html><head>${html}</head></html>` } });
    try {
      assert.equal((await fingerprint(stub.origin, { fetch: fast })).platform, platform, html);
    } finally {
      await stub.close();
    }
  }
});

test('an unreachable home page is unknown', async () => {
  const stub = await startStub({});
  try {
    const result = await fingerprint(stub.origin, { fetch: fast });
    assert.equal(result.platform, 'unknown');
  } finally {
    await stub.close();
  }
});

test('fetchPaced counts consecutive blocks and resets on success', async () => {
  const stub = await startStub({ '/ok': { body: 'ok' }, '/no': { status: 429, body: 'slow down' } });
  try {
    resetBlocked();
    await fast(`${stub.origin}/no`);
    await fast(`${stub.origin}/no`);
    assert.equal(http.blocked, 2);
    const ok = await fast(`${stub.origin}/ok`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'ok');
    assert.equal(ok.finalUrl, `${stub.origin}/ok`);
    assert.equal(http.blocked, 0);
    await fast(`${stub.origin}/no`);
    http.resetBlocked();
    assert.equal(http.blocked, 0);
  } finally {
    await stub.close();
  }
});

test('fetchPaced keeps redirects manual by default and counts network errors', async () => {
  const stub = await startStub({ '/old': { status: 301, headers: { Location: '/new' } } });
  try {
    resetBlocked();
    const res = await fast(`${stub.origin}/old`);
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, '/new');
  } finally {
    await stub.close();
  }
  const dead = await fast(`${stub.origin}/gone`);
  assert.equal(dead.status, 0);
  assert.equal(http.blocked, 1);
  resetBlocked();
});

test('fetchPaced waits delayMs between requests to the same host', async () => {
  const stub = await startStub({ '/': { body: 'x' } });
  try {
    await fetchPaced(`${stub.origin}/`, { delayMs: 0 });
    const started = Date.now();
    await fetchPaced(`${stub.origin}/`, { delayMs: 150 });
    assert.ok(Date.now() - started >= 140);
  } finally {
    await stub.close();
  }
});

test('the CLI prints JSON with --json', async () => {
  const { stdout } = await run(process.execPath, [SCRIPT, fixture.origin, '--json', '--delay', '0']);
  const result = JSON.parse(stdout);
  assert.equal(result.platform, 'wordpress');
  assert.equal(result.sitemapUrls.length, 3);
});

test('the CLI prints help and rejects a missing origin', async () => {
  const { stdout } = await run(process.execPath, [SCRIPT, '--help']);
  assert.match(stdout, /Usage: node fingerprint\.mjs <origin>/);
  await assert.rejects(run(process.execPath, [SCRIPT]), (err) => err.code === 2);
});
