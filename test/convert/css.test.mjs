import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as csstree from 'css-tree';
import { startFixture } from '../fixture/serve.mjs';
import { mergeRanges } from '../../skills/convert-site/scripts/css-coverage.mjs';
import { pruneCss } from '../../skills/convert-site/scripts/css-prune.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPTS = join(ROOT, 'skills', 'convert-site', 'scripts');
const VISUAL = join(ROOT, 'skills', 'visual-review', 'scripts');
const SITE = join(ROOT, 'test', 'fixture', 'site');
const THEME = 'wp-content/themes/fixture/style.css';
const THEME_TEXT = readFileSync(join(SITE, THEME), 'utf8');
const TMP = join(ROOT, 'test', 'tmp', 'css');
const COVERAGE = join(TMP, 'coverage.json');
const LEFTOVER = [
  '.woocommerce-cart', '.woocommerce-checkout', '.elementor-section', '.elementor-widget-container',
  '.wp-block-cover', '.wp-block-pullquote', '.wp-block-table', '.sidebar-widget', '.widget_calendar',
  '.comment-respond', '.comment-list', '.pagination', '.sticky-post', '.author-bio', '.related-posts',
  '.newsletter-popup', '.cookie-notice', '.testimonial-slider', '.pricing-table', '.map-embed',
  '.gallery-columns-4', '.legacy-header-v1',
];

