import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as csstree from 'css-tree';
import { startFixture } from '../fixture/serve.mjs';
import { mergeRanges } from '../../skills/convert-site/scripts/css-coverage.mjs';
import { mediaTested, pruneCss, rewriteRef } from '../../skills/convert-site/scripts/css-prune.mjs';

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

// A capture/css folder holding the theme stylesheet (plus any extra files),
// optionally with its manifest.
function captureCss(name, { file = '1.css', manifest = true, extra = [] } = {}) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), THEME_TEXT);
  for (const entry of extra) writeFileSync(join(dir, entry.file), entry.text);
  const entries = [{ file, href: themeUrl, pages: ['/'] }, ...extra.map(({ file: f, href }) => ({ file: f, href, pages: ['/'] }))];
  if (manifest) writeFileSync(join(dir, 'manifest.json'), JSON.stringify(entries));
  return dir;
}

const FONT_URL = 'url("/wp-content/themes/fixture/fonts/fixture-sans.woff2")';

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

test('coverage hovers the first link a person could point at, not a clipped skip link', async () => {
  const html = '<!doctype html><style>.skip { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }'
    + ' .real:hover { color: red; }</style><a class="skip" href="#main">Skip</a><p><a class="real" href="/x/">Real</a></p>';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const out = join(TMP, 'hover.json');
  try {
    const result = await coverageCli([
      '--base', `http://127.0.0.1:${server.address().port}`, '--routes', '/', '--widths', '390', '--out', out, '--delay', '0',
    ]);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    server.close();
  }
  const { text, usedRanges } = readJson(out)['inline:1'];
  const start = text.indexOf('.real:hover');
  assert.ok(overlaps(usedRanges, start, text.indexOf('}', start) + 1), 'the hover rule of the visible link is used');
});

test('pruning removes the unused rules, keeps pseudo rules and @font-face, and copies kept source as written', async () => {
  const out = join(TMP, 'site.css');
  const report = join(TMP, 'prune-report.json');
  const result = await pruneCli(['--css', captureCss('capture-css'), '--coverage', COVERAGE, '--out', out, '--report', report]);
  assert.equal(result.code, 0, result.stderr);
  const css = readFileSync(out, 'utf8');
  for (const selector of LEFTOVER) assert.ok(!css.includes(selector), `${selector} removed`);
  for (const kept of [
    'a:hover, a:focus { color: #7a2414; text-decoration: none; }',
    '.button:hover { background: #7a2414; color: #fff; }',
    '.skip-link:focus {',
    '.menu-item-has-children:hover .sub-menu { display: block; }',
    '.contact-form label { display: block; font-weight: 600; }',
    '@media (max-width: 640px) {\n  .site-header { flex-direction: column; gap: 12px; }\n  .hero h1 { font-size: 1.75rem; }\n}',
  ]) {
    assert.ok(css.includes(kept), `${kept} kept verbatim`);
  }
  assert.equal(css.match(/@font-face/g).length, 2);
  assert.ok(css.includes(`src: ${FONT_URL} format("woff2");`), 'font url rewritten root-relative');
  const errors = [];
  csstree.parse(css, { onParseError: (err) => errors.push(err.message) });
  assert.deepEqual(errors, []);

  const summary = readJson(report);
  assert.deepEqual(Object.keys(summary).sort(), ['after', 'before', 'keptBecause', 'removedRules', 'uncoveredInline', 'unmatched']);
  assert.deepEqual(Object.keys(summary.keptBecause).sort(), ['atRule', 'pseudo', 'untestedMedia']);
  assert.deepEqual(summary.unmatched, []);
  assert.ok(summary.removedRules >= 20, `removedRules ${summary.removedRules}`);
  assert.equal(summary.before, Buffer.byteLength(THEME_TEXT));
  assert.equal(summary.after, statSync(out).size);
  assert.ok(summary.after < summary.before);
});

