import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { DIST_ORIGIN, makeDist } from './fixtures/make-dist.mjs';
import { gateScript, runGate } from './fixtures/run-gate.mjs';

const GATES = readdirSync(dirname(gateScript('run-all')))
  .filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs')
  .sort();

let root;
let baseline;
let good;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'run-all-'));
  baseline = await buildFixtureBaseline(root);
  good = makeDist(join(root, 'dist-good'));
  // The redirects gate reads the host config compiled from the redirects.csv beside the baseline. A
  // vercel.json is what the headers gate reads too, so it carries the staging headers of dist/_headers.
  const all = ['X-Content-Type-Options: nosniff', 'Referrer-Policy: strict-origin-when-cross-origin', 'X-Frame-Options: SAMEORIGIN', 'X-Robots-Tag: noindex'];
  const headers = all.map((line) => ({ key: line.split(': ')[0], value: line.split(': ')[1] }));
  writeFileSync(join(root, 'vercel.json'), JSON.stringify({ headers: [{ source: '/(.*)', headers }] }));
  const compiler = fileURLToPath(new URL('../../skills/parity-gates/scripts/build-redirects.mjs', import.meta.url));
  execFileSync(process.execPath, [compiler, '--host', 'vercel'], { cwd: root, stdio: 'ignore' });
});
after(() => rmSync(root, { recursive: true, force: true }));

// The fixture build keeps the live form action, and its _headers say noindex (a staging build).
const runAll = (dist, args = []) =>
  runGate('run-all', ['--dist', dist, '--baseline', baseline, '--endpoint', '/contact/', ...args], { cwd: root, env: { PUBLIC_INDEXABLE: '' } });

test('runs every gate in order and prints All N gates passed', async () => {
  // Each gate gets only the options it accepts: --origin is seo's, links' and sitemaps',
  // --allow-extra is routes', --endpoint is forms'.
  const result = await runAll(good, ['--origin', DIST_ORIGIN, '--allow-extra', '/nothing/']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const order = [...result.stdout.matchAll(/^([\w-]+): \d+ checked/gm)].map((m) => `${m[1]}.mjs`);
  assert.deepEqual(order, GATES);
  assert.match(result.stdout, new RegExp(`^All ${GATES.length} gates passed$`, 'm'));
});

test('stops at the first failing gate with its exit code', async () => {
  const bad = makeDist(join(root, 'dist-bad'), { bad: ['changed-title'] });
  const result = await runAll(bad, ['--origin', DIST_ORIGIN]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^routes: \d+ checked, 0 failed$/m);
  assert.match(result.stdout, /^seo: \d+ checked, 1 failed$/m);
  assert.doesNotMatch(result.stdout, /^text:/m);
  assert.doesNotMatch(result.stdout, /gates passed/);
});

test('an option no gate accepts exits 2; --help exits 0', async () => {
  assert.equal((await runAll(good, ['--bogus'])).code, 2);
  const help = await runGate('run-all', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: run-all/);
});
