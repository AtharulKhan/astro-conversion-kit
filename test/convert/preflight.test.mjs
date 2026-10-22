import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFLIGHT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'skills', 'convert-site', 'scripts', 'preflight.mjs',
);
const SECRET = 'gho_FAKETOKEN0123456789';

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeBin(dir, name, script) {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
}

// A fake gh that is logged in and leaks a token on stdout, as `gh auth status -t` would.
function fakeGh(dir) {
  fakeBin(dir, 'gh', [
    'if [ "$1" = "--version" ]; then echo "gh version 2.70.0 (2026-01-01)"; exit 0; fi',
    `if [ "$1" = "auth" ]; then echo "Logged in to github.com account test (${SECRET})"; exit 0; fi`,
    'exit 1',
  ].join('\n'));
}

function run(args) {
  return spawnSync(process.execPath, [PREFLIGHT, ...args], { encoding: 'utf8', timeout: 30000 });
}

function runJson(args) {
  const result = run(['--json', ...args]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET), 'token leaked');
  return JSON.parse(result.stdout);
}

test('preflight --help exits 0', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node preflight\.mjs/);
});

test('preflight rejects unknown or incomplete flags with exit 2', () => {
  assert.equal(run(['--bogus']).status, 2);
  assert.equal(run(['--home']).status, 2);
});

test('fake gh is logged in, missing vercel is not present', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  fakeGh(bin);
  const report = runJson(['--home', home, '--path-env', bin]);
  assert.equal(report.node.version, process.versions.node);
  assert.equal(report.node.ok, true);
  assert.deepEqual(report.tools.gh, { present: true, version: '2.70.0', loggedIn: true });
  assert.deepEqual(report.tools.vercel, { present: false, version: null, loggedIn: false });
  assert.equal(report.tools.wrangler.present, false);
  assert.equal(report.tools.git.present, false);
  assert.equal(typeof report.playwright.chromium, 'boolean');
  assert.equal(report.signals.ghAuth, true);
  assert.equal(report.signals.repos, 0);
  assert.equal(report.experience, 'some');
});

test('experience is new with an empty --home and no logged-in tools', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  const report = runJson(['--home', home, '--path-env', bin]);
  assert.equal(report.experience, 'new');
  assert.deepEqual(report.signals, { repos: 0, ghAuth: false, dotfiles: 0 });
});

test('a CLI that says it is not authenticated is not logged in', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  fakeBin(bin, 'wrangler', [
    'if [ "$1" = "--version" ]; then echo "4.20.1"; exit 0; fi',
    'echo "You are not authenticated. Please run wrangler login."; exit 0',
  ].join('\n'));
  fakeBin(bin, 'vercel', [
    'if [ "$1" = "--version" ]; then echo "Vercel CLI 44.2.0"; exit 0; fi',
    'echo "Error: not logged in" >&2; exit 1',
  ].join('\n'));
  const report = runJson(['--home', home, '--path-env', bin]);
  assert.deepEqual(report.tools.wrangler, { present: true, version: '4.20.1', loggedIn: false });
  assert.deepEqual(report.tools.vercel, { present: true, version: '44.2.0', loggedIn: false });
});

test('a hanging login probe times out instead of blocking', { timeout: 30000 }, (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  // Not exec: the sleep is a grandchild holding the output pipe, so the whole group must die.
  fakeBin(bin, 'vercel', 'if [ "$1" = "--version" ]; then echo "44.2.0"; exit 0; fi\n/bin/sleep 60\nexit 0');
  const started = Date.now();
  const report = runJson(['--home', home, '--path-env', bin]);
  const elapsed = Date.now() - started;
  assert.equal(report.tools.vercel.present, true);
  assert.equal(report.tools.vercel.loggedIn, false);
  assert.ok(elapsed >= 9000, `probe returned before the 10 s timeout (${elapsed} ms)`);
  assert.ok(elapsed < 20000, `probe did not time out (${elapsed} ms)`);
});

test('ten git repos under --home plus gh login is experienced; dotfiles counted', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  fakeGh(bin);
  for (let i = 0; i < 10; i += 1) mkdirSync(join(home, `repo-${i}`, '.git'), { recursive: true });
  mkdirSync(join(home, 'not-a-repo', 'nested', '.git'), { recursive: true });
  writeFileSync(join(home, '.gitconfig'), '[user]\n');
  mkdirSync(join(home, '.ssh'));
  const report = runJson(['--home', home, '--path-env', bin]);
  assert.equal(report.signals.repos, 10);
  assert.equal(report.signals.dotfiles, 2);
  assert.equal(report.experience, 'experienced');
});

test('ten repos without gh login is some', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  for (let i = 0; i < 10; i += 1) mkdirSync(join(home, `repo-${i}`, '.git'), { recursive: true });
  assert.equal(runJson(['--home', home, '--path-env', bin]).experience, 'some');
});

test('human output summarises and never contains the token', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  fakeGh(bin);
  const result = run(['--home', home, '--path-env', bin]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gh\s+2\.70\.0\s+logged in/);
  assert.match(result.stdout, /Experience: some/);
  assert.ok(!result.stdout.includes(SECRET));
});