test('without a manifest, coverage URLs match files by basename and still resolve url()', async () => {
  const out = join(TMP, 'basename.css');
  const report = join(TMP, 'basename-report.json');
  const dir = captureCss('capture-basename', { file: 'style.css', manifest: false });
  const result = await pruneCli(['--css', dir, '--coverage', COVERAGE, '--out', out, '--report', report]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /no manifest\.json/);
  const css = readFileSync(out, 'utf8');
  assert.ok(css.includes('.site-header'));
  assert.ok(!css.includes('.woocommerce-cart'));
  assert.ok(css.includes(FONT_URL));
});

test('coverage keys match the manifest on path and query whatever their origin', async () => {
  const moved = join(TMP, 'coverage-other-origin.json');
  const coverage = readJson(COVERAGE);
  const rekeyed = Object.fromEntries(Object.entries(coverage).map(([key, value]) => [key.replace(fixture.origin, 'https://staging.example.com'), value]));
  writeFileSync(moved, JSON.stringify(rekeyed));
  const out = join(TMP, 'other-origin.css');
  const result = await pruneCli(['--css', captureCss('capture-other-origin'), '--coverage', moved, '--out', out, '--report', join(TMP, 'other-origin.json')]);
  assert.equal(result.code, 0, result.stderr);
  const css = readFileSync(out, 'utf8');
  assert.ok(css.includes('.site-header {'));
  assert.ok(!css.includes('.woocommerce-cart'));
});

test('a file with no matching coverage is kept whole and the exit code is 1', async () => {
  const pluginCss = '.plugin-widget { color: red; }\n.plugin-other { color: blue; }\n';
  const dir = captureCss('capture-unmatched', {
    extra: [{ file: '2.css', href: `${fixture.origin}/wp-content/plugins/widget/widget.css`, text: pluginCss }],
  });
  const out = join(TMP, 'unmatched.css');
  const report = join(TMP, 'unmatched-report.json');
  const result = await pruneCli(['--css', dir, '--coverage', COVERAGE, '--out', out, '--report', report]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /2\.css/);
  const css = readFileSync(out, 'utf8');
  assert.ok(css.includes('.plugin-widget { color: red; }'));
  assert.ok(css.includes('.plugin-other { color: blue; }'));
  assert.ok(!css.includes('.woocommerce-cart'), 'the matched file is still pruned');
  assert.deepEqual(readJson(report).unmatched, ['2.css']);
});

test('inline <style> blocks of a real capture are matched to their pages: pruned under a comment naming them, and never "unmatched"', async () => {
  const out = join(TMP, 'capture-inline');
  rmSync(out, { recursive: true, force: true });
  const captured = await run(join(ROOT, 'skills', 'capture-site', 'scripts', 'capture.mjs'), [
    fixture.origin, '--out', out, '--delay', '0', '--no-rest', '--no-wayback',
  ]);
  assert.equal(captured.code, 0, captured.stderr);
  const inline = readJson(join(out, 'css', 'manifest.json')).filter((entry) => entry.inline);
  // WordPress-style: both pages carry the same two blocks, the contact page one more, so each
  // page has its own inline file and the shared blocks' coverage belongs to both.
  assert.deepEqual(inline.map((entry) => entry.pages), [['/'], ['/contact/']]);
  const css = join(TMP, 'inline-site.css');
  const report = join(TMP, 'inline-report.json');
  const result = await pruneCli(['--css', join(out, 'css'), '--coverage', COVERAGE, '--out', css, '--report', report]);
  assert.equal(result.code, 0, result.stderr);
  const summary = readJson(report);
  assert.deepEqual(summary.unmatched, []);
  assert.deepEqual(summary.uncoveredInline, []);
  const text = readFileSync(css, 'utf8');
  const root = ':root{--wp--preset--color--black: #000000;';
  let from = 0;
  for (const [path, entry] of [['/', inline[0]], ['/contact/', inline[1]]]) {
    const comment = text.indexOf(`/* inline <style> blocks of ${path} (${entry.file}) */\n${root}`, from);
    assert.ok(comment !== -1, `${path}: ${text.slice(-900)}`);
    from = comment + 1;
  }
  for (const gone of ['img.wp-smiley', '.has-vivid-red-color', '.wpcf7-not-valid-tip']) assert.ok(!text.includes(gone), `${gone} removed`);
  assert.ok(!text.includes('.woocommerce-cart'), 'the theme sheet is still pruned');
});

