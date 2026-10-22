import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { DIST_ORIGIN, edit, makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';
import { checkSeo } from '../../skills/parity-gates/scripts/verify/seo.mjs';

let root;
let baseline;
let canonicalOrigin;
let good;
let bad;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'seo-gate-'));
  baseline = await buildFixtureBaseline(root);
  canonicalOrigin = JSON.parse(readFileSync(join(baseline, 'meta.json'), 'utf8')).canonicalOrigin;
  good = makeDist(join(root, 'dist-good'));
  bad = makeDist(join(root, 'dist-bad'), { bad: ['missing-page', 'extra-page', 'changed-title', 'changed-h1', 'changed-paragraph'] });
});
after(() => rmSync(root, { recursive: true, force: true }));

// A release build (PUBLIC_INDEXABLE=true) unless env says otherwise: robots is compared exactly.
const seo = (dist, args = [], env = {}, base = baseline) =>
  runGate('seo', ['--dist', dist, '--baseline', base, ...args], { cwd: root, env: { PUBLIC_INDEXABLE: 'true', ...env } });

const record = (fields) => ({ reason: 'test', approvedBy: 'client', date: '2026-10-22', ...fields });
function writeRecords(name, records) {
  const file = join(root, name);
  writeFileSync(file, JSON.stringify(records));
  return file;
}

test('dist-good passes with --origin set to the origin it was built for', async () => {
  const result = await seo(good, ['--origin', DIST_ORIGIN]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^seo: 13 checked, 0 failed$/m);
});

test('without --origin the comparison origin is the baseline canonicalOrigin', async () => {
  const onCanonical = makeDist(join(root, 'dist-canonical'), { origin: canonicalOrigin });
  const passed = await seo(onCanonical);
  assert.equal(passed.code, 0, passed.stdout);

  const local = makeDist(join(root, 'dist-local'), { origin: 'http://localhost:4321' });
  const failed = await seo(local, ['--paths', '/about/']);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, new RegExp(`/about/ canonical: expected "${canonicalOrigin}/about/", got "http://localhost:4321/about/"`));
});

test('--origin lets a staging host pass and a different host fail', async () => {
  const staging = makeDist(join(root, 'dist-staging'), { origin: 'https://staging.example.com' });
  assert.equal((await seo(staging)).code, 1, 'a staging host fails without --origin');
  const passed = await seo(staging, ['--origin', 'https://staging.example.com']);
  assert.equal(passed.code, 0, passed.stdout);

  const result = await seo(good, ['--origin', 'https://other.example.com', '--paths', '/about/']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/about\/ canonical: expected "https:\/\/other\.example\.com\/about\/", got "https:\/\/www\.example\.com\/about\/"/);
  assert.match(result.stdout, /\/about\/ og: /);
});

test('a staging build (PUBLIC_INDEXABLE not true) needs noindex, nofollow on every page and compares the rest of robots', async () => {
  const staging = makeDist(join(root, 'dist-staging-robots'), { staging: true });
  const passed = await seo(staging, ['--origin', DIST_ORIGIN], { PUBLIC_INDEXABLE: '' });
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /^seo: 13 checked, 0 failed$/m);

  // A page without the staging tokens fails; so does a robots value the live page did not have.
  const plain = makeDist(join(root, 'dist-staging-plain'));
  const missing = await seo(plain, ['--origin', DIST_ORIGIN, '--paths', '/about/'], { PUBLIC_INDEXABLE: '' });
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /^ {2}\/about\/ robots: expected "noindex, nofollow \(a staging build, PUBLIC_INDEXABLE is not true\)", got null$/m);
  edit(staging, 'about/index.html', '<meta name="robots" content="noindex, nofollow">', '<meta name="robots" content="noindex, nofollow, noarchive">');
  const extra = await seo(staging, ['--origin', DIST_ORIGIN, '--paths', '/about/'], { PUBLIC_INDEXABLE: '' });
  assert.equal(extra.code, 1);
  assert.match(extra.stdout, /^ {2}\/about\/ robots: expected "", got "noarchive"$/m);
});

test('the staging comparison leaves the baseline records as they were', () => {
  const dist = makeDist(join(root, 'dist-staging-copy'), { staging: true });
  const read = (file) => JSON.parse(readFileSync(join(baseline, file), 'utf8'));
  const seoRecords = read('seo.json');
  const before = structuredClone(seoRecords);
  const result = checkSeo({ dist, routes: read('routes.json'), seo: seoRecords, meta: read('meta.json'), exceptions: [], origin: DIST_ORIGIN, staging: true });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(seoRecords, before);
});

