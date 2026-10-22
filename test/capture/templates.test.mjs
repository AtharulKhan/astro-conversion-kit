import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';
import { clusterPages } from '../../skills/capture-site/scripts/templates.mjs';

const exec = promisify(execFile);
const script = (name) => fileURLToPath(new URL(`../../skills/capture-site/scripts/${name}`, import.meta.url));

async function run(name, args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script(name), ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}
const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));

let dir;
let other;
let templates;
let otherTemplates;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'templates-test-'));
  other = mkdtempSync(join(tmpdir(), 'templates-other-test-'));
  const fixture = await startFixture();
  try {
    // --no-rest keeps the page set to what the crawl links to (12 pages answering 200).
    const crawl = await run('capture.mjs', [fixture.origin, '--out', dir, '--delay', '0', '--no-rest', '--no-wayback']);
    assert.equal(crawl.code, 0, crawl.stderr);
  } finally {
    await fixture.close();
  }
  // The same records, as if the fingerprint had not recognised the platform.
  cpSync(dir, other, { recursive: true });
  const state = readJson(other, 'state.json');
  state.fingerprint.platform = 'unknown';
  writeFileSync(join(other, 'state.json'), JSON.stringify(state));

  for (const d of [dir, other]) {
    const result = await run('templates.mjs', ['--capture', d]);
    assert.equal(result.code, 0, result.stderr);
  }
  templates = readJson(dir, 'templates.json');
  otherTemplates = readJson(other, 'templates.json');
});
after(() => {
  for (const d of [dir, other]) rmSync(d, { recursive: true, force: true });
});

const partition = (list) => list.map((t) => t.paths.join(' ')).sort();

// Measured on the fixture. Tier 1 (WordPress): the page group's main page is
// /services/roofing/; /about/ 0.78, /hidden-page/ 0.75, /services/siding/ 0.75, /services/ 0.53
// stay, /contact/ 0.27 splits off as page-2. single-post main /storm-season-prep/:
// /choosing-siding-colors/ 0.93, /spring-roof-checklist/ 0.76. archive: /category/news/ 0.88 to /blog/.
test('the fixture clusters by WordPress template, splitting off only the form page', () => {
  const byName = Object.fromEntries(templates.map((t) => [t.name, t.paths]));
  assert.deepEqual(byName, {
    page: ['/about/', '/hidden-page/', '/services/', '/services/roofing/', '/services/siding/'],
    'single-post': ['/choosing-siding-colors/', '/spring-roof-checklist/', '/storm-season-prep/'],
    archive: ['/blog/', '/category/news/'],
    home: ['/'],
    'page-2': ['/contact/'],
  });
  assert.deepEqual(templates.map((t) => t.count), [5, 3, 2, 1, 1]);
  for (const t of templates) assert.equal(t.count, t.paths.length);
  assert.ok(!templates.some((t) => t.paths.includes('/deleted-post/')), 'a 404 is not a template');
});

test('no template mixes pages of different WordPress templates', () => {
  const inventory = readJson(dir, 'inventory.json');
  const classes = Object.fromEntries(inventory.map((r) => [r.path, r.bodyClasses]));
  for (const t of templates) {
    const base = t.name.replace(/-\d+$/, '');
    for (const path of t.paths) assert.ok(classes[path].includes(base), `${path} in ${t.name}`);
    if (base === 'page') for (const path of t.paths) assert.ok(!classes[path].includes('home'), `${path} in ${t.name}`);
  }
});

// Tier 2 on the same records (class tokens counted twice), seeds compared in order of
// appearance: /about/ takes /hidden-page/ 0.64, /services/roofing/ 0.82, /services/siding/ 0.80
// but not /services/ 0.59; the posts merge (0.77 to 0.94), the archives 0.79; /, /contact/ and
// /services/ stand alone.
test('without a WordPress fingerprint the same pages group by markup, numbered', () => {
  assert.deepEqual(
    otherTemplates.map((t) => [t.name, t.paths]),
    [
      ['template-1', ['/about/', '/hidden-page/', '/services/roofing/', '/services/siding/']],
      ['template-2', ['/choosing-siding-colors/', '/spring-roof-checklist/', '/storm-season-prep/']],
      ['template-3', ['/blog/', '/category/news/']],
      ['template-4', ['/']],
      ['template-5', ['/contact/']],
      ['template-6', ['/services/']],
    ],
  );
});