test('an inline file no coverage saw is kept whole and listed, without failing the run', async () => {
  const dir = captureCss('capture-inline-uncovered');
  writeFileSync(join(dir, 'inline-about.css'), '.about-only { color: red; }\n');
  const manifest = readJson(join(dir, 'manifest.json'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify([...manifest, { file: 'inline-about.css', inline: true, pages: ['/about/'] }]));
  const out = join(TMP, 'inline-uncovered.css');
  const report = join(TMP, 'inline-uncovered.json');
  const result = await pruneCli(['--css', dir, '--coverage', COVERAGE, '--out', out, '--report', report]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(readFileSync(out, 'utf8').includes('/* inline <style> blocks of /about/ (inline-about.css) */\n.about-only { color: red; }'));
  assert.deepEqual(readJson(report).unmatched, []);
  assert.deepEqual(readJson(report).uncoveredInline, ['inline-about.css']);
});

test('rewriteRef makes same-origin references root-relative and leaves the rest alone', () => {
  const href = 'https://www.example.com/wp-content/themes/x/style.css?ver=2';
  const site = 'https://www.example.com';
  assert.equal(rewriteRef('fonts/a.woff2', href, site), '/wp-content/themes/x/fonts/a.woff2');
  assert.equal(rewriteRef('../img/b.png?v=1#frag', href, site), '/wp-content/themes/img/b.png?v=1#frag');
  assert.equal(rewriteRef('https://www.example.com/c.png', href, site), '/c.png');
  assert.equal(rewriteRef('https://cdn.example.com/d.woff2', href, site), null);
  assert.equal(rewriteRef('//cdn.example.com/e.woff2', href, site), null);
  assert.equal(rewriteRef('data:image/png;base64,AAAA', href, site), null);
  assert.equal(rewriteRef('#gradient', href, site), null);
  assert.equal(rewriteRef('/already/root.png', href, site), null);
  assert.equal(rewriteRef('fonts/f.woff2', 'https://cdn.example.com/lib/g.css', site), 'https://cdn.example.com/lib/fonts/f.woff2');
  assert.equal(rewriteRef('img/h.png', '/about/', site), '/about/img/h.png', 'inline block resolved against its page');
  assert.equal(rewriteRef('img/h.png', undefined, site), null);
});

test('pruneCss rewrites url() and @import in every form and hoists @layer, @import and @namespace', () => {
  const text = [
    '@layer base, theme;',
    '@import "parts/a.css";',
    "@import url('parts/b.css') screen;",
    '@namespace svg url(http://www.w3.org/2000/svg);',
    '.logo { background: url(img/logo.svg); }',
    ".hero { background-image: url('../uploads/hero.jpg'), url(\"data:image/gif;base64,R0lGOD\"); }",
  ].join('\n');
  const result = pruneCss(text, [[0, text.length]], { base: 'https://www.example.com/wp-content/themes/x/style.css', siteOrigin: 'https://www.example.com' });
  assert.deepEqual(result.header, {
    layers: ['@layer base, theme;'],
    imports: ['@import "/wp-content/themes/x/parts/a.css";', "@import url('/wp-content/themes/x/parts/b.css') screen;"],
    namespaces: ['@namespace svg url(http://www.w3.org/2000/svg);'],
  });
  assert.equal(result.css, [
    '.logo { background: url(/wp-content/themes/x/img/logo.svg); }',
    ".hero { background-image: url('/wp-content/themes/uploads/hero.jpg'), url(\"data:image/gif;base64,R0lGOD\"); }",
  ].join('\n'));
  const inline = pruneCss('.a { background: url(pic.png); }', [[0, 10]], { base: '/about/', siteOrigin: 'https://www.example.com' });
  assert.equal(inline.css, '.a { background: url(/about/pic.png); }');
});

test('mediaTested says whether any tested width satisfies a query', () => {
  assert.equal(mediaTested('(max-width: 640px)'), true);
  assert.equal(mediaTested('screen and (min-width: 1200px)'), true);
  assert.equal(mediaTested('(width >= 700px) and (width < 800px)'), true);
  assert.equal(mediaTested('(700px <= width <= 800px)'), true);
  assert.equal(mediaTested('(width >= 600px) and (width < 700px)'), false);
  assert.equal(mediaTested('(min-width: 2000px)'), false);
  assert.equal(mediaTested('print'), false);
  assert.equal(mediaTested('(min-resolution: 2dppx)'), false, 'unknown features count as untested');
  assert.equal(mediaTested('print, (max-width: 400px)'), true);
  assert.equal(mediaTested('(min-width: 500px) and (max-width: 600px)', [390, 1440]), false);
});

test('pruneCss keeps exceptions and untested media, drops @media blocks left empty, and keeps comments inside rules', () => {
  const text = [
    '.used { color: red; /* brand red */ }',
    '.gone { color: blue; }',
    '@keyframes spin { to { transform: rotate(1turn); } }',
    '@supports (display: grid) { .x { display: grid; } }',
    '@media (prefers-reduced-motion: reduce) { .y { animation: none; } }',
    '@media (min-width: 900px) { .z { color: green; } }',
    '@media (max-width: 800px) { .used { color: black; } .w { color: gray; } }',
    '@media print { .p { color: black; } }',
    '@media (min-width: 2000px) { .big { width: 1900px; } }',
    '.card:not(.big) { margin: 0; }',
    'li:nth-child(2n) { color: teal; }',
    '.q::after { content: ""; }',
    'input:disabled { opacity: 0.5; }',
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
  for (const kept of [
    '.used { color: red; /* brand red */ }',
    '@keyframes spin { to { transform: rotate(1turn); } }',
    '@supports (display: grid) { .x { display: grid; } }',
    '@media (prefers-reduced-motion: reduce) { .y { animation: none; } }',
    '@media (max-width: 800px) {\n  .used { color: black; }\n}',
    '@media print { .p { color: black; } }',
    '@media (min-width: 2000px) { .big { width: 1900px; } }',
    '.card:not(.big) { margin: 0; }',
    'li:nth-child(2n) { color: teal; }',
    '.q::after { content: ""; }',
    'input:disabled { opacity: 0.5; }',
  ]) {
    assert.ok(result.css.includes(kept), `${kept} kept`);
  }
  for (const gone of ['.gone', 'min-width: 900px', '.w {']) assert.ok(!result.css.includes(gone), `${gone} removed`);
  assert.equal(result.removedRules, 3);
  assert.deepEqual(result.keptBecause, { pseudo: 4, atRule: 3, untestedMedia: 2 });
});

test('the home page with the pruned stylesheet at another path matches the original pixel for pixel', async () => {
  const copyRoot = join(TMP, 'site');
  cpSync(SITE, copyRoot, { recursive: true });
  // The pruned file lives at /assets/site.css, so its font references only work if they were rewritten.
  rmSync(join(copyRoot, THEME));
  mkdirSync(join(copyRoot, 'assets'), { recursive: true });
  writeFileSync(join(copyRoot, 'assets', 'site.css'), readFileSync(join(TMP, 'site.css')));
  const home = join(copyRoot, 'index.html');
  const html = readFileSync(home, 'utf8');
  const original = `{{ORIGIN}}/${THEME}?ver=1.4.2`;
  assert.ok(html.includes(original));
  writeFileSync(home, html.replace(original, '{{ORIGIN}}/assets/site.css'));
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
