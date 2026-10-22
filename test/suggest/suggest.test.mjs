import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { startFixture } from '../fixture/serve.mjs';

const exec = promisify(execFile);
const skills = (path) => fileURLToPath(new URL(`../../skills/${path}`, import.meta.url));
const CHECKS_DIR = skills('suggest-improvements/scripts/checks');

async function run(path, args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [skills(path), ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}
const suggest = (args) => run('suggest-improvements/scripts/suggest.mjs', args);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const check = async (id) => (await import(join(CHECKS_DIR, `${id}.mjs`))).default;

const MINIMUM = [
  'missing-h1', 'multiple-h1', 'duplicate-titles', 'missing-descriptions', 'long-titles', 'thin-pages',
  'orphan-pages', 'broken-links', 'redirect-chains', 'mixed-content', 'missing-alt', 'oversized-images',
  'no-webp', 'render-blocking-scripts', 'dead-analytics', 'duplicate-analytics', 'noindex-in-sitemap',
  'inconsistent-spacing', 'mobile-overflow', 'missing-security-headers', 'http-links', 'stale-dates',
  'shortcode-leftovers', 'placeholder-text',
];
const CATEGORIES = ['seo', 'performance', 'accessibility', 'content', 'links', 'design', 'analytics', 'security'];
const ITEM_KEYS = ['id', 'path', 'element', 'evidence', 'why', 'effort', 'risk', 'applyable'];

function assertItem(item) {
  for (const key of Object.keys(item)) assert.ok(ITEM_KEYS.includes(key), `unexpected key ${key}`);
  assert.equal(typeof item.id, 'string');
  assert.equal(typeof item.path, 'string');
  if ('element' in item) assert.equal(typeof item.element, 'string');
  assert.ok(typeof item.evidence === 'string' && item.evidence.length > 0, `${item.id} has evidence`);
  assert.ok(typeof item.why === 'string' && item.why.length > 0, `${item.id} has why`);
  assert.ok(['S', 'M', 'L'].includes(item.effort), `${item.id} effort`);
  assert.ok(['none', 'low', 'medium', 'high'].includes(item.risk), `${item.id} risk`);
  assert.equal(typeof item.applyable, 'boolean');
}

function listing(dir) {
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [`${join(d, n)}:${statSync(join(d, n)).size}`]));
  return walk(dir).sort();
}

let root;
let capture;
let baseline;
let result;
let report;
let md;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'suggest-test-'));
  capture = join(root, 'capture');
  baseline = join(root, 'baseline');
  const fixture = await startFixture();
  try {
    const steps = [
      ['capture-site/scripts/capture.mjs', [fixture.origin, '--out', capture, '--delay', '0', '--no-wayback', '--seed', '/old-services', '--seed', '/about']],
      ['capture-site/scripts/media.mjs', ['--capture', capture, '--delay', '0']],
      ['capture-site/scripts/templates.mjs', ['--capture', capture]],
    ];
    for (const [name, args] of steps) {
      const step = await run(name, args);
      assert.equal(step.code, 0, step.stderr);
    }
  } finally {
    await fixture.close();
  }
  const built = await run('parity-gates/scripts/build-baseline.mjs', ['--capture', capture, '--out', baseline]);
  assert.equal(built.code, 0, built.stderr);
  const before = [...listing(capture), ...listing(baseline)];
  result = await suggest(['--capture', capture, '--baseline', baseline, '--out', join(root, 'docs', 'suggestions.md'), '--json', join(root, 'suggestions.json')]);
  assert.deepEqual([...listing(capture), ...listing(baseline)], before, 'the capture and baseline are left as they were');
  report = readJson(join(root, 'suggestions.json'));
  md = readFileSync(join(root, 'docs', 'suggestions.md'), 'utf8');
});
after(() => rmSync(root, { recursive: true, force: true }));

const of = (id) => report.items.filter((i) => i.id === id);

test('writes the report and the JSON from the fixture capture and exits 0', () => {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(report.items.length > 0);
  for (const item of report.items) assertItem(item);
  assert.equal(report.counts.total, report.items.length);
  assert.equal(Object.values(report.counts.byCategory).reduce((a, b) => a + b, 0), report.items.length);
});

