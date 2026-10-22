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
const CAP_NAME = ['Pers', 'ist'].join('');
const EVER = ['ever', 'green'].join('');
const CAP_EVER = ['Ever', 'green'].join('');
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
  test(`a commit with a ${trailer} trailer line fails`, (t) => {
    const dir = makeRepo(t);
    addFile(dir, 'a.txt');
    git(dir, 'commit', '-q', '-m', `chore: a\n\n${trailer}: someone`);
    const hash = git(dir, 'rev-parse', 'HEAD');
    const result = run('--dir', dir);
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes(hash));
  });
}

test('a subject that only mentions a trailer name passes', (t) => {
  const dir = makeRepo(t);
  addFile(dir, 'a.txt');
  git(dir, 'commit', '-q', '-m', 'fix: reject Signed-off-by trailers');
  const result = run('--dir', dir);
  assert.equal(result.status, 0, result.stdout);
});

test('a banned name in a commit message fails, an email there does not', (t) => {
  const dir = makeRepo(t);
  addFile(dir, 'a.txt');
  git(dir, 'commit', '-q', '-m', `chore: mail ${['someone', 'elsewhere.test'].join('@')}`);
  const clean = run('--dir', dir);
  assert.equal(clean.status, 0, clean.stdout);
  addFile(dir, 'b.txt');
  git(dir, 'commit', '-q', '-m', `chore: port the ${CAP_NAME} Marketing footer`);
  const hash = git(dir, 'rev-parse', 'HEAD');
  const result = run('--dir', dir);
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes(hash), result.stdout);
});

const FAILING_TEXT = [
  `${CAP_NAME} Marketing`,
  `${BANNED_WORD}-marketing`,
  `${BANNED_WORD}marketing.com`,
  `${BANNED_WORD}.io`,
  `follow @${BANNED_WORD} on social`,
  `${CAP_EVER} Private Care`,
  `${EVER}privatecare.com`,
  `${EVER}-private-care`,
  ['Plas', 'tix'].join(''),
  ['PLAS', 'TIX'].join(''),
  ['plas', 'tixmarketing'].join(''),
  ['Higher', 'Pay'].join(''),
];
for (const text of FAILING_TEXT) {
  test(`"${text}" in a tracked file fails`, (t) => {
    const dir = makeRepo(t);
    addFile(dir, 'src/page.html', `<p>Built by ${text} for you.</p>\n`);
    const result = run('--dir', dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /src\/page\.html/);
  });
}

const PASSING_TEXT = [
  `const ${BANNED_WORD}entContext = true;`,
  `the value ${BANNED_WORD}ed`,
  `state ${BANNED_WORD}s across runs`,
  `${BANNED_WORD}ency matters`,
  `write ${EVER} content`,
  'logo@2x.png and hero@3x.webp',
  'git@github.com:owner/repo.git',
  'version pkg@1.2.3',
];
for (const text of PASSING_TEXT) {
  test(`"${text}" in a tracked file passes`, (t) => {
    const dir = makeRepo(t);
    addFile(dir, 'a.txt', `${text}\n`);
    const result = run('--dir', dir);
    assert.equal(result.status, 0, result.stdout);
  });
}

// Built at runtime so this file passes the check itself.
for (const text of [['ops', 'team.example.org'].join('@'), ['user', 'mail.test.io'].join('@')]) {
  test(`the email ${text} fails`, (t) => {
    const dir = makeRepo(t);
    addFile(dir, 'a.txt', `${text}\n`);
    const result = run('--dir', dir);
    assert.equal(result.status, 1, result.stdout);
  });
}

for (const path of [
  'docs/superpowers/x.md',
  '.superpowers/plan.md',
  '.agents/sessions/a.md',
  'node_modules/pkg/index.js',
  'packages/a/node_modules/b.js',
  '.env',
  '.env.local',
  '.env.production',
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

for (const path of ['.env.example', '.env.sample', 'site/.env.example']) {
  test(`tracking ${path} passes`, (t) => {
    const dir = makeRepo(t);
    addFile(dir, path);
    const result = run('--dir', dir);
    assert.equal(result.status, 0, result.stdout);
  });
}

test('--dir pointing at a subdirectory checks the whole repo', (t) => {
  const dir = makeRepo(t);
  addFile(dir, 'docs/superpowers/x.md');
  addFile(dir, 'docs/readme.md');
  const result = run('--dir', join(dir, 'docs'));
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('docs/superpowers/x.md'), result.stdout);
});

test('a repo with no commits yet passes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  git(dir, 'add', 'a.txt');
  const result = run('--dir', dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /0 commits/);
});

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