test('the representative is the path with the median word count', () => {
  const inventory = readJson(dir, 'inventory.json');
  const words = Object.fromEntries(inventory.map((r) => [r.path, r.wordCount]));
  for (const t of templates) {
    assert.ok(t.paths.includes(t.representative), `${t.name}: ${t.representative}`);
    const sorted = t.paths.map((p) => words[p]).sort((a, b) => a - b);
    assert.equal(words[t.representative], sorted[Math.floor((sorted.length - 1) / 2)], t.name);
  }
});

test('signatures drop per-page classes and keep the markup under main', () => {
  for (const t of templates) assert.doesNotMatch(t.signature, /page-id-|postid-|term-|category-|-\d+\b/);
  const post = templates.find((t) => t.name === 'single-post');
  assert.match(post.signature, /single-post/);
  assert.match(post.signature, /article header h1/);
});

const main = (inner) => `<html><body><main>${inner}</main></body></html>`;
const page = (path, bodyClasses, html, wordCount = 10) => ({ path, wordCount, bodyClasses, html });

test('pages without platform classes merge by markup and are numbered', () => {
  const long = '<p>a</p>'.repeat(9);
  const pages = [
    page('/a/', ['layout-x'], main(`<h1>A</h1>${long}`), 10),
    // One extra element: class tokens count twice, so 12 shared tokens of 13, merged with /a/.
    page('/b/', ['layout-x'], main(`<h1>B</h1>${long}<img>`), 30),
    page('/c/', ['layout-x'], main(`<h1>C</h1>${long}`), 20),
    page('/d/', ['other'], '<html><body><section><form><input></form></section></body></html>', 5),
  ];
  const clusters = clusterPages(pages);
  assert.deepEqual(
    clusters.map((c) => ({ name: c.name, count: c.count, representative: c.representative, paths: c.paths })),
    [
      { name: 'template-1', count: 3, representative: '/c/', paths: ['/a/', '/b/', '/c/'] },
      { name: 'template-2', count: 1, representative: '/d/', paths: ['/d/'] },
    ],
  );
  assert.match(clusters[1].signature, /section form input/, 'falls back to body without main');
});

test('within a WordPress template only clearly different markup splits off', () => {
  const classes = (id) => ['page-template-default', 'page', `page-id-${id}`];
  const wp = { platform: 'wordpress' };
  const form = main('<h1>A</h1><form><label></label><input><input><textarea></textarea><button></button></form>');
  const table = main('<h2>B</h2><table><thead><tr><th></th></tr></thead><tbody><tr><td></td></tr></tbody></table>');
  const apart = clusterPages([page('/form/', classes(1), form), page('/table/', classes(2), table)], wp);
  assert.deepEqual(apart.map((c) => [c.name, c.paths]), [['page', ['/form/']], ['page-2', ['/table/']]]);

  // 9 shared tokens of 15: Jaccard 0.6, below a markup merge but well above the 0.5 split.
  const text = main(`<h1>A</h1>${'<p>a</p>'.repeat(9)}`);
  const gallery = main(`<h1>B</h1>${'<p>a</p>'.repeat(6)}<img><img><img>`);
  const together = clusterPages([page('/one/', classes(1), text), page('/two/', classes(2), gallery)], wp);
  assert.deepEqual(together.map((c) => [c.name, c.paths]), [['page', ['/one/', '/two/']]]);

  // A different page template class is a different template, however alike the markup.
  const full = ['page-template-full-width', 'page', 'page-id-3'];
  const split = clusterPages([page('/one/', classes(1), text), page('/wide/', full, text)], wp);
  assert.deepEqual(split.map((c) => [c.name, c.paths]), [['page', ['/one/']], ['page-2', ['/wide/']]]);
});

test('per-page classes and svg, script, style and noscript markup do not split a template', () => {
  const plain = main('<h1>A</h1><p></p>');
  const decorated = main('<h1>A</h1><svg><path></path><circle></circle></svg><script></script><style></style><noscript><img></noscript><p></p>');
  const one = ['page', 'page-id-3', 'parent-pageid-4', 'elementor-page-12', 'tag-roof', 'author-bob', 'paged-2', 'category-news', 'term-5', 'custom-17'];
  const two = ['page', 'page-id-8', 'parent-pageid-9', 'elementor-page-30', 'tag-gutter', 'author-ann', 'paged-3', 'category-tips', 'term-6', 'custom-18'];
  const clusters = clusterPages([page('/x/', one, plain), page('/y/', two, decorated)], { platform: 'wordpress' });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].signature, 'page | h1 p');
});

test('names are safe folder names', () => {
  for (const t of [...templates, ...otherTemplates]) assert.match(t.name, /^[a-z0-9][a-z0-9-]*$/);
});
