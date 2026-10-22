import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SCRIPT = join(ROOT, 'skills', 'visual-review', 'scripts', 'sheet.mjs');
const TMP = join(ROOT, 'test', 'tmp', 'sheet');
// Routes are folder names, as shoot.mjs writes them: a template name or a path slug.
const ROUTES = [{ route: 'home', folder: 'home' }, { route: 'about', folder: 'about' }];
const WIDTHS = [390, 1440];

function writePng(file, rgb) {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, PNG.sync.write(png));
}

function writeShots(dir, rgb) {
  const manifest = [];
  for (const { route, folder } of ROUTES) {
    for (const width of WIDTHS) {
      const file = `${folder}/${width}.png`;
      writePng(join(dir, file), rgb);
      manifest.push({ route, width, file, heightPx: 4, bannerClosed: false });
    }
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

function run(args) {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], (error, stdout, stderr) => {
      done({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

let liveManifest;
let newManifest;
let diff;
const styles = [
  { route: 'about', path: '/about/', width: 1440, selector: 'h1', property: 'font-size', live: '32px', new: '40px', pass: false },
  { route: 'about', path: '/about/', width: 1440, selector: 'h1', property: 'margin-top', live: '21.44px', new: '26.8px', pass: false },
  { route: 'about', path: '/about/', width: 1440, selector: 'p', property: 'line-height', live: '25.6px', new: '25.6px', pass: true },
  { route: 'home', path: '/', width: 390, selector: 'a', property: 'color', live: 'rgb(178, 60, 40)', new: 'rgb(0, 0, 0)', pass: false },
  // A route-width pair with no screenshots or diff: still listed, under a style-only card.
  { route: 'blog', path: '/blog/', width: 768, selector: 'h2', property: 'color', live: 'rgb(0, 0, 0)', new: 'rgb(1, 1, 1)', pass: false },
];

before(() => {
  rmSync(TMP, { recursive: true, force: true });
  liveManifest = writeShots(join(TMP, 'live'), [255, 255, 255]);
  newManifest = writeShots(join(TMP, 'new'), [250, 250, 250]);
  diff = [];
  for (const { route, folder } of ROUTES) {
    for (const width of WIDTHS) {
      writePng(join(TMP, 'diff', folder, `${width}.png`), [255, 0, 0]);
      const pass = !(route === 'home' && width === 1440);
      diff.push({ route, width, percent: pass ? 0.1 : 3.25, pass, heightA: 4, heightB: 4 });
    }
  }
  delete diff[diff.length - 1].percent;
  writeFileSync(join(TMP, 'diff', 'diff.json'), JSON.stringify(diff));
  writeFileSync(join(TMP, 'styles.json'), JSON.stringify(styles));
});
after(() => rmSync(TMP, { recursive: true, force: true }));

const withoutDataUris = (html) => html.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, '');

test('--help prints usage and exits 0', async () => {
  const { code, stdout } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage: node sheet\.mjs/);
});

test('a missing diff.json is a usage error', async () => {
  const { code } = await run(['--live', join(TMP, 'live'), '--new', join(TMP, 'new'), '--diff', join(TMP, 'nope.json'), '--out', join(TMP, 'x.html')]);
  assert.equal(code, 2);
});

test('the contact sheet embeds every image and marks every failing row', async () => {
  const out = join(TMP, 'index.html');
  const { code, stderr } = await run([
    '--live', join(TMP, 'live'), '--new', join(TMP, 'new'), '--diff', join(TMP, 'diff', 'diff.json'),
    '--styles', join(TMP, 'styles.json'), '--out', out,
  ]);
  assert.equal(code, 0, stderr);
  const html = readFileSync(out, 'utf8');
  assert.match(html, /^<!doctype html>/i);
  const images = html.match(/<img\b/g) ?? [];
  assert.equal(images.length, liveManifest.length + newManifest.length + diff.length);
  assert.ok(!/<img[^>]+src="(?!data:)/.test(html), 'every image is inlined');
  const failingRows = diff.filter((d) => !d.pass).length + styles.filter((s) => !s.pass).length;
  const fails = withoutDataUris(html).match(/\bFAIL\b/g) ?? [];
  assert.equal(fails.length, failingRows);
  assert.match(html, /3\.25\s*%/);
  assert.match(html, /margin-top/);
  assert.doesNotMatch(html, /line-height/, 'passing style rows are not listed');
  assert.equal((html.match(/style only/g) ?? []).length, 1, 'only the route without screenshots is style only');
  assert.match(html, /<h2><code>blog<\/code><\/h2>/);
  const rowsOf = (route) => withoutDataUris(html).split('<section>').find((s) => s.includes(`<h2><code>${route}</code></h2>`))
    .split('<div class="row').slice(1);
  const about1440 = rowsOf('about').find((row) => /<h3>1440 px/.test(row));
  assert.match(about1440, /<img\b/, 'the about 1440 row has its screenshots');
  assert.match(about1440, /font-size/, 'its style failures sit beneath the pair');
  assert.match(about1440, /margin-top/);
  const home390 = rowsOf('home').find((row) => /<h3>390 px/.test(row));
  assert.match(home390, /<img\b/);
  assert.match(home390, /rgb\(178, 60, 40\)/);
  const blog = rowsOf('blog');
  assert.equal(blog.length, 1);
  assert.match(blog[0], /style only/);
  assert.doesNotMatch(blog[0], /<img\b/);
  assert.doesNotMatch(html, /NaN/);
  assert.match(html, /n\/a/);
  assert.doesNotMatch(html, /href="data:/, 'each image is embedded once');
  assert.equal((html.match(/data:image\/png;base64,/g) ?? []).length, images.length);
});

test('without --styles the sheet still renders, failing diff rows only', async () => {
  const out = join(TMP, 'plain.html');
  const { code } = await run([
    '--live', join(TMP, 'live'), '--new', join(TMP, 'new'), '--diff', join(TMP, 'diff', 'diff.json'), '--out', out,
  ]);
  assert.equal(code, 0);
  const html = withoutDataUris(readFileSync(out, 'utf8'));
  assert.equal((html.match(/\bFAIL\b/g) ?? []).length, 1);
});