test('a release build (PUBLIC_INDEXABLE=true) compares robots exactly: the staging meta fails it', async () => {
  const staging = makeDist(join(root, 'dist-release-robots'), { staging: true });
  const result = await seo(staging, ['--origin', DIST_ORIGIN], { PUBLIC_INDEXABLE: 'true' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/about\/ robots: expected "", got "noindex, nofollow"$/m);
  assert.doesNotMatch(result.stdout, /\/private-page\/ robots/, 'the live noindex page matches as built');
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
  const one = await seo(bad, ['--origin', DIST_ORIGIN, '--paths', '/services/', '--exceptions', exceptions]);
  assert.equal(one.code, 0, one.stdout);
  const all = await seo(bad, ['--origin', DIST_ORIGIN, '--exceptions', exceptions]);
  assert.equal(all.code, 1);
  assert.doesNotMatch(all.stdout, /\/services\/ h1/);
  assert.match(all.stdout, /\/about\/ title/);
});

test('a title proposal counts only with PROPOSALS=on', async () => {
  const titleOnly = makeDist(join(root, 'dist-title'), { bad: ['changed-title'] });
  const proposals = writeRecords('title-proposals.json', [
    record({ path: '/about/', field: 'title', from: 'About Us | Fixture Roofing & Siding', to: 'About | Fixture Roofing & Siding' }),
  ]);
  const args = ['--origin', DIST_ORIGIN, '--proposals', proposals];
  assert.equal((await seo(titleOnly, args)).code, 1);
  const on = await seo(titleOnly, args, { PROPOSALS: 'on' });
  assert.equal(on.code, 0, on.stdout);
});

test('a removed description passes with a to "" exception', async () => {
  const dist = makeDist(join(root, 'dist-no-description'), { bad: ['removed-description'] });
  const args = ['--origin', DIST_ORIGIN, '--paths', '/about/'];
  const failed = await seo(dist, args);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\/about\/ description: expected "A family-run[^"]*", got ""/);
  const exceptions = writeRecords('removed-description.json', [
    record({ path: '/about/', field: 'description', from: 'A family-run roofing and siding company serving the area since 1998.', to: '' }),
  ]);
  const passed = await seo(dist, [...args, '--exceptions', exceptions]);
  assert.equal(passed.code, 0, passed.stdout);
});

test('an added description passes with a from "" exception', async () => {
  // A copy of the baseline in which /about/ had no description on the live site.
  const copy = join(root, 'baseline-no-description');
  cpSync(baseline, copy, { recursive: true });
  const seoJson = JSON.parse(readFileSync(join(copy, 'seo.json'), 'utf8'));
  seoJson['/about/'].description = null;
  writeFileSync(join(copy, 'seo.json'), JSON.stringify(seoJson));
  const args = ['--origin', DIST_ORIGIN, '--paths', '/about/'];
  assert.equal((await seo(good, args, {}, copy)).code, 1);
  const exceptions = writeRecords('added-description.json', [
    record({ path: '/about/', field: 'description', from: '', to: 'A family-run roofing and siding company serving the area since 1998.' }),
  ]);
  const passed = await seo(good, [...args, '--exceptions', exceptions], {}, copy);
  assert.equal(passed.code, 0, passed.stdout);
});

test('an exception that no longer matches fails the gate', async () => {
  const exceptions = writeRecords('stale-exceptions.json', [record({ path: '/about/', field: 'h1', from: 'Old heading', to: 'About Us' })]);
  const result = await seo(good, ['--origin', DIST_ORIGIN, '--exceptions', exceptions, '--paths', '/about/']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/about\/ exception: expected \{"field":"h1","from":"Old heading","to":"About Us"\}, got "no longer matches the baseline"/);
});

test('an exception for a path the gate does not check fails the gate', async () => {
  const exceptions = writeRecords('unchecked-exceptions.json', [
    record({ path: '/no-such-page/', field: 'title', from: 'A', to: 'B' }),
    record({ path: '/about/', field: 'text', from: 'A', to: 'B' }),
  ]);
  const result = await seo(good, ['--origin', DIST_ORIGIN, '--exceptions', exceptions]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/no-such-page\/ exception: .*"path not checked"/);
  assert.doesNotMatch(result.stdout, /\/about\/ exception/, 'a text exception is the text gate\'s');
  assert.match(result.stdout, /^seo: 13 checked, 1 failed$/m);
});

test('usage errors exit 2 and --help exits 0', async () => {
  assert.equal((await seo(good, ['--origin', 'not a url'])).code, 2);
  assert.equal((await seo(good, ['--bogus'])).code, 2);
  assert.equal((await seo(good, ['--exceptions', join(root, 'missing.json')])).code, 2);
  const help = await runGate('seo', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--origin/);
  assert.match(help.stdout, /canonicalOrigin/);
});
