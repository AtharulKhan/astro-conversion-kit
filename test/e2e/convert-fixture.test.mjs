// The convert-site run on the fixture, phase by phase as skills/convert-site/SKILL.md and
// references/phases.md write it (test/e2e/lib/run.mjs), each phase's proof asserted below.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture } from '../fixture/serve.mjs';
import * as R from './lib/run.mjs';

// One site folder per process, so two runs (two worktrees, or a run and a rebase) never share one.
const SITE = join(R.TMP, 'e2e', `site-${process.pid}`);
const results = {};
let fixture;

before(async () => {
  fixture = await startFixture();
  const live = fixture.origin;
  const site = SITE;
  results.intake = await R.intake({ site, live });
  results.capture = await R.capture({ site, live });
  results.plan = await R.plan({ site });
  results.scaffold = await R.scaffold({ site, live, trailingSlash: results.plan.trailingSlash });
  results.baseline = await R.baseline({ site });
  results.build = await R.build({ site, live });
  results.gates = await R.gates({ site });
  results.visual = await R.visual({ site, live });
  await R.components({ site });
  results.prelaunch = await R.prelaunch({ site, live });
  results.suggestions = await R.suggestions({ site });
  results.pr = await R.pr({ site, results });
});

after(async () => {
  await fixture?.close();
  R.cleanUp(SITE);
});

const shown = (result) => `${result.command} exited ${result.code}\n${result.stdout}\n${result.stderr}`;
const ok = (result) => assert.equal(result.code, 0, shown(result));
const file = (...parts) => join(SITE, ...parts);

test('1 intake: the answers and the needs-you list are in state', () => {
  const { intake, needsYou } = R.state(SITE);
  assert.equal(intake.hosting, 'vercel');
  assert.equal(intake.platform, 'wordpress');
  assert.ok(needsYou.length >= 3);
  assert.equal(results.intake.preflight.tools.gh.present, false, 'no CLI is reachable from the run');
});

