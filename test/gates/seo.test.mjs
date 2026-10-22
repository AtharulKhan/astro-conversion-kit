import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { DIST_ORIGIN, makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';

let root;
let baseline;
let good;
let bad;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'seo-gate-'));
  baseline = await buildFixtureBaseline(root);
  good = makeDist(join(root, 'dist-good'));
  bad = makeDist(join(root, 'dist-bad'), { bad: ['missing-page', 'extra-page', 'changed-title', 'changed-h1', 'changed-paragraph'] });
});
after(() => rmSync(root, { recursive: true, force: true }));

const seo = (dist, args = [], env = {}) => runGate('seo', ['--dist', dist, '--baseline', baseline, ...args], { cwd: root, env });

const record = (fields) => ({ reason: 'test', approvedBy: 'client', date: '2026-10-22', ...fields });
function writeRecords(name, records) {
  const file = join(root, name);
  writeFileSync(file, JSON.stringify(records));
  return file;
}

test('dist-good passes with the site origin and with paths only', async () => {
  const withOrigin = await seo(good, ['--origin', DIST_ORIGIN]);
  assert.equal(withOrigin.code, 0, withOrigin.stdout + withOrigin.stderr);
  assert.match(withOrigin.stdout, /^seo: 13 checked, 0 failed$/m);
  const pathsOnly = await seo(good);
  assert.equal(pathsOnly.code, 0, pathsOnly.stdout);
});

test('a canonical on the wrong origin fails when --origin is given', async () => {
  const result = await seo(good, ['--origin', 'https://other.example.com', '--paths', '/about/']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/about\/ canonical: expected "https:\/\/other\.example\.com\/about\/", got "https:\/\/www\.example\.com\/about\/"/);
  assert.match(result.stdout, /\/about\/ og: /);
});

test('dist-bad fails and lists the title and the h1 per path', async () => {
  const result = await seo(bad, ['--origin', DIST_ORIGIN]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/about\/ title: expected "About Us \| Fixture Roofing & Siding", got "About \| Fixture Roofing & Siding"/);
  assert.match(result.stdout, /\/services\/ h1: expected \["Services"\], got \["Our services"\]/);
  assert.match(result.stdout, /\/hidden-page\/ page: /);
  assert.match(result.stdout, /^seo: 13 checked, 3 failed$/m);
});

test('an exception for the h1 makes that path pass', async () => {
  const exceptions = writeRecords('h1-exceptions.json', [record({ path: '/services/', field: 'h1', from: 'Services', to: 'Our services' })]);
  const one = await seo(bad, ['--paths', '/services/', '--exceptions', exceptions]);
  assert.equal(one.code, 0, one.stdout);
  const all = await seo(bad, ['--exceptions', exceptions]);
  assert.equal(all.code, 1);
  assert.doesNotMatch(all.stdout, /\/services\/ h1/);
  assert.match(all.stdout, /\/about\/ title/);
});

test('a title proposal counts only with PROPOSALS=on', async () => {
  const titleOnly = makeDist(join(root, 'dist-title'), { bad: ['changed-title'] });
  const proposals = writeRecords('title-proposals.json', [
    record({ path: '/about/', field: 'title', from: 'About Us | Fixture Roofing & Siding', to: 'About | Fixture Roofing & Siding' }),
  ]);
  assert.equal((await seo(titleOnly, ['--proposals', proposals])).code, 1);
  const on = await seo(titleOnly, ['--proposals', proposals], { PROPOSALS: 'on' });
  assert.equal(on.code, 0, on.stdout);
});

test('an exception that no longer matches is named on stderr', async () => {
  const exceptions = writeRecords('stale-exceptions.json', [record({ path: '/about/', field: 'h1', from: 'Old heading', to: 'About Us' })]);
  const result = await seo(good, ['--exceptions', exceptions, '--paths', '/about/']);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /stale exception: \/about\/ h1 "Old heading"/);
});

test('usage errors exit 2 and --help exits 0', async () => {
  assert.equal((await seo(good, ['--origin', 'not a url'])).code, 2);
  assert.equal((await seo(good, ['--bogus'])).code, 2);
  assert.equal((await seo(good, ['--exceptions', join(root, 'missing.json')])).code, 2);
  const help = await runGate('seo', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--origin/);
});
