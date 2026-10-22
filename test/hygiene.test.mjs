import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HYGIENE = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hygiene.mjs');

// Forbidden strings are assembled at runtime so this file passes the check itself.
const BANNED_WORD = ['pers', 'ist'].join('');
const BANNED_EMAIL = `someone@${BANNED_WORD}.test`;
const TRAILER = ['Co', 'Authored', 'By'].join('-');

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# Clean\n\nContact: hello@example.com\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'chore: initial');
  return dir;
}

function addFile(dir, path, content = 'x\n') {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
  git(dir, 'add', '-f', path);
}

function run(...args) {
  return spawnSync(process.execPath, [HYGIENE, ...args], { encoding: 'utf8' });
}

test('a clean repo passes with exit 0', (t) => {
  const dir = makeRepo(t);
  const result = run('--dir', dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('a banned email in a file and a trailer in a commit fail with both listed', (t) => {
  const dir = makeRepo(t);
  addFile(dir, 'notes/contact.txt', `Write to ${BANNED_EMAIL}\n`);
  git(dir, 'commit', '-q', '-m', `feat: add notes\n\n${TRAILER}: X`);
  const hash = git(dir, 'rev-parse', 'HEAD');
  const result = run('--dir', dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /notes\/contact\.txt/);
  assert.ok(result.stdout.includes(hash), `expected ${hash} in:\n${result.stdout}`);
});

for (const trailer of ['Claude-Session', 'Signed-off-by']) {
  test(`a commit containing ${trailer} fails`, (t) => {
    const dir = makeRepo(t);
    addFile(dir, 'a.txt');
    git(dir, 'commit', '-q', '-m', `chore: a\n\n${trailer}: someone`);
    const hash = git(dir, 'rev-parse', 'HEAD');
    const result = run('--dir', dir);
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes(hash));
  });
}

for (const word of [BANNED_WORD, ['Plas', 'tix'].join(''), ['EVER', 'GREEN'].join(''), ['higher', 'pay'].join('')]) {
  test(`the word ${word} in a tracked file fails`, (t) => {
    const dir = makeRepo(t);
    addFile(dir, 'src/page.html', `<p>Built by ${word} for you.</p>\n`);
    const result = run('--dir', dir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /src\/page\.html/);
  });
}

test('ordinary words that start with a banned word pass', (t) => {
  const dir = makeRepo(t);
  addFile(dir, 'a.txt', `Settings are ${BANNED_WORD}ent; ${BANNED_WORD}ence pays.\n`);
  const result = run('--dir', dir);
  assert.equal(result.status, 0, result.stdout);
});

for (const path of [
  'docs/superpowers/x.md',
  '.superpowers/plan.md',
  '.agents/sessions/a.md',
  'node_modules/pkg/index.js',
  'packages/a/node_modules/b.js',
  '.env',
  '.env.local',
  'test/fixture/shot.png',
]) {
  test(`tracking ${path} fails`, (t) => {
    const dir = makeRepo(t);
    addFile(dir, path);
    const result = run('--dir', dir);
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes(path), result.stdout);
  });
}

test('a png under docs/examples/ passes', (t) => {
  const dir = makeRepo(t);
  addFile(dir, 'docs/examples/before.png', 'not really a png\n');
  const result = run('--dir', dir);
  assert.equal(result.status, 0, result.stdout);
});

test('untracked, gitignored planning material is not checked', (t) => {
  const dir = makeRepo(t);
  writeFileSync(join(dir, '.gitignore'), 'docs/superpowers/\n');
  git(dir, 'add', '.gitignore');
  git(dir, 'commit', '-q', '-m', 'chore: ignore planning');
  mkdirSync(join(dir, 'docs', 'superpowers'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'superpowers', 'x.md'), `${BANNED_EMAIL}\n`);
  const result = run('--dir', dir);
  assert.equal(result.status, 0, result.stdout);
});

test('--help prints usage and exits 0', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--dir/);
});

test('a missing --dir is a usage error with exit 2', () => {
  const result = run();
  assert.equal(result.status, 2);
});

test('a directory that is not a git repo exits 2', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-nogit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = run('--dir', dir);
  assert.equal(result.status, 2);
});
