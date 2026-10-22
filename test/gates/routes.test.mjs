import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';

let root;
let baseline;
let good;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'routes-gate-'));
  baseline = await buildFixtureBaseline(root);
  good = makeDist(join(root, 'dist-good'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const routes = (dist, args = []) => runGate('routes', ['--dist', dist, '--baseline', baseline, ...args], { cwd: root });

// 13 pages answering 200 plus the /feed/ feed; the brochure PDF is a file route for the media gate.
test('dist-good passes: every page and the feed is built, nothing extra', async () => {
  const result = await routes(good);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^routes: 14 checked, 0 failed$/m);
});

test('dist-bad fails and lists the missing and the extra page', async () => {
  const bad = makeDist(join(root, 'dist-bad'), { bad: ['missing-page', 'extra-page'] });
  const result = await routes(bad);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/hidden-page\/ file: expected "hidden-page\/index\.html", got null/);
  assert.match(result.stdout, /\/extra-page\/ extra: expected null, got "extra-page\/index\.html"/);
  assert.match(result.stdout, /^routes: 14 checked, 2 failed$/m);
});

test('--allow-extra accepts a listed extra path', async () => {
  const extra = makeDist(join(root, 'dist-extra'), { bad: ['extra-page'] });
  assert.equal((await routes(extra)).code, 1);
  const allowed = await routes(extra, ['--allow-extra', '/extra-page/']);
  assert.equal(allowed.code, 0, allowed.stdout);
});

test('a noindex route that lost its robots meta fails', async () => {
  const dist = makeDist(join(root, 'dist-noindex'), { bad: ['lost-noindex'] });
  const result = await routes(dist);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/private-page\/ robots: expected "noindex", got null/);
});

test('a build.format "file" build is read as <path>.html', async () => {
  const dist = makeDist(join(root, 'dist-file'), { bad: ['file-format'] });
  const result = await routes(dist);
  assert.equal(result.code, 0, result.stdout);
  const missing = makeDist(join(root, 'dist-file-missing'), { bad: ['file-format'] });
  rmSync(join(missing, 'about.html'));
  const failed = await routes(missing);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\/about\/ file: expected "about\.html", got null/);
});

test('--paths limits the check', async () => {
  const bad = makeDist(join(root, 'dist-bad-paths'), { bad: ['missing-page'] });
  const result = await routes(bad, ['--paths', '/about/,/services/*']);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /routes: 4 checked, 0 failed/);
});

test('--json prints the gate summary', async () => {
  const bad = makeDist(join(root, 'dist-bad-json'), { bad: ['extra-page'] });
  const result = await routes(bad, ['--json']);
  assert.equal(result.code, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.gate, 'routes');
  assert.equal(summary.failed, 1);
  assert.equal(summary.failures[0].path, '/extra-page/');
});

test('usage and missing inputs exit 2; --help exits 0', async () => {
  assert.equal((await routes(good, ['--bogus'])).code, 2);
  assert.equal((await runGate('routes', ['--dist', join(root, 'nope'), '--baseline', baseline], { cwd: root })).code, 2);
  assert.equal((await runGate('routes', ['--dist', good, '--baseline', join(root, 'nope')], { cwd: root })).code, 2);
  const help = await runGate('routes', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--allow-extra/);
});
