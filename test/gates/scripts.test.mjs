import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { edit, makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';

let root;
let baseline;
let good;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'scripts-gate-'));
  baseline = await buildFixtureBaseline(root);
  good = makeDist(join(root, 'dist-good'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const scripts = (dist, args = [], base = baseline) => runGate('scripts', ['--dist', dist, '--baseline', base, ...args], { cwd: root });

// A copy of the baseline with scripts.json changed by `change(scripts)`.
function baselineWith(name, change) {
  const copy = join(root, name);
  cpSync(baseline, copy, { recursive: true });
  const file = join(copy, 'scripts.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  change(json);
  writeFileSync(file, JSON.stringify(json));
  return copy;
}

// 14 built pages; GA4 and GTM on each of the 13 pages the live site served at 200.
test('dist-good passes: GA4 and GTM are on every page they were on, with the same ids', async () => {
  const result = await scripts(good);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^scripts: 14 checked, 0 failed$/m);
});

test('a dropped GA4 tag fails on that page', async () => {
  const bad = makeDist(join(root, 'dist-no-ga4'), { bad: ['dropped-ga4'] });
  const result = await scripts(bad);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/about\/ ga4: expected "G-FIXTURE1", got null$/m);
  assert.match(result.stdout, /^scripts: 14 checked, 1 failed$/m);
});

test('a vendor the live site did not have fails', async () => {
  const bad = makeDist(join(root, 'dist-hotjar'), { bad: ['added-vendor'] });
  const result = await scripts(bad);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/about\/ hotjar: expected null, got "1234567"$/m);
});

test('a vendor with keep: false must be gone from every page', async () => {
  const dropped = baselineWith('baseline-drop-gtm', (json) => {
    json.gtm.keep = false;
  });
  const result = await scripts(good, [], dropped);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/contact\/ gtm: expected null, got "GTM-FIXTURE"$/m);
  assert.match(result.stdout, /^scripts: 14 checked, 14 failed$/m);
  const bad = makeDist(join(root, 'dist-no-ga4-dropped'), { bad: ['dropped-ga4'] });
  const kept = await scripts(bad, ['--paths', '/about/'], baselineWith('baseline-drop-ga4', (json) => {
    json.ga4.keep = false;
  }));
  assert.equal(kept.code, 0, kept.stdout);
});

test('a kept vendor with a different id fails', async () => {
  const changed = baselineWith('baseline-ga4-id', (json) => {
    json.ga4.id = 'G-LIVE0001';
    json.ga4.ids = ['G-LIVE0001'];
  });
  const result = await scripts(good, ['--paths', '/about/'], changed);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/about\/ ga4: expected "G-LIVE0001", got "G-FIXTURE1"/);
});

test('a kept vendor on a live page it was never on fails; 404.html may carry it', async () => {
  const narrowed = baselineWith('baseline-gtm-narrow', (json) => {
    json.gtm.pages = json.gtm.pages.filter((p) => p !== '/about/');
  });
  const result = await scripts(good, [], narrowed);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/about\/ gtm: expected null, got "GTM-FIXTURE"$/m);
  assert.match(result.stdout, /^scripts: 14 checked, 1 failed$/m, 'only /about/: 404.html is not a live 200 page');
});

test('the ids are compared as a set: a live id missing from the build fails', async () => {
  const two = baselineWith('baseline-ga4-two-ids', (json) => {
    json.ga4.ids = ['G-FIXTURE1', 'G-SECOND01'];
  });
  const result = await scripts(good, [], two);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\* ga4 ids: expected \["G-FIXTURE1","G-SECOND01"\], got \["G-FIXTURE1"\]$/m);
  const extra = makeDist(join(root, 'dist-two-ga4'));
  edit(extra, 'about/index.html', '</head>', "<script>gtag('config', 'G-SECOND01');</script>\n</head>");
  const perPage = await scripts(extra, ['--paths', '/about/']);
  assert.equal(perPage.code, 1);
  assert.match(perPage.stdout, /\/about\/ ga4: expected "G-FIXTURE1", got \["G-FIXTURE1","G-SECOND01"\]/);
});

test('usage and missing inputs exit 2; --help exits 0', async () => {
  assert.equal((await scripts(good, ['--bogus'])).code, 2);
  assert.equal((await runGate('scripts', ['--dist', good, '--baseline', join(root, 'nope')], { cwd: root })).code, 2);
  const help = await runGate('scripts', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /keep/);
});
