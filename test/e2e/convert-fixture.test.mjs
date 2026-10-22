// The whole pipeline on the fixture site: scaffold a site with init-site (Astro installed for
// real), capture the fixture, freeze the baseline, build one page per captured route the way an
// agent would, then gate the staging and the release build, review it visually, list
// suggestions, run pre-launch on the release build and verify-live on the staging build.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture } from '../fixture/serve.mjs';
import * as R from './lib/run.mjs';

const SITE = join(R.TMP, 'e2e', 'site');
const PREVIEW_PORT = 4683;
const PHASES = ['capture', 'baseline', 'build', 'gates', 'review', 'suggest', 'verify-live', 'pre-launch'];

const results = {};
let fixture;

before(async () => {
  fixture = await startFixture();
  const live = fixture.origin;
  const site = SITE;

  results.scaffold = await R.scaffold({ site });
  await R.phase(site, 'capture');
  await R.captureSite({ site, live });

  await R.phase(site, 'baseline');
  await R.baseline(site);

  await R.phase(site, 'build');
  R.writePages({ site, live });
  R.write404({ site, live });
  R.importSiteCss(site);
  await R.writeIcons(site);
  await R.pruneCss({ site, live });
  R.copyScripts(site);
  R.copyFeeds({ site, live });
  R.writeSitemap(site);
  results.forms = R.rewireForms(site);
  await R.buildRedirects(site);

  await R.phase(site, 'gates');
  await R.build(site, { indexable: true });
  results.verifyRelease = await R.verify(site, { indexable: true });
  await R.build(site);
  results.verifyStaging = await R.verify(site);
  results.stagingAbout = readFileSync(join(site, 'dist', 'about', 'index.html'), 'utf8');
  results.stagingContact = readFileSync(join(site, 'dist', 'contact', 'index.html'), 'utf8');

  await R.phase(site, 'review');
  const preview = await R.astroPreview(site, PREVIEW_PORT);
  try {
    results.review = await R.review({ site, live, preview: preview.origin });
  } finally {
    await preview.close();
  }

  await R.phase(site, 'suggest');
  await R.suggest(site);

  await R.phase(site, 'verify-live');
  const host = await R.serveLikeVercel(site);
  try {
    results.verifyLive = await R.verifyLive(site, host.origin);
  } finally {
    await host.close();
  }

  // pre-launch gates the release build from a clean, pushed tree.
  await R.phase(site, 'pre-launch');
  await R.build(site, { indexable: true });
  await R.commitSite(site, 'feat: convert the fixture site');
  results.preLaunch = await R.preLaunch(site);
  await R.finishLastPhase(site);
});

after(async () => {
  await fixture?.close();
});

const passed = (result) => `${result.command} exited ${result.code}\n${result.stdout}\n${result.stderr}`;

test('init-site scaffolds the site on astro-rebuild with Astro installed', () => {
  assert.equal(results.scaffold.code, 0);
  assert.ok(existsSync(join(SITE, 'node_modules', 'astro', 'package.json')));
  assert.equal(results.forms, 1, 'the contact form is rewired to the endpoint');
});

test('the release build (PUBLIC_INDEXABLE=true) passes all ten gates', () => {
  assert.equal(results.verifyRelease.code, 0, passed(results.verifyRelease));
  assert.match(results.verifyRelease.stdout, /^All 10 gates passed$/m);
});

test('the staging build passes all ten gates on its meta robots noindex', () => {
  const { stdout } = results.verifyStaging;
  assert.equal(results.verifyStaging.code, 0, passed(results.verifyStaging));
  assert.match(stdout, /^All 10 gates passed$/m);
  assert.match(stdout, /^headers: 4 checked, 0 failed$/m);
  assert.match(stdout, /^seo: 13 checked, 0 failed$/m);
  // No thank-you page on the live site: the forms gate names the skip, which is not a pass.
  assert.match(stdout, /^forms: 1 checked, 0 failed, 1 skipped \(thank-you not checked\)$/m);
  const built = results.stagingAbout;
  assert.match(built, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(built, /<link rel="canonical" href="https:\/\/example\.com\/about\/">/);
  assert.match(results.stagingContact, /<form class="contact-form" action="https:\/\/formspree\.io\/f\/test" method="post">/);
});

test('every template at every width is within 0.5 % of live, styles match and the sheet is written', () => {
  const { diff, styles, sheet } = results.review;
  assert.equal(diff.code, 0, passed(diff));
  const templates = R.readJson(join(SITE, 'capture', 'templates.json'));
  const rows = R.readJson(join(SITE, 'review', 'diff', 'diff.json'));
  assert.equal(rows.length, templates.length * R.WIDTHS.length);
  for (const row of rows) assert.ok(row.pass && row.percent <= 0.5, `${row.route}/${row.width}: ${row.percent} %`);
  assert.deepEqual([...new Set(rows.map((r) => r.width))].sort((a, b) => a - b), R.WIDTHS);
  assert.equal(styles.code, 0, passed(styles));
  assert.equal(sheet.code, 0);
  assert.ok(existsSync(join(SITE, 'review', 'index.html')));
});

test('suggest writes docs/suggestions.md with the fixture findings', () => {
  assert.ok(existsSync(join(SITE, 'docs', 'suggestions.md')));
  const { items } = R.readJson(join(SITE, '.conversion', 'suggestions.json'));
  const paths = (id) => items.filter((i) => i.id === id).map((i) => i.path);
  assert.deepEqual(paths('shortcode-leftovers'), ['/choosing-siding-colors/']);
  assert.deepEqual(paths('missing-alt'), ['/']);
  assert.deepEqual(paths('orphan-pages'), ['/hidden-page/']);
  assert.deepEqual(paths('redirect-chains'), ['/old-services']);
  assert.deepEqual(paths('broken-links'), ['/deleted-post/']);
  assert.ok(paths('no-webp').includes('/wp-content/uploads/2026/01/hero-1024x683.jpg'));
});

test('verify-live passes against the staging build served the way Vercel serves it', () => {
  assert.equal(results.verifyLive.code, 0, passed(results.verifyLive));
  assert.match(results.verifyLive.stdout, /^verify-live: \d+ checked, 0 failed$/m);
});

// Two pre-launch blockers no parity build can clear on its own: the live og:image is 1536x1024,
// and pre-launch does not read vercel.json rewrites, so /feed/ (served from feed/index.xml through
// a rewrite) looks unserved. Everything else passes on a clean, pushed tree.
test('pre-launch passes the release build but for the live og:image size and the rewritten feed', () => {
  const gate = R.readJson(join(`${SITE}-pre-launch`, 'gate.json'));
  const failing = gate.checks.filter((c) => c.status === 'fail');
  assert.deepEqual(failing.map((c) => c.id).sort(), ['output.internal-refs', 'output.og-image'], passed(results.preLaunch));
  const refs = failing.find((c) => c.id === 'output.internal-refs');
  assert.ok(refs.evidence.every((e) => / -> \/feed$/.test(e.value ?? e.text ?? JSON.stringify(e))), JSON.stringify(refs.evidence));
  assert.equal(results.preLaunch.code, 1);
});

test('state.json records every phase with a finish time', () => {
  const { phases } = R.readJson(join(SITE, '.conversion', 'state.json'));
  assert.deepEqual(Object.keys(phases), PHASES);
  for (const name of PHASES) assert.ok(phases[name].finishedAt, `${name} finished`);
});
