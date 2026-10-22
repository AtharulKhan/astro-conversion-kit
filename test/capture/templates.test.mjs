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
    const crawl = await run('capture.mjs', [fixture.origin, '--out', dir, '--delay', '0', '--no-rest']);
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

// Measured on the fixture (Jaccard of classes plus tag-name multiset): /blog/ and
// /category/news/ 0.88; /choosing-siding-colors/ and /storm-season-prep/ 0.93, the third post
// 0.72 and 0.76; the six pages at most 0.78 with each other; at most 0.38 across WordPress
// templates. So markup alone merges the archives and two of the posts and nothing else.
test('the fixture clusters by markup, named from its WordPress body classes', () => {
  const byName = Object.fromEntries(templates.map((t) => [t.name, t.paths]));
  assert.deepEqual(byName.archive, ['/blog/', '/category/news/']);
  assert.deepEqual(byName['single-post'], ['/choosing-siding-colors/', '/storm-season-prep/']);
  assert.deepEqual(byName['single-post-2'], ['/spring-roof-checklist/']);
  assert.deepEqual(byName.home, ['/']);
  const pages = templates.filter((t) => /^page(-\d+)?$/.test(t.name));
  assert.deepEqual(pages.map((t) => t.name).sort(), ['page', 'page-2', 'page-3', 'page-4', 'page-5', 'page-6']);
  assert.deepEqual(pages.flatMap((t) => t.paths).sort(), ['/about/', '/contact/', '/hidden-page/', '/services/', '/services/roofing/', '/services/siding/']);
  assert.equal(templates.length, 10);
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

test('without a WordPress fingerprint the same pages are numbered, not named', () => {
  for (const t of otherTemplates) assert.match(t.name, /^template-\d+$/);
  assert.deepEqual(partition(otherTemplates), partition(templates));
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
    // One extra element: 11 shared tokens of 12, Jaccard 0.92, merged with /a/.
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

test('a shared WordPress name never merges pages whose markup differs', () => {
  const classes = (id) => ['page-template-default', 'page', `page-id-${id}`];
  const form = main('<h1>A</h1><form><label></label><input><input><textarea></textarea><button></button></form>');
  const table = main('<h2>B</h2><table><thead><tr><th></th></tr></thead><tbody><tr><td></td></tr></tbody></table>');
  const apart = clusterPages([page('/form/', classes(1), form), page('/table/', classes(2), table)], { platform: 'wordpress' });
  assert.deepEqual(apart.map((c) => [c.name, c.paths]), [['page', ['/form/']], ['page-2', ['/table/']]]);

  const long = '<p>a</p>'.repeat(9);
  const alike = clusterPages(
    [page('/one/', classes(1), main(`<h1>A</h1>${long}`)), page('/two/', classes(2), main(`<h1>B</h1>${long}<img>`))],
    { platform: 'wordpress' },
  );
  assert.deepEqual(alike.map((c) => [c.name, c.paths]), [['page', ['/one/', '/two/']]]);
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
