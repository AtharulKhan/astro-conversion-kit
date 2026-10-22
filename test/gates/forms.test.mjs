import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { edit, makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';

// The fixture build keeps the live form's action, so that is the endpoint it is configured with.
const ENDPOINT = '/contact/';

let root;
let baseline;
let good;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'forms-gate-'));
  baseline = await buildFixtureBaseline(root);
  good = makeDist(join(root, 'dist-good'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const forms = (dist, args = [], base = baseline) => runGate('forms', ['--dist', dist, '--baseline', base, ...args], { cwd: root });

test('dist-good passes: the contact form has the same fields, method and endpoint', async () => {
  const result = await forms(good, ['--endpoint', ENDPOINT]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ {2}thank-you: not checked \(no --thank-you\)$/m);
  assert.match(result.stdout, /^forms: 1 checked, 0 failed, 1 skipped \(thank-you not checked\)$/m);
  const json = JSON.parse((await forms(good, ['--endpoint', ENDPOINT, '--json'])).stdout);
  assert.equal(json.skipped, 1);
});

test('--thank-you: a hidden _next equal to it passes; a form without it fails; a path not in dist fails', async () => {
  const dist = makeDist(join(root, 'dist-thank-you'));
  edit(dist, 'contact/index.html', '<button type="submit">', '<input type="hidden" name="_next" value="/thank-you/"><button type="submit">');
  mkdirSync(join(dist, 'thank-you'));
  writeFileSync(join(dist, 'thank-you', 'index.html'), '<!doctype html><title>Thanks</title>');
  const passed = await forms(dist, ['--endpoint', ENDPOINT, '--thank-you', '/thank-you/']);
  assert.equal(passed.code, 0, passed.stdout);
  assert.match(passed.stdout, /^forms: 1 checked, 0 failed$/m);

  const missing = await forms(good, ['--endpoint', ENDPOINT, '--thank-you', '/thank-you/']);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /^ {2}\/contact\/ thank-you: expected "\/thank-you\/", got null$/m);

  rmSync(join(dist, 'thank-you'), { recursive: true });
  const notBuilt = await forms(dist, ['--endpoint', ENDPOINT, '--thank-you', '/thank-you/']);
  assert.equal(notBuilt.code, 1);
  assert.match(notBuilt.stdout, /^ {2}\/thank-you\/ thank-you: expected "thank-you\/index\.html", got null$/m);
});

test('a reordered field fails with both field lists', async () => {
  const bad = makeDist(join(root, 'dist-reordered'), { bad: ['reordered-field'] });
  const result = await forms(bad, ['--endpoint', ENDPOINT]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/contact\/ fields: expected \["name","email","message","website"\], got \["email","name","message","website"\]$/m);
});

test('an action other than the endpoint fails; so does a changed method', async () => {
  const other = await forms(good, ['--endpoint', 'https://forms.example.com/f/abc']);
  assert.equal(other.code, 1);
  assert.match(other.stdout, /\/contact\/ action: expected "https:\/\/forms\.example\.com\/f\/abc", got "\/contact\/"/);
  const dist = makeDist(join(root, 'dist-get'));
  edit(dist, 'contact/index.html', 'method="post"', 'method="get"');
  const method = await forms(dist, ['--endpoint', ENDPOINT]);
  assert.equal(method.code, 1);
  assert.match(method.stdout, /\/contact\/ method: expected "post", got "get"/);
});

test('a page whose form is gone fails', async () => {
  const dist = makeDist(join(root, 'dist-no-form'));
  edit(dist, 'contact/index.html', '<form class="contact-form"', '<div class="contact-form"');
  edit(dist, 'contact/index.html', '</form>', '</div>');
  const result = await forms(dist, ['--endpoint', ENDPOINT]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/contact\/ forms: expected 1, got 0/);
});

test('--honeypot requires the named field and allows it beside the baseline fields', async () => {
  assert.equal((await forms(good, ['--endpoint', ENDPOINT, '--honeypot', 'website'])).code, 0);
  const missing = await forms(good, ['--endpoint', ENDPOINT, '--honeypot', 'hp_check']);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /\/contact\/ honeypot: expected "hp_check", got null/);
  // A baseline whose live form had no honeypot: the build adds one.
  const copy = join(root, 'baseline-no-honeypot');
  cpSync(baseline, copy, { recursive: true });
  writeFileSync(
    join(copy, 'forms.json'),
    JSON.stringify({ '/contact/': [{ action: '/contact/', method: 'post', fields: ['name', 'email', 'message'].map((name) => ({ name })) }] }),
  );
  assert.equal((await forms(good, ['--endpoint', ENDPOINT, '--honeypot', 'website'], copy)).code, 0);
  assert.equal((await forms(good, ['--endpoint', ENDPOINT], copy)).code, 1);
});

test('--endpoint is required when the baseline has a form', async () => {
  const result = await forms(good);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--endpoint/);
  // Not when no checked page has one.
  assert.equal((await forms(good, ['--paths', '/about/'])).code, 0);
});

test('usage and missing inputs exit 2; --help exits 0', async () => {
  assert.equal((await forms(good, ['--bogus'])).code, 2);
  assert.equal((await runGate('forms', ['--dist', good, '--baseline', join(root, 'nope'), '--endpoint', ENDPOINT], { cwd: root })).code, 2);
  const help = await runGate('forms', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--endpoint/);
  assert.match(help.stdout, /--thank-you/);
});