test('the fixture yields the expected suggestions with evidence', () => {
  const shortcode = of('shortcode-leftovers');
  assert.deepEqual(shortcode.map((i) => i.path), ['/choosing-siding-colors/']);
  assert.match(shortcode[0].evidence, /\[gallery ids="31,32,33" columns="3"\]/);

  const alt = of('missing-alt');
  assert.deepEqual(alt.map((i) => i.path), ['/']);
  assert.match(alt[0].element, /storm-clouds-300x200\.webp/);

  const orphans = of('orphan-pages');
  assert.deepEqual(orphans.map((i) => i.path), ['/hidden-page/']);
  assert.match(orphans[0].evidence, /not in any sitemap/);
  assert.match(orphans[0].evidence, /linked from 1 page: \//);

  const chains = of('redirect-chains');
  assert.deepEqual(chains.map((i) => i.path), ['/old-services']);
  assert.match(chains[0].evidence, /\/old-services → \/old-services\/ → \/services\//);
  assert.equal(chains[0].applyable, true);

  assert.deepEqual(of('dead-analytics'), [], 'GA4 and GTM both carry ids');
  assert.deepEqual(of('duplicate-analytics'), []);
  assert.deepEqual(of('broken-links').map((i) => i.path), ['/deleted-post/'], 'the sitemap lists a 404');
  assert.ok(of('no-webp').some((i) => i.path === '/wp-content/uploads/2026/01/hero-1024x683.jpg'));
  assert.ok(!of('no-webp').some((i) => i.path.endsWith('.webp')));
  // Every fixture page is short; the archives and the noindex page are not counted.
  const thin = of('thin-pages').map((i) => i.path);
  assert.ok(thin.includes('/about/'));
  for (const path of ['/blog/', '/category/news/', '/private-page/', '/deleted-post/']) assert.ok(!thin.includes(path), path);
  assert.deepEqual(of('missing-h1'), []);
  assert.deepEqual(of('stale-dates'), []);
});

test('the markdown is grouped by category with counts, evidence lines and how to apply', () => {
  assert.match(md, /^# Suggested improvements$/m);
  assert.match(md, new RegExp(`^${report.items.length} suggestions from \\d+ checks`, 'm'));
  assert.match(md, /^## Content \(\d+\)$/m);
  assert.match(md, /^## Links \(\d+\)$/m);
  const lines = md.split('\n');
  const at = lines.findIndex((l) => l.startsWith('- `/choosing-siding-colors/`') && l.includes('shortcode-leftovers'));
  assert.ok(at > 0, 'one line per item naming the path and the check');
  assert.match(lines[at + 1], /^ {2}- Evidence: .*\[gallery/);
  const how = md.slice(md.indexOf('## How to apply'));
  assert.ok(md.includes('## How to apply'));
  assert.match(how, /convert-site/);
  assert.match(how, /--apply <id>/);
  assert.match(how, /--apply redirect-chains/);
  assert.ok(md.indexOf('## How to apply') > md.lastIndexOf('- Evidence:'), 'how to apply comes last');
});

test('every check file exports id, title, category and run, and the catalogue lists each', async () => {
  const files = readdirSync(CHECKS_DIR).filter((n) => n.endsWith('.mjs'));
  const ids = [];
  for (const file of files) {
    const c = (await import(join(CHECKS_DIR, file))).default;
    assert.equal(`${c.id}.mjs`, file);
    assert.equal(typeof c.title, 'string');
    assert.ok(CATEGORIES.includes(c.category), `${c.id} category`);
    assert.equal(typeof c.run, 'function');
    ids.push(c.id);
  }
  for (const id of MINIMUM) assert.ok(ids.includes(id), `check ${id} exists`);
  const catalogue = readFileSync(skills('suggest-improvements/references/catalogue.md'), 'utf8');
  for (const id of ids) assert.match(catalogue, new RegExp(`^\\| \`${id}\` \\|`, 'm'), `catalogue row for ${id}`);
  assert.deepEqual(report.checks.map((c) => c.id).sort(), ids.sort());
});

test('review, Lighthouse and gates inputs feed the design and security checks', async (t) => {
  const review = join(root, 'review');
  const lighthouse = join(root, 'lighthouse-live');
  t.after(() => rmSync(review, { recursive: true, force: true }));
  mkdirSync(join(review, 'new', 'home'), { recursive: true });
  mkdirSync(lighthouse, { recursive: true });
  // A 390 px shot that came out 420 px wide: the page scrolls sideways on a phone.
  const png = new PNG({ width: 420, height: 20 });
  writeFileSync(join(review, 'new', 'home', '390.png'), PNG.sync.write(png));
  const narrow = new PNG({ width: 768, height: 20 });
  mkdirSync(join(review, 'new', 'page'), { recursive: true });
  writeFileSync(join(review, 'new', 'page', '768.png'), PNG.sync.write(narrow));
  writeFileSync(join(review, 'new', 'manifest.json'), JSON.stringify([
    { route: 'home', width: 390, file: 'home/390.png', heightPx: 20, bannerClosed: false, scrollHeight: 20, heightMismatch: false },
    { route: 'page', width: 768, file: 'page/768.png', heightPx: 20, bannerClosed: false, scrollHeight: 20, heightMismatch: false },
  ]));
  const row = (route, path, live) => ({ route, path, width: 1440, selector: 'h1', property: 'margin-bottom', live, new: live, pass: true });
  writeFileSync(join(review, 'styles.json'), JSON.stringify([row('home', '/', '24px'), row('page', '/about/', '32px'), row('single-post', '/storm-season-prep/', '24px')]));
  writeFileSync(join(lighthouse, 'home.json'), JSON.stringify({
    requestedUrl: 'http://127.0.0.1/',
    audits: {
      'has-hsts': { id: 'has-hsts', title: 'Use a strong HSTS policy', score: 0 },
      'csp-xss': { id: 'csp-xss', title: 'Ensure CSP is effective against XSS attacks', score: 1 },
    },
  }));
  const gates = join(root, 'gates.json');
  writeFileSync(gates, JSON.stringify([{ gate: 'routes', checked: 16, failed: 0, failures: [] }, { gate: 'seo', checked: 13, failed: 2, failures: ['/a/', '/b/'] }]));

  const out = join(root, 'full.md');
  const json = join(root, 'full.json');
  const full = await suggest(['--capture', capture, '--baseline', baseline, '--review', review, '--lighthouse', lighthouse, '--gates', gates, '--out', out, '--json', json]);
  assert.equal(full.code, 0, full.stderr);
  const items = readJson(json).items;
  for (const item of items) assertItem(item);
  const overflow = items.filter((i) => i.id === 'mobile-overflow');
  assert.deepEqual(overflow.map((i) => i.path), ['/']);
  assert.match(overflow[0].evidence, /420 px wide at a 390 px viewport/);
  const spacing = items.filter((i) => i.id === 'inconsistent-spacing');
  assert.equal(spacing.length, 1);
  assert.equal(spacing[0].element, 'h1 margin-bottom');
  assert.match(spacing[0].evidence, /home 24px/);
  assert.match(spacing[0].evidence, /page 32px/);
  const headers = items.filter((i) => i.id === 'missing-security-headers');
  assert.deepEqual(headers.map((i) => i.path), ['/']);
  assert.match(headers[0].evidence, /Use a strong HSTS policy/);
  assert.doesNotMatch(headers[0].evidence, /CSP/);
  assert.match(readFileSync(out, 'utf8'), /^Gates: 1 of 2 failing \(seo: 2\)/m);
});

// Cases the fixture does not have, run against each check directly.
const page = (over) => ({
  path: '/x/', url: 'https://www.example.com/x/', status: 200, title: 'X', description: 'd', robots: null,
  h1: ['X'], images: [], scripts: [], styles: [], iframes: [], internalLinks: [], externalLinks: [],
  wordCount: 400, foundBy: ['sitemap', 'crawl'], text: '', published: null, modified: null, snapshot: null, ...over,
});
const ctx = (over) => ({
  inventory: [], baseline: { routes: [], seo: {}, media: [], scripts: {}, meta: null }, media: [], redirects: [],
  links: { internal: {}, external: {} }, templates: [], styles: [], manifest: [], lighthouse: [], gates: null,
  meta: { origin: 'https://www.example.com' }, now: new Date('2026-10-22T00:00:00Z'), readSnapshot: () => null, readReviewPng: () => null, ...over,
});

test('dead-analytics: a vendor loaded without an id', async () => {
  const c = await check('dead-analytics');
  const items = c.run(ctx({ baseline: { routes: [], seo: {}, media: [], scripts: { ga4: { id: null, ids: [], pages: ['/', '/x/'], keep: true }, other: { id: null, ids: [], pages: ['/'] } } } }));
  assert.equal(items.length, 1);
  assertItem(items[0]);
  assert.equal(items[0].element, 'ga4');
  assert.match(items[0].evidence, /2 pages/);
});

test('orphan-pages: a page no crawled page links to; noindex pages are left alone', async () => {
  const c = await check('orphan-pages');
  const inventory = [page({ path: '/' }), page({ path: '/lost/', foundBy: ['sitemap'] }), page({ path: '/x/' }), page({ path: '/secret/', robots: 'noindex', foundBy: ['rest'] })];
  const items = c.run(ctx({ inventory, links: { internal: { '/x/': ['/'] }, external: {} } }));
  assert.deepEqual(items.map((i) => i.path), ['/lost/']);
  assert.match(items[0].evidence, /no crawled page links here/);
});

test('stale-dates, placeholder-text, mixed-content, http-links, multiple-h1, long-titles, duplicate-titles', async () => {
  const inventory = [
    page({ path: '/old/', modified: '2021-01-01T00:00:00Z', title: 'Same' }),
    page({ path: '/lorem/', text: 'Lorem ipsum dolor sit amet', title: 'Same' }),
    page({ path: '/mixed/', images: [{ src: 'http://cdn.example.com/a.jpg', alt: 'a', width: 10, height: 10, lazy: false }], externalLinks: ['http://partner.example.com/'] }),
    page({ path: '/two/', h1: ['A', 'B'], title: 'T'.repeat(70) }),
  ];
  const run = async (id) => (await check(id)).run(ctx({ inventory }));
  assert.deepEqual((await run('stale-dates')).map((i) => i.path), ['/old/']);
  assert.deepEqual((await run('placeholder-text')).map((i) => i.path), ['/lorem/']);
  assert.deepEqual((await run('mixed-content')).map((i) => i.path), ['/mixed/']);
  assert.deepEqual((await run('http-links')).map((i) => i.path), ['/mixed/']);
  assert.deepEqual((await run('multiple-h1')).map((i) => i.path), ['/two/']);
  assert.deepEqual((await run('long-titles')).map((i) => i.path), ['/two/']);
  assert.deepEqual((await run('duplicate-titles')).map((i) => i.path).sort(), ['/lorem/', '/old/']);
});

test('oversized-images and render-blocking-scripts', async () => {
  const inventory = [page({
    path: '/big/', snapshot: 'pages/big.html',
    images: [{ src: 'https://www.example.com/wp-content/uploads/a-2048x1365.jpg', alt: 'a', width: 600, height: 400, lazy: false }],
  })];
  const media = [{ path: '/wp-content/uploads/a-2048x1365.jpg', bytes: 400 * 1024, contentType: 'image/jpeg', status: 200 }];
  const oversized = (await check('oversized-images')).run(ctx({ inventory, media }));
  assert.equal(oversized.length, 1);
  assert.match(oversized[0].evidence, /400 KB/);
  assert.match(oversized[0].evidence, /600 px of 2048/);
  const html = '<html><head><script src="/a.js"></script><script async src="/b.js"></script><script defer src="/c.js"></script></head><body><script src="/d.js"></script></body></html>';
  const blocking = (await check('render-blocking-scripts')).run(ctx({ inventory, readSnapshot: () => html }));
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].element, 'script[src="/a.js"]');
});

test('usage errors exit 2 and --help exits 0', async () => {
  const help = await suggest(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--apply/);
  assert.equal((await suggest(['--bogus'])).code, 2);
  assert.equal((await suggest(['--capture', join(root, 'missing'), '--baseline', baseline, '--out', join(root, 'x.md')])).code, 2);
  assert.equal((await suggest(['--capture', capture, '--baseline', baseline])).code, 2, '--out is required');
});
