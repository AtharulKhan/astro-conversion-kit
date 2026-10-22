import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';

const exec = promisify(execFile);
const script = (path) => fileURLToPath(new URL(`../../skills/${path}`, import.meta.url));

async function run(path, args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script(path), ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}
const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const build = (args) => run('parity-gates/scripts/build-baseline.mjs', args);

let root;
let capture;
let baseline;
let built;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'build-baseline-test-'));
  capture = join(root, 'capture');
  baseline = join(root, 'baseline');
  const fixture = await startFixture();
  try {
    // REST on (the default), so /hidden-page/ and /private-page/ are in the inventory; the seeds
    // give the capture a redirect chain and a slash redirect besides the shortlinks.
    const steps = [
      ['capture-site/scripts/capture.mjs', [fixture.origin, '--out', capture, '--delay', '0', '--no-wayback', '--seed', '/old-services', '--seed', '/about']],
      ['capture-site/scripts/media.mjs', ['--capture', capture, '--delay', '0']],
      ['capture-site/scripts/templates.mjs', ['--capture', capture]],
    ];
    for (const [name, args] of steps) {
      const result = await run(name, args);
      assert.equal(result.code, 0, result.stderr);
    }
  } finally {
    // The builder runs with the fixture closed: it never touches the network.
    await fixture.close();
  }
  built = await build(['--capture', capture, '--out', baseline]);
});
after(() => rmSync(root, { recursive: true, force: true }));

test('builds from the capture without a network and exits 0', () => {
  assert.equal(built.code, 0, built.stderr);
  for (const file of ['routes.json', 'seo.json', 'redirects.json', 'media.json', 'forms.json', 'scripts.json', 'counts.json']) {
    assert.ok(existsSync(join(baseline, file)), `baseline/${file} written`);
  }
  assert.ok(existsSync(join(root, 'redirects.csv')), 'redirects.csv written beside the baseline');
});

// Measured on the fixture: 14 HTML records (13 pages answering 200, /deleted-post/ 404), the
// /feed/ feed and the brochure PDF linked from every page's footer: 15 routes at 200, one 404.
test('routes: every captured page, feed and linked file, with kind, template and noindex', () => {
  const routes = readJson(baseline, 'routes.json');
  assert.equal(routes.length, 16);
  assert.equal(routes.filter((r) => r.status === 200).length, 15);
  assert.deepEqual(routes.filter((r) => r.status === 404).map((r) => r.path), ['/deleted-post/']);
  for (const r of routes) {
    assert.deepEqual(Object.keys(r), ['path', 'status', 'kind', 'template', 'noindex', 'snapshot', 'foundBy']);
  }
  const by = Object.fromEntries(routes.map((r) => [r.path, r]));
  assert.equal(by['/private-page/'].noindex, true);
  assert.equal(by['/about/'].noindex, false);
  // The REST dump decides page or post; /blog/ is a WordPress page even with an archive body.
  assert.equal(by['/about/'].kind, 'page');
  assert.equal(by['/blog/'].kind, 'page');
  assert.equal(by['/storm-season-prep/'].kind, 'post');
  assert.equal(by['/category/news/'].kind, 'archive');
  assert.equal(by['/feed/'].kind, 'feed');
  assert.equal(by['/wp-content/uploads/2026/01/brochure.pdf'].kind, 'file');
  assert.equal(by['/deleted-post/'].kind, 'other');
  assert.equal(by['/'].template, 'home');
  assert.equal(by['/private-page/'].template, 'page');
  assert.equal(by['/contact/'].template, 'page-2');
  assert.equal(by['/storm-season-prep/'].template, 'single-post');
  assert.equal(by['/deleted-post/'].template, 'other');
  assert.equal(by['/feed/'].template, 'other');
  assert.equal(by['/contact/'].snapshot, 'pages/contact.html');
  assert.equal(by['/feed/'].snapshot, 'feeds/feed.xml');
  assert.equal(by['/wp-content/uploads/2026/01/brochure.pdf'].snapshot, null);
  assert.deepEqual(by['/hidden-page/'].foundBy, ['rest', 'crawl']);
  assert.deepEqual(by['/feed/'].foundBy, ['crawl']);
});

// Measured: /about/ is the fixture page whose og:title differs from its <title>.
test('seo: head fields per page answering 200', () => {
  const seo = readJson(baseline, 'seo.json');
  assert.equal(Object.keys(seo).length, 13);
  assert.ok(!('/deleted-post/' in seo));
  const about = seo['/about/'];
  assert.deepEqual(Object.keys(about), ['title', 'description', 'canonical', 'robots', 'lang', 'h1', 'h2', 'og', 'twitter', 'jsonLd']);
  assert.equal(about.title, 'About Us | Fixture Roofing & Siding');
  assert.equal(about.og.title, 'Meet the Fixture Roofing crew');
  assert.notEqual(about.og.title, about.title);
  assert.equal(seo['/private-page/'].robots, 'noindex, nofollow');
  assert.equal(seo['/contact/'].lang, 'en-US');
  assert.deepEqual(seo['/contact/'].h1, ['Contact']);
});

