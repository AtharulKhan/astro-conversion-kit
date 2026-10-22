import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gateArgs, builtPages, report } from '../../skills/parity-gates/scripts/lib/gate-cli.mjs';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'parity-gates', 'scripts', 'lib', 'gate-cli.mjs');

const EXTRA = {
  options: {
    endpoint: { type: 'string', description: 'form endpoint' },
    'allow-extra': { type: 'boolean' },
    host: { type: 'string', default: 'vercel' },
  },
};

function runArgs(argv, extra = {}) {
  const code = `import { gateArgs } from ${JSON.stringify(pathToFileURL(LIB).href)};
const args = gateArgs(${JSON.stringify(argv)}, 'demo-gate', ${JSON.stringify(extra)});
process.stdout.write(JSON.stringify(args));`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
}

test('gateArgs has defaults', () => {
  const args = gateArgs([], 'seo');
  assert.equal(args.dist, 'dist');
  assert.equal(args.baseline, 'baseline');
  assert.equal(args.exceptions, 'exceptions.json');
  assert.equal(args.proposals, 'proposals.json');
  assert.equal(args.json, false);
  assert.equal(args.paths('/anything/'), true);
});

test('gateArgs applies --paths /a/,/blog/*', () => {
  const args = gateArgs(['--paths', '/a/,/blog/*', '--dist', 'out', '--json'], 'seo');
  assert.equal(args.dist, 'out');
  assert.equal(args.json, true);
  assert.equal(args.paths('/a/'), true);
  assert.equal(args.paths('/a/b/'), false);
  assert.equal(args.paths('/blog/'), true);
  assert.equal(args.paths('/blog/first-post/'), true);
  assert.equal(args.paths('/about/'), false);
});

test('gateArgs --paths ignores trailing slashes', () => {
  const args = gateArgs(['--paths', '/about,/blog/*,/'], 'seo');
  assert.equal(args.paths('/about/'), true);
  assert.equal(args.paths('/about'), true);
  assert.equal(args.paths('/blog'), true);
  assert.equal(args.paths('/blog/post'), true);
  assert.equal(args.paths('/'), true);
  assert.equal(args.paths('/blogroll/'), false);
  assert.equal(args.paths('/contact/'), false);
});

test('gateArgs accepts --flag=value', () => {
  const args = gateArgs(['--baseline=capture', '--exceptions=ex.json', '--proposals=p.json'], 'seo');
  assert.equal(args.baseline, 'capture');
  assert.equal(args.exceptions, 'ex.json');
  assert.equal(args.proposals, 'p.json');
});

test('gateArgs takes gate-specific options, camelCased, with defaults', () => {
  const none = gateArgs([], 'forms', EXTRA);
  assert.equal(none.endpoint, undefined);
  assert.equal(none.allowExtra, undefined);
  assert.equal(none.host, 'vercel');
  assert.equal(none.dist, 'dist');

  const set = gateArgs(['--endpoint', 'https://forms.example.com/f', '--allow-extra', '--host=netlify'], 'forms', EXTRA);
  assert.equal(set.endpoint, 'https://forms.example.com/f');
  assert.equal(set.allowExtra, true);
  assert.equal(set.host, 'netlify');
});

test('gateArgs exits 2 on an unknown flag or a missing value, and lists custom options in --help', () => {
  const unknown = runArgs(['--nope'], EXTRA);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /--nope/);

  const missing = runArgs(['--dist'], EXTRA);
  assert.equal(missing.status, 2);

  const help = runArgs(['--help'], EXTRA);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: demo-gate/);
  assert.match(help.stdout, /--allow-extra/);
  assert.match(help.stdout, /--endpoint <value>\s+form endpoint/);
});

