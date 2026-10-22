import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

let dir;
let templates;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'templates-test-'));
  const fixture = await startFixture();
  try {
    // --no-rest keeps the page set to what the crawl links to (12 pages answering 200).
    const crawl = await run('capture.mjs', [fixture.origin, '--out', dir, '--delay', '0', '--no-rest']);
    assert.equal(crawl.code, 0, crawl.stderr);
  } finally {
    await fixture.close();
  }
  const result = await run('templates.mjs', ['--capture', dir]);
  assert.equal(result.code, 0, result.stderr);
  templates = JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf8'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('the fixture clusters into home, page, single-post and archive', () => {
  const counts = Object.fromEntries(templates.map((t) => [t.name, t.count]));
  assert.deepEqual(counts, { home: 1, page: 6, 'single-post': 3, archive: 2 });
  const byName = Object.fromEntries(templates.map((t) => [t.name, t]));
  assert.deepEqual(byName.home.paths, ['/']);
  assert.deepEqual(byName.archive.paths, ['/blog/', '/category/news/']);
  assert.deepEqual(byName['single-post'].paths, ['/choosing-siding-colors/', '/spring-roof-checklist/', '/storm-season-prep/']);
  assert.deepEqual(byName.page.paths, ['/about/', '/contact/', '/hidden-page/', '/services/', '/services/roofing/', '/services/siding/']);
  for (const t of templates) assert.equal(t.count, t.paths.length);
  assert.ok(!templates.some((t) => t.paths.includes('/deleted-post/')), 'a 404 is not a template');
});

test('the representative is the path with the median word count', () => {
  const inventory = JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8'));
  const words = Object.fromEntries(inventory.map((r) => [r.path, r.wordCount]));
  for (const t of templates) {
    assert.ok(t.paths.includes(t.representative), `${t.name}: ${t.representative}`);
    const sorted = t.paths.map((p) => words[p]).sort((a, b) => a - b);
    assert.equal(words[t.representative], sorted[Math.floor((sorted.length - 1) / 2)], t.name);
  }
});

test('signatures drop per-page classes and keep the markup under main', () => {
  for (const t of templates) {
    assert.doesNotMatch(t.signature, /page-id-|postid-|term-/);
  }
  const post = templates.find((t) => t.name === 'single-post');
  assert.match(post.signature, /single-post/);
  assert.match(post.signature, /article header h1/);
});

test('pages without platform classes merge by markup and are numbered', () => {
  const main = (inner) => `<html><body><main>${inner}</main></body></html>`;
  const long = '<p>a</p>'.repeat(9);
  const pages = [
    { path: '/a/', wordCount: 10, bodyClasses: ['layout-x'], html: main(`<h1>A</h1>${long}`) },
    // One extra element at the end: 11 shared tokens of 12, Jaccard 0.92, merged with /a/.
    { path: '/b/', wordCount: 30, bodyClasses: ['layout-x'], html: main(`<h1>B</h1>${long}<img>`) },
    { path: '/c/', wordCount: 20, bodyClasses: ['layout-x'], html: main(`<h1>C</h1>${long}`) },
    { path: '/d/', wordCount: 5, bodyClasses: ['other'], html: '<html><body><section><form><input></form></section></body></html>' },
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

test('names are safe folder names', () => {
  for (const t of templates) assert.match(t.name, /^[a-z0-9][a-z0-9-]*$/);
});
