import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { DIST_ORIGIN, edit, makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';

let root;
let baseline;
let good;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'links-gate-'));
  baseline = await buildFixtureBaseline(root);
  good = makeDist(join(root, 'dist-good'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const links = (dist, args = []) => runGate('links', ['--dist', dist, '--baseline', baseline, '--origin', DIST_ORIGIN, ...args], { cwd: root });

const record = (fields) => ({ reason: 'test', approvedBy: 'client', date: '2026-10-22', ...fields });
function writeRecords(name, records) {
  const file = join(root, name);
  writeFileSync(file, JSON.stringify(records));
  return file;
}

// 14 built pages, 404.html included; pages, media, the feed, _astro files and ?p= shortlinks resolve.
test('dist-good passes: every internal href and src resolves', async () => {
  const result = await links(good);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^links: 14 checked, 0 failed$/m);
});

test('a broken link fails and names the page and the href', async () => {
  const bad = makeDist(join(root, 'dist-broken'), { bad: ['broken-link'] });
  const result = await links(bad);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/about\/ link: expected "a built page, file, redirect source or media path", got "\/contact-us\/"$/m);
  assert.match(result.stdout, /^links: 14 checked, 1 failed$/m);
});

test('an unslashed internal link is reported', async () => {
  const bad = makeDist(join(root, 'dist-unslashed'), { bad: ['unslashed-link'] });
  const result = await links(bad);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/contact\/ link: expected "\/about\/", got "\/about"/);
});

test('an absolute link on the build origin is checked; one on another host is not', async () => {
  const dist = makeDist(join(root, 'dist-absolute'));
  edit(dist, 'about/index.html', '<a href="/contact/">', `<a href="${DIST_ORIGIN}/nowhere/">`);
  edit(dist, 'services/index.html', '<a href="/contact/">', '<a href="https://other.example.org/nowhere/">');
  const result = await links(dist);
  assert.equal(result.code, 1);
  assert.match(result.stdout, new RegExp(`/about/ link: .*got "${DIST_ORIGIN}/nowhere/"`));
  assert.doesNotMatch(result.stdout, /other\.example\.org/);
  assert.match(result.stdout, /^links: 14 checked, 1 failed$/m);
});

test('a missing media file or stylesheet is a broken src', async () => {
  const dist = makeDist(join(root, 'dist-missing-file'));
  rmSync(join(dist, '_astro', 'reveal.js'));
  const result = await links(dist, ['--paths', '/about/']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/about\/ link: .*got "\/_astro\/reveal\.js"/);
});

test('a build.format "file" build resolves page links to <path>.html', async () => {
  const dist = makeDist(join(root, 'dist-file'), { bad: ['file-format'] });
  const result = await links(dist);
  assert.equal(result.code, 0, result.stdout);
});

test('a link exception (to = the built href) passes; a stale one fails', async () => {
  const bad = makeDist(join(root, 'dist-broken-exception'), { bad: ['broken-link'] });
  const exceptions = writeRecords('link-exceptions.json', [record({ path: '/about/', field: 'link', from: '/contact/', to: '/contact-us/' })]);
  const passed = await links(bad, ['--exceptions', exceptions]);
  assert.equal(passed.code, 0, passed.stdout);
  const stale = await links(good, ['--exceptions', exceptions]);
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /\/about\/ exception: expected \{"field":"link","from":"\/contact\/","to":"\/contact-us\/"\}, got "no longer matches the build"/);
  const unchecked = writeRecords('link-unchecked.json', [record({ path: '/no-such-page/', field: 'link', from: '/a/', to: '/b/' })]);
  const notChecked = await links(good, ['--exceptions', unchecked]);
  assert.equal(notChecked.code, 1);
  assert.match(notChecked.stdout, /\/no-such-page\/ exception: .*"path not checked"/);
});

test('--paths limits the pages checked', async () => {
  const bad = makeDist(join(root, 'dist-broken-paths'), { bad: ['broken-link'] });
  const result = await links(bad, ['--paths', '/services/*']);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /^links: 3 checked, 0 failed$/m);
});

test('usage and missing inputs exit 2; --help exits 0', async () => {
  assert.equal((await links(good, ['--bogus'])).code, 2);
  assert.equal((await links(good, ['--origin', 'not a url'])).code, 2);
  assert.equal((await runGate('links', ['--dist', join(root, 'nope'), '--baseline', baseline], { cwd: root })).code, 2);
  assert.equal((await runGate('links', ['--dist', good, '--baseline', join(root, 'nope')], { cwd: root })).code, 2);
  const help = await runGate('links', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--origin/);
});