test('builtPages maps HTML files to URL paths', (t) => {
  const dist = mkdtempSync(join(tmpdir(), 'dist-'));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  mkdirSync(join(dist, 'about'));
  mkdirSync(join(dist, 'services', 'roofing'), { recursive: true });
  mkdirSync(join(dist, '_astro'));
  writeFileSync(join(dist, 'index.html'), '');
  writeFileSync(join(dist, '404.html'), '');
  writeFileSync(join(dist, 'about', 'index.html'), '');
  writeFileSync(join(dist, 'services', 'roofing', 'index.html'), '');
  writeFileSync(join(dist, '_astro', 'app.css'), '');
  assert.deepEqual(builtPages(dist), [
    { path: '/', file: join(dist, 'index.html') },
    { path: '/404.html', file: join(dist, '404.html') },
    { path: '/about/', file: join(dist, 'about', 'index.html') },
    { path: '/services/roofing/', file: join(dist, 'services', 'roofing', 'index.html') },
  ]);
});

function capture() {
  const chunks = [];
  let code = null;
  return {
    out: { write: (s) => chunks.push(s) },
    exit: (c) => {
      code = c;
    },
    text: () => chunks.join(''),
    code: () => code,
  };
}

test('report prints the summary and exits 0 when nothing failed', () => {
  const c = capture();
  report('seo', { checked: 3, failures: [] }, { out: c.out, exit: c.exit });
  assert.equal(c.text(), 'seo: 3 checked, 0 failed\n');
  assert.equal(c.code(), 0);
});

test('report lists failures and exits 1', () => {
  const c = capture();
  const failure = { path: '/about/', field: 'title', expected: 'About', actual: 'Aboot' };
  report('seo', { checked: 2, failures: [failure] }, { out: c.out, exit: c.exit });
  assert.match(c.text(), /^ {2}\/about\/ title: expected "About", got "Aboot"$/m);
  assert.match(c.text(), /^seo: 2 checked, 1 failed$/m);
  assert.equal(c.code(), 1);
});

test('report prints a diff with five words of context instead of the full text', () => {
  const c = capture();
  const before = 'one two three four five six seven eight';
  const after = 'nine ten eleven twelve thirteen fourteen fifteen sixteen';
  const failure = {
    path: '/',
    field: 'text',
    expected: `${before} old ${after}`,
    actual: `${before} new ${after}`,
    diff: [
      { op: 'equal', text: before },
      { op: 'delete', text: 'old' },
      { op: 'insert', text: 'new' },
      { op: 'equal', text: after },
    ],
  };
  report('text', { checked: 1, failures: [failure] }, { out: c.out, exit: c.exit });
  assert.match(
    c.text(),
    /^ {2}\/ text: \.\.\. four five six seven eight \[-old-\] \{\+new\+\} nine ten eleven twelve thirteen \.\.\.$/m,
  );
  assert.ok(!c.text().includes('one two'), 'full expected text is not printed');
  assert.ok(!c.text().includes('sixteen'), 'full actual text is not printed');
});

test('report json comes from options, not process.argv', () => {
  const c = capture();
  const failure = {
    path: '/',
    field: 'text',
    expected: 'a b',
    actual: 'a c',
    diff: [
      { op: 'equal', text: 'a' },
      { op: 'delete', text: 'b' },
      { op: 'insert', text: 'c' },
    ],
  };
  report('text', { checked: 1, failures: [failure] }, { json: true, out: c.out, exit: c.exit });
  assert.deepEqual(JSON.parse(c.text()), { gate: 'text', checked: 1, failed: 1, failures: [failure] });
  assert.equal(c.code(), 1);
});

test('report lists each skip in skips, counts them, and keeps the exit code', () => {
  const skips = [{ from: '/?p=2', reason: 'noop: destination equals source path' }];
  const text = capture();
  report('redirects', { checked: 2, failures: [], skipped: 1, skipReason: 'noop', skips }, { out: text.out, exit: text.exit });
  assert.equal(text.text(), '  /?p=2 skipped: noop: destination equals source path\nredirects: 2 checked, 0 failed, 1 skipped (noop)\n');
  assert.equal(text.code(), 0);
  const json = capture();
  report('redirects', { checked: 2, failures: [], skipped: 1, skipReason: 'noop', skips }, { json: true, out: json.out, exit: json.exit });
  assert.deepEqual(JSON.parse(json.text()), { gate: 'redirects', checked: 2, failed: 0, skipped: 1, skipReason: 'noop', skips, failures: [] });
});