// Measured: 12 unverified shortlinks (/?p=2 ... /?p=23) plus the two seeds.
test('redirects: capture redirects and shortlinks, as JSON and as redirects.csv', () => {
  const redirects = readJson(baseline, 'redirects.json');
  assert.equal(redirects.length, 14);
  for (const r of redirects) assert.deepEqual(Object.keys(r), ['from', 'to', 'status', 'source']);
  assert.deepEqual(redirects.find((r) => r.from === '/old-services'), { from: '/old-services', to: '/services/', status: 301, source: 'seed' });
  assert.deepEqual(redirects.find((r) => r.from === '/?p=6'), { from: '/?p=6', to: '/contact/', status: 301, source: 'shortlink' });

  const lines = readFileSync(join(root, 'redirects.csv'), 'utf8').trimEnd().split('\n');
  assert.equal(lines[0], 'from,to,status,source,note');
  assert.equal(lines.length, 15);
  assert.ok(lines.includes('/old-services,/services/,301,seed,'));
  assert.ok(lines.includes('/?p=6,/contact/,301,shortlink,unverified shortlink'));
});

test('redirects: a shortlink with no target is left out and named on stderr', async (t) => {
  const copy = join(root, 'capture-null');
  const out = join(root, 'null', 'baseline');
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(capture, copy, { recursive: true });
  const redirects = readJson(copy, 'redirects.json');
  redirects.push({ from: '/?p=99', to: null, status: null, source: 'shortlink', verified: false, hops: [] });
  redirects.push({ from: '/?p=98', to: '/about/', status: 301, source: 'shortlink', verified: true, hops: [] });
  writeFileSync(join(copy, 'redirects.json'), JSON.stringify(redirects));
  const result = await build(['--capture', copy, '--out', out, '--csv', join(root, 'null', 'r.csv')]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /\/\?p=99/);
  assert.ok(!readJson(out, 'redirects.json').some((r) => r.from === '/?p=99'));
  const csv = readFileSync(join(root, 'null', 'r.csv'), 'utf8');
  assert.ok(!csv.includes('/?p=99'));
  assert.ok(csv.includes('/?p=98,/about/,301,shortlink,\n'), 'a verified shortlink has no note');
});

test('media, forms, scripts and text', () => {
  const media = readJson(baseline, 'media.json');
  assert.equal(media.length, 19);
  assert.deepEqual(media.find((m) => m.path.endsWith('/brochure.pdf')), {
    path: '/wp-content/uploads/2026/01/brochure.pdf',
    bytes: media.find((m) => m.path.endsWith('/brochure.pdf')).bytes,
    contentType: 'application/pdf',
  });
  for (const m of media) assert.deepEqual(Object.keys(m), ['path', 'bytes', 'contentType']);

  const forms = readJson(baseline, 'forms.json');
  assert.deepEqual(Object.keys(forms), ['/contact/']);
  assert.equal(forms['/contact/'].length, 1);
  assert.equal(forms['/contact/'][0].method, 'post');
  assert.deepEqual(forms['/contact/'][0].fields.map((f) => f.name), ['name', 'email', 'message', 'website']);

  const scripts = readJson(baseline, 'scripts.json');
  assert.deepEqual(Object.keys(scripts).sort(), ['ga4', 'gtm']);
  assert.deepEqual(Object.keys(scripts.ga4), ['id', 'ids', 'pages', 'keep']);
  assert.equal(scripts.ga4.id, 'G-FIXTURE1');
  assert.equal(scripts.gtm.keep, true);
  assert.ok(scripts.gtm.pages.includes('/contact/'));

  assert.deepEqual(readdirSync(join(baseline, 'text')).sort(), readdirSync(join(capture, 'text')).sort());
  assert.equal(readFileSync(join(baseline, 'text', 'contact.txt'), 'utf8'), readFileSync(join(capture, 'text', 'contact.txt'), 'utf8'));
});

test('counts.json sums the baseline', () => {
  assert.deepEqual(readJson(baseline, 'counts.json'), {
    routes: 16,
    byStatus: { 200: 15, 404: 1 },
    byTemplate: { archive: 2, home: 1, other: 3, page: 6, 'page-2': 1, 'single-post': 3 },
    redirects: { seed: 2, shortlink: 12 },
    media: 19,
    forms: 1,
    scripts: 2,
  });
});

test('--check passes on the built baseline and exits 1 after a route is deleted', async (t) => {
  const passed = await build(['--out', baseline, '--check']);
  assert.equal(passed.code, 0, passed.stderr);

  const copy = join(root, 'drift');
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(baseline, copy, { recursive: true });
  const routes = readJson(copy, 'routes.json').filter((r) => r.path !== '/hidden-page/');
  writeFileSync(join(copy, 'routes.json'), JSON.stringify(routes));
  const drifted = await build(['--out', copy, '--check']);
  assert.equal(drifted.code, 1);
  assert.match(drifted.stdout, /routes: expected 16, got 15/);
});

test('usage errors exit 2', async () => {
  assert.equal((await build(['--capture', join(root, 'missing'), '--out', join(root, 'x')])).code, 2);
  assert.equal((await build(['--bogus'])).code, 2);
  const help = await build(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--check/);
});