test('2 capture: into SITE before the scaffold, Notes written, coverage and templates in capture/', () => {
  for (const f of ['README.md', 'templates.json', 'css-coverage.json', 'inventory.json', 'js/manifest.json']) assert.ok(existsSync(file('capture', f)), f);
  assert.match(readFileSync(file('capture', 'README.md'), 'utf8'), /## Notes\n[\s\S]*Lighthouse:/);
  assert.ok(R.readJson(file('capture', 'inventory.json')).every((r) => typeof r.status === 'number'));
  assert.ok(existsSync(file('.conversion', 'media-cache', 'wp-content', 'uploads', '2026', '01', 'og-card.jpg')), 'media downloaded into .conversion/media-cache');
});

test('3 plan: every decision recorded, the media plan drafted under .conversion/', () => {
  assert.equal(results.plan.trailingSlash, 'always');
  assert.equal(results.plan.mediaPlan.mode, 'repo');
  assert.deepEqual(results.plan.decisions, results.plan.decisions.map((_, i) => `d${i + 1}`));
});

test('4 scaffold: init-site around capture/ and .conversion/; main holds the one scaffold commit', () => {
  ok(results.scaffold.build);
  assert.deepEqual(results.scaffold.mainLog.length, 1);
  assert.match(results.scaffold.mainLog[0], /chore: scaffold from astro-conversion-kit/);
  assert.equal(results.scaffold.branch, 'astro-rebuild');
  assert.ok(existsSync(file('docs', 'media-plan.json')) && !existsSync(file('.conversion', 'media-plan.json')));
  assert.match(readFileSync(file('docs', 'plan.md'), 'utf8'), /\| d1 \| .* \| one pruned site\.css \|/);
  assert.match(readFileSync(file('.gitignore'), 'utf8'), /^\/\.conversion\/media-cache\/$/m);
});

test('5 baseline: written, js.json lists the theme script, --check passes', () => {
  ok(results.baseline.check);
  assert.deepEqual(R.readJson(file('baseline', 'js.json')).map((s) => new URL(s.src).pathname), ['/wp-content/themes/fixture/js/reveal.js']);
});

test('6 build: the seven gates pass on the templates and then on every path; the design lock holds', () => {
  for (const [gate, result] of Object.entries(results.build.templateGates)) assert.equal(result.code, 0, `${gate} (templates)\n${shown(result)}`);
  for (const [gate, result] of Object.entries(results.build.allGates)) assert.equal(result.code, 0, `${gate} (every path)\n${shown(result)}`);
  ok(results.build.lock.diff);
  ok(results.build.lock.styles);
  for (const f of ['Header.astro', 'Nav.astro', 'Footer.astro']) assert.ok(existsSync(file('src', 'components', f)), f);
  assert.ok(existsSync(file('src', 'pages', '[...path].astro')));
  assert.match(R.readJson(file('vercel.json')).rewrites.map((r) => `${r.source} ${r.destination}`).join(), /\/feed\/ \/feed\/index\.xml/);
});

test('7 gates: npm run verify passes the staging build and verify:release the release build', () => {
  ok(results.gates.staging);
  assert.match(results.gates.staging.stdout, /^All 10 gates passed$/m);
  assert.match(results.gates.staging.stdout, /^headers: 4 checked, 0 failed$/m);
  assert.match(results.gates.stagingAbout, /<meta name="robots" content="noindex, nofollow">/);
  ok(results.gates.release);
  assert.match(results.gates.release.stdout, /^All 10 gates passed$/m);
});

test('8 visual: every template at 390, 768 and 1440, and every page at 390 and 1440, within 0.5 %', () => {
  const { templateSet, diffAll, sheetAll, check } = results.visual;
  ok(templateSet.diff);
  ok(templateSet.styles);
  ok(diffAll);
  const templates = R.readJson(file('capture', 'templates.json'));
  const rows = R.readJson(file('review', 'diff', 'diff.json'));
  assert.equal(rows.length, templates.length * R.WIDTHS.length);
  for (const row of [...rows, ...R.readJson(file('review', 'diff-all', 'diff.json'))]) assert.ok(row.pass && row.percent <= 0.5, `${row.route}/${row.width}: ${row.percent} %`);
  assert.equal(R.readJson(file('review', 'diff-all', 'diff.json')).length, templates.reduce((n, t) => n + t.paths.length, 0) * 2);
  ok(sheetAll);
  ok(check);
  assert.match(check.stdout, /^review:check passed$/m);
  assert.ok(existsSync(file('review', 'index.html')) && existsSync(file('review', 'all.html')));
});

test('9 components: skipped, off by default', () => {
  assert.equal(R.state(SITE).phases.components.result, 'skipped: off by default');
});

// pre-launch with --predecessor-url fails two checks that read the kit's trailing-slash
// normalisation wrongly (upstream, in the launch skills): the slash rules count as wildcards, and
// the live /about -> /about/ redirect looks like a loop once trailing slashes are ignored.
test('10 prelaunch: pre-launch fails only the two upstream predecessor checks; verify-live passes staging and release', () => {
  const failing = results.prelaunch.gate.checks.filter((c) => c.status === 'fail');
  assert.deepEqual(failing.map((c) => c.id).sort(), ['predecessor.redirect-chains', 'predecessor.wildcard-redirects'], shown(results.prelaunch.preLaunch));
  const chains = failing.find((c) => c.id === 'predecessor.redirect-chains');
  assert.deepEqual(chains.evidence.map((e) => e.value), ['/about -> /about is a loop and serves nothing']);
  const wildcards = failing.find((c) => c.id === 'predecessor.wildcard-redirects');
  assert.ok(wildcards.evidence.every((e) => e.value.startsWith('"/:path(')), 'only the slash rules');
  ok(results.prelaunch.stagingLive);
  assert.match(results.prelaunch.stagingLive.stdout, /^verify-live: \d+ checked, 0 failed$/m);
  ok(results.prelaunch.releaseLive);
  assert.equal(results.prelaunch.audit.code, 0, shown(results.prelaunch.audit));
  assert.ok(existsSync(file('docs', 'launch', 'audit-baseline.json')));
});

test('11 suggestions: gates.json collected, docs/suggestions.md with the fixture findings and "From the review"', () => {
  assert.equal(results.suggestions.gatesJson.length, 10);
  assert.ok(results.suggestions.gatesJson.every((g) => g.failed === 0));
  const { items } = R.readJson(file('suggestions.json'));
  const paths = (id) => items.filter((i) => i.id === id).map((i) => i.path);
  assert.deepEqual(paths('shortcode-leftovers'), ['/choosing-siding-colors/']);
  assert.deepEqual(paths('missing-alt'), ['/']);
  assert.deepEqual(paths('orphan-pages'), ['/hidden-page/']);
  assert.deepEqual(paths('redirect-chains'), ['/old-services']);
  assert.deepEqual(paths('broken-links'), ['/deleted-post/']);
  assert.ok(paths('no-webp').includes('/wp-content/uploads/2026/01/hero-1024x683.jpg'));
  assert.match(readFileSync(file('docs', 'suggestions.md'), 'utf8'), /## From the review\n[^#]*$/);
});

test('12 pr: the body is written, the gates pass once more, astro-rebuild is pushed; every phase has finished', () => {
  ok(results.pr.verify);
  assert.match(readFileSync(file('.conversion', 'pr-body.md'), 'utf8'), /## Gate output\n\n```\n[\s\S]*All 10 gates passed/);
  const { phases } = R.state(SITE);
  assert.deepEqual(Object.keys(phases), R.PHASES);
  for (const name of R.PHASES) assert.ok(phases[name].finishedAt, `${name} finished`);
  assert.ok(readdirSync(`${SITE}-remote.git`).includes('refs'));
});