// Async on purpose: the fixture server lives in this process and must keep answering.
function run(script, args) {
  return new Promise((done) => {
    execFile(process.execPath, [script, ...args], (err, stdout, stderr) => {
      done({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}
const coverageCli = (args) => run(join(SCRIPTS, 'css-coverage.mjs'), args);
const pruneCli = (args) => run(join(SCRIPTS, 'css-prune.mjs'), args);

let fixture;
let themeUrl;
before(async () => {
  fixture = await startFixture();
  themeUrl = `${fixture.origin}/${THEME}?ver=1.4.2`;
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const inventory = join(TMP, 'inventory.json');
  writeFileSync(inventory, JSON.stringify([{ path: '/', status: 200 }, { path: '/contact/', status: 200 }]));
  const result = await coverageCli([
    '--base', fixture.origin, '--routes', inventory, '--widths', '390,768,1440', '--out', COVERAGE, '--delay', '0',
  ]);
  assert.equal(result.code, 0, result.stderr);
});
after(() => fixture.close());

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const overlaps = (ranges, start, end) => ranges.some(([a, b]) => a < end && b > start);

// A capture/css folder holding the theme stylesheet, optionally with its manifest.
function captureCss(name, { file = '1.css', manifest = true } = {}) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), THEME_TEXT);
  if (manifest) writeFileSync(join(dir, 'manifest.json'), JSON.stringify([{ file, href: themeUrl, pages: ['/'] }]));
  return dir;
}

test('mergeRanges sorts and merges overlapping and touching ranges', () => {
  assert.deepEqual(mergeRanges([[10, 20], [0, 5], [15, 30], [30, 31], [40, 41]]), [[0, 5], [10, 31], [40, 41]]);
});

test('css-coverage --help exits 0, and a missing --base exits 2', async () => {
  const help = await coverageCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--routes/);
  const bad = await coverageCli(['--routes', '/', '--out', join(TMP, 'x.json')]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--base/);
});

test('coverage reports the theme stylesheet with merged used ranges across routes', () => {
  const coverage = readJson(COVERAGE);
  const entry = coverage[themeUrl];
  assert.ok(entry, `keys: ${Object.keys(coverage).join(', ')}`);
  assert.equal(entry.text, THEME_TEXT);
  assert.ok(entry.usedRanges.length > 0);
  assert.deepEqual(entry.usedRanges, mergeRanges(entry.usedRanges), 'ranges are already merged');
  const at = (selector) => {
    const start = THEME_TEXT.indexOf(selector);
    return [start, THEME_TEXT.indexOf('}', start) + 1];
  };
  assert.ok(overlaps(entry.usedRanges, ...at('.site-header {')), 'home rule used');
  assert.ok(overlaps(entry.usedRanges, ...at('.contact-form label')), 'contact-only rule used');
  assert.ok(!overlaps(entry.usedRanges, ...at('.woocommerce-cart')), 'leftover rule unused');
});

test('coverage keys inline <style> blocks as inline:<n> with the pages they appear on', async () => {
  const html = '<!doctype html><style>.used { color: red; } .unused { color: blue; }</style><p class="used">x</p>';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const out = join(TMP, 'inline.json');
  try {
    const result = await coverageCli([
      '--base', `http://127.0.0.1:${server.address().port}`, '--routes', '/,/b/', '--widths', '390', '--out', out, '--delay', '0',
    ]);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    server.close();
  }
  const coverage = readJson(out);
  assert.deepEqual(Object.keys(coverage), ['inline:1']);
  const { text, usedRanges, pages } = coverage['inline:1'];
  assert.deepEqual(pages, ['/', '/b/']);
  assert.ok(overlaps(usedRanges, text.indexOf('.used'), text.indexOf('.used') + 5));
  assert.ok(!overlaps(usedRanges, text.indexOf('.unused'), text.indexOf('.unused') + 7));
});

test('pruning removes the unused rules and keeps pseudo rules and @font-face', async () => {
  const out = join(TMP, 'site.css');
  const report = join(TMP, 'prune-report.json');
  const result = await pruneCli(['--css', captureCss('capture-css'), '--coverage', COVERAGE, '--out', out, '--report', report]);
  assert.equal(result.code, 0, result.stderr);
  const css = readFileSync(out, 'utf8');
  for (const selector of LEFTOVER) assert.ok(!css.includes(selector), `${selector} removed`);
  for (const kept of ['a:hover', '.button:hover', '.skip-link:focus', '.menu-item-has-children:hover .sub-menu', '.contact-form label']) {
    assert.ok(css.includes(kept), `${kept} kept`);
  }
  assert.equal(css.match(/@font-face/g).length, 2);
  assert.match(css, /@media \(max-width:640px\)\{\.site-header/);
  const errors = [];
  csstree.parse(css, { onParseError: (err) => errors.push(err.message) });
  assert.deepEqual(errors, []);

  const summary = readJson(report);
  assert.deepEqual(Object.keys(summary).sort(), ['after', 'before', 'keptBecause', 'removedRules']);
  assert.deepEqual(Object.keys(summary.keptBecause).sort(), ['atRule', 'pseudo']);
  assert.ok(summary.removedRules >= 20, `removedRules ${summary.removedRules}`);
  assert.equal(summary.before, Buffer.byteLength(THEME_TEXT));
  assert.equal(summary.after, statSync(out).size);
  assert.ok(summary.after < summary.before);
});

test('without a manifest, coverage URLs match files by basename', async () => {
  const out = join(TMP, 'basename.css');
  const report = join(TMP, 'basename-report.json');
  const dir = captureCss('capture-basename', { file: 'style.css', manifest: false });
  const result = await pruneCli(['--css', dir, '--coverage', COVERAGE, '--out', out, '--report', report]);
  assert.equal(result.code, 0, result.stderr);
  const css = readFileSync(out, 'utf8');
  assert.ok(css.includes('.site-header'));
  assert.ok(!css.includes('.woocommerce-cart'));
});

test('pruneCss keeps at-rule exceptions and drops @media blocks left empty', () => {
  const text = [
    '.used { color: red; }',
    '.gone { color: blue; }',
    '@keyframes spin { to { transform: rotate(1turn); } }',
    '@supports (display: grid) { .x { display: grid; } }',
    '@media (prefers-reduced-motion: reduce) { .y { animation: none; } }',
    '@media (min-width: 900px) { .z { color: green; } }',
    '@media print { .used { color: black; } .w { color: gray; } }',
    '.card:not(.big) { margin: 0; }',
    'li:nth-child(2n) { color: teal; }',
    '.q::after { content: ""; }',
  ].join('\n');
  const used = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf('.used', from);
    if (at === -1) break;
    used.push([at, text.indexOf('}', at) + 1]);
    from = at + 1;
  }
  const result = pruneCss(text, used);
  const keptSelectors = ['.used', '@keyframes spin', '@supports', 'prefers-reduced-motion', '.card:not(.big)', 'li:nth-child(2n)', '.q::after'];
  for (const kept of keptSelectors) assert.ok(result.css.includes(kept), `${kept} kept`);
  for (const gone of ['.gone', 'min-width:900px', '.w{']) assert.ok(!result.css.includes(gone), `${gone} removed`);
  assert.match(result.css, /@media print\{\.used\{color:black\}\}/);
  assert.equal(result.removedRules, 3);
  assert.deepEqual(result.keptBecause, { pseudo: 3, atRule: 3 });
});

test('the home page with the pruned stylesheet matches the original pixel for pixel', async () => {
  const copyRoot = join(TMP, 'site');
  cpSync(SITE, copyRoot, { recursive: true });
  writeFileSync(join(copyRoot, THEME), readFileSync(join(TMP, 'site.css')));
  const copy = await startFixture({ root: copyRoot });
  try {
    const shoot = (base, out) => run(join(VISUAL, 'shoot.mjs'), [
      '--base', base, '--routes', '/', '--widths', '390,1440', '--out', out, '--delay', '0', '--wait', '0',
    ]);
    for (const [base, out] of [[fixture.origin, join(TMP, 'shots-a')], [copy.origin, join(TMP, 'shots-b')]]) {
      const shot = await shoot(base, out);
      assert.equal(shot.code, 0, shot.stderr);
    }
  } finally {
    await copy.close();
  }
  const diffOut = join(TMP, 'shots-diff');
  const diff = await run(join(VISUAL, 'diff.mjs'), [
    '--a', join(TMP, 'shots-a'), '--b', join(TMP, 'shots-b'), '--out', diffOut, '--threshold', '0.5',
  ]);
  assert.equal(diff.code, 0, diff.stdout + diff.stderr);
  const rows = readJson(join(diffOut, 'diff.json'));
  assert.deepEqual(rows.map((row) => row.width).sort((a, b) => a - b), [390, 1440]);
  for (const row of rows) assert.equal(row.percent, 0, `${row.route} at ${row.width}`);
});
