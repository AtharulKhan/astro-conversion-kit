import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFixtureBaseline } from '../gates/fixtures/baseline.mjs';
import { slashRules } from '../../skills/parity-gates/scripts/build-redirects.mjs';
import { isSlashRule } from '../../skills/convert-site/scripts/prelaunch-reconcile.mjs';

const SCRIPT = resolve(import.meta.dirname, '../../skills/convert-site/scripts/prelaunch-reconcile.mjs');

function run(args, cwd) {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd }, (err, stdout, stderr) => done({ code: err ? err.code : 0, stdout, stderr }));
  });
}

function git(cwd, ...args) {
  return new Promise((done, fail) => {
    execFile('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }, (err) => (err ? fail(err) : done()));
  });
}

// A PNG header carrying only its size: enough for the IHDR width and height to be read.
function pngOf(width, height) {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

let root;
let baseline;
let plan;
let bare;
let capture;
let n = 0;

// The live fixture with three oddities planted the way a real capture records them: /services/
// has no h1, the two service pages share a title, and /about/ shows "Coming soon".
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'prelaunch-reconcile-'));
  const captured = await buildFixtureBaseline(join(root, 'fixture'));
  baseline = join(root, 'baseline');
  cpSync(captured, baseline, { recursive: true });
  const seoFile = join(baseline, 'seo.json');
  const seo = JSON.parse(readFileSync(seoFile, 'utf8'));
  seo['/services/'].h1 = [];
  seo['/services/siding/'].title = seo['/services/roofing/'].title;
  writeFileSync(seoFile, JSON.stringify(seo));
  appendFileSync(join(baseline, 'text', 'about.txt'), '\nComing soon\n');
  // The capture's assets: the favicon the home page links (an SVG), a live 404 for /favicon.ico,
  // and a 152x152 apple-touch-icon.png.
  capture = join(root, 'capture');
  mkdirSync(join(capture, 'assets'), { recursive: true });
  writeFileSync(join(capture, 'assets', 'apple-touch-icon.png'), pngOf(152, 152));
  writeFileSync(join(capture, 'assets', 'index.json'), JSON.stringify([
    { kind: 'favicon', url: 'https://live.example.com/wp-content/uploads/2026/01/favicon.svg', file: 'assets/favicon.svg', status: 200, note: null },
    { kind: 'favicon.ico', url: 'https://live.example.com/favicon.ico', file: null, status: 404, note: 'missing' },
    { kind: 'apple-touch-icon', url: 'https://live.example.com/apple-touch-icon.png', file: 'assets/apple-touch-icon.png', status: 200, note: null },
  ]));
  plan = join(root, 'plan.md');
  writeFileSync(plan, [
    '# Conversion plan', '', '## Decisions', '',
    '| Id | Date | Topic | Choice | Default | Reason | Cost if wrong |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| d1 | 2026-10-22 | one pruned site.css | one file | one file | default | none |',
    '| d2 | 2026-10-22 | missing h1 on /services/ | reproduce live | reproduce live | parity | none |',
    '| d3 | 2026-10-22 | output.titles: the two service pages share a title | reproduce live | reproduce live | parity | none |',
    '| d4 | 2026-10-22 | "Coming soon" on /about/ | reproduce live | reproduce live | parity | none |',
    '',
  ].join('\n'));
  bare = join(root, 'bare.md');
  writeFileSync(bare, '# Conversion plan\n\n## Decisions\n\n| Id | Date | Topic | Choice | Default | Reason | Cost if wrong |\n| --- | --- | --- | --- | --- | --- | --- |\n| d1 | 2026-10-22 | one pruned site.css | one file | one file | default | none |\n');
});
after(() => rmSync(root, { recursive: true, force: true }));

const failing = (id, detail, values, type = 'html') => ({ id, status: 'fail', severity: 'blocker', detail, evidence: values.map((value) => ({ type, value })) });
const passing = (id) => ({ id, status: 'pass', detail: 'no problems found', evidence: [] });

function gateFile(checks) {
  const dir = join(root, `bundle-${n += 1}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'gate.json');
  writeFileSync(file, JSON.stringify({ gate: checks.some((c) => c.status === 'fail') ? 'fail' : 'pass', checks }));
  return file;
}

const reconcile = (checks, { planFile = plan, json = true, captureDir = capture, extra = [], cwd } = {}) =>
  run(['--findings', gateFile(checks), '--baseline', baseline, '--plan', planFile, '--capture', captureDir, ...extra, ...(json ? ['--json'] : [])], cwd);
const parsed = (result) => JSON.parse(result.stdout);

const SLASH_ROWS = {
  wildcards: failing('predecessor.wildcard-redirects', '1 wildcard rule stand in for urls that need their own destinations', [
    `"${slashRules('always')[0].source} -> /:path/" covers 13 old content urls: /about, /blog, …`,
  ], 'text'),
  chains: failing('predecessor.redirect-chains', '1 rule do not reach their destination in one hop', ['/about -> /about is a loop and serves nothing'], 'text'),
};

test('every slash rule build-redirects writes is recognised, whatever extensions the site adds; a doctored one is not', () => {
  for (const rules of [slashRules('always'), slashRules('always', ['foo', 'Mp3', 'x3d']), slashRules('never')]) {
    for (const r of rules) assert.ok(isSlashRule(r.source, r.destination), r.source);
  }
  const [first, second] = slashRules('always');
  assert.ok(!isSlashRule(first.source, '/elsewhere/'));
  assert.ok(!isSlashRule(second.source.replace('[Jj][Pp][Gg]', '.*'), second.destination));
  assert.ok(!isSlashRule('/blog/:path*', '/news/'));
});

test('a passing gate: nothing to reconcile, exit 0', async () => {
  const result = await reconcile([passing('output.h1')], { json: false });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^prelaunch-reconcile: 0 failing checks, 0 accepted, 0 blocking$/m);
});

test('the two predecessor slash-rule checks are accepted under the narrow rule, no decision needed', async () => {
  const result = await reconcile([SLASH_ROWS.wildcards, SLASH_ROWS.chains, passing('output.h1')], { planFile: bare });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const { accepted, blocking } = parsed(result);
  assert.deepEqual(accepted.map((a) => a.id).sort(), ['predecessor.redirect-chains', 'predecessor.wildcard-redirects']);
  assert.deepEqual(blocking, []);
  assert.ok(accepted.every((a) => a.rule === 'slash'));
});

test('a wildcard that is not a slash rule, or a real chain, blocks', async () => {
  const result = await reconcile([
    failing('predecessor.wildcard-redirects', '1 wildcard rule', ['"/blog/:path* -> /news/" covers 3 old content urls: /blog/a'], 'text'),
    failing('predecessor.redirect-chains', '2 rules do not reach', ['/about -> /about is a loop and serves nothing', '/a -> /b -> /c takes 2 hops'], 'text'),
  ]);
  assert.equal(result.code, 1);
  const { accepted, blocking } = parsed(result);
  assert.deepEqual(accepted, []);
  assert.deepEqual(blocking.map((b) => b.id).sort(), ['predecessor.redirect-chains', 'predecessor.wildcard-redirects']);
  const chains = blocking.find((b) => b.id === 'predecessor.redirect-chains');
  assert.deepEqual(chains.rows.filter((r) => !r.ok).map((r) => r.text), ['/a -> /b -> /c takes 2 hops']);
});

test('placeholders.form-id is accepted while the kit placeholder stands for the missing form id', async () => {
  const ok = await reconcile([failing('placeholders.form-id', '2 placeholder form ids in 2 files; submissions to it go nowhere', [
    'src/components/ContactForm.astro:4 — formspree.io/f/REPLACE', 'dist/contact/index.html:88 — formspree.io/f/REPLACE',
  ], 'file')], { planFile: bare });
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(parsed(ok).accepted[0].decision, 'form id (needs you)');
  const other = await reconcile([failing('placeholders.form-id', '1 placeholder form id in 1 file', ['src/x.astro:1 — formspree.io/f/your-form-id'], 'file')]);
  assert.equal(other.code, 1);
});

test('a missing h1 that live also lacked, with its decision row, is accepted with the decision id', async () => {
  const result = await reconcile([failing('output.h1', '1 of 14 pages affected', ['services/index.html has 0 h1 elements'])]);
  assert.equal(result.code, 0, result.stdout);
  const [row] = parsed(result).accepted;
  assert.equal(row.id, 'output.h1');
  assert.equal(row.decision, 'd2');
  assert.deepEqual(row.rows.map((r) => [r.paths, r.field]), [[['/services/'], 'h1']]);
});

test('the same row without a decision blocks, and so does a value live did not have', async () => {
  const noDecision = await reconcile([failing('output.h1', '1 of 14 pages affected', ['services/index.html has 0 h1 elements'])], { planFile: bare });
  assert.equal(noDecision.code, 1);
  assert.match(parsed(noDecision).blocking[0].rows[0].reason, /no decision row/);
  const notLive = await reconcile([failing('output.h1', '1 of 14 pages affected', ['about/index.html has 2 h1 elements'])]);
  assert.equal(notLive.code, 1);
  assert.match(parsed(notLive).blocking[0].rows[0].reason, /live recorded 1/);
});

test('a shared title is accepted by a decision naming the check; a new page sharing it blocks', async () => {
  const roofing = JSON.parse(readFileSync(join(baseline, 'seo.json'), 'utf8'))['/services/roofing/'].title;
  const shared = (rels) => failing('output.titles', '1 title problem across 14 pages', [`${rels} share the title "${roofing}"`]);
  const ok = await reconcile([shared('services/roofing/index.html, services/siding/index.html')]);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(parsed(ok).accepted[0].decision, 'd3');
  const extra = await reconcile([shared('services/roofing/index.html, services/siding/index.html, thank-you/index.html')]);
  assert.equal(extra.code, 1);
});

test('a check whose evidence was cut at the listing cap blocks: the unlisted rows cannot be compared', async () => {
  const result = await reconcile([failing('output.h1', '25 of 40 pages affected', ['services/index.html has 0 h1 elements'])]);
  assert.equal(result.code, 1);
  assert.match(parsed(result).blocking[0].rows.at(-1).reason, /only 1 of 25 rows listed/);
});

test('placeholder copy live showed is accepted; the source hit rides on the page it renders', async () => {
  const result = await reconcile([failing('placeholders.copy', '2 placeholder strings in 2 files; a visitor would read them', [
    'dist/about/index.html:40 — Coming soon', 'src/content/pages/about.md:3 — Coming soon',
  ], 'file')]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(parsed(result).accepted[0].decision, 'd4');
  const todo = await reconcile([failing('placeholders.copy', '1 placeholder string in 1 file', ['dist/about/index.html:41 — TODO'], 'file')]);
  assert.equal(todo.code, 1);
});

test('canonical, og:image and favicon rows block when live had them', async () => {
  const result = await reconcile([
    failing('output.canonical', '1 page declares a canonical that will not do what it looks like it does', ['services/index.html has no canonical link']),
    failing('output.og-image', 'none of the 1 page in the build declares an og:image', ['services/index.html'], 'file'),
  ]);
  assert.equal(result.code, 1);
  assert.deepEqual(parsed(result).blocking.map((b) => b.id), ['output.canonical', 'output.og-image']);
});

test('favicon rows: accepted only on the capture evidence that live lacked the file or had the same size', async () => {
  const planFile = join(root, 'favicon-plan.md');
  writeFileSync(planFile, `${readFileSync(bare, 'utf8')}| d2 | 2026-10-22 | output.favicon-set: icons as live had them | reproduce live | reproduce live | parity | none |\n`);
  const favicon = (value) => reconcile([failing('output.favicon-set', value, [value], 'file')], { planFile });
  const ico = await favicon('favicon.ico is missing');
  assert.equal(ico.code, 0, ico.stdout);
  assert.equal(parsed(ico).accepted[0].decision, 'd2');
  // Live linked an SVG favicon, so a missing scalable icon is not what live had.
  assert.equal((await favicon('neither favicon.svg nor a favicon-<size>.png / icon-<size>.png exists')).code, 1);
  assert.equal((await favicon('apple-touch-icon.png is 152x152, not 180x180')).code, 0);
  const smaller = await favicon('apple-touch-icon.png is 120x120, not 180x180');
  assert.equal(smaller.code, 1);
  assert.match(parsed(smaller).blocking[0].rows[0].reason, /live's is 152x152/);
  // A file the capture never asked for is not evidence that live lacked it.
  const unasked = await reconcile([failing('output.favicon-set', 'favicon.ico is missing', ['favicon.ico is missing'], 'file')], { planFile, captureDir: join(root, 'no-capture') });
  assert.equal(unasked.code, 1);
  assert.match(parsed(unasked).blocking[0].rows[0].reason, /the capture never asked for \/favicon\.ico/);
});

test('a bare / in a decision row is not the home page; a backticked one is', async () => {
  const row = (topic, reason) => `| d2 | 2026-10-22 | ${topic} | reproduce live | reproduce live | ${reason} | none |\n`;
  const loose = join(root, 'slash-loose.md');
  writeFileSync(loose, `${readFileSync(bare, 'utf8')}${row('keep / drop the hero', 'keep / drop')}`);
  const home = [failing('output.h1', '1 of 14 pages affected', ['index.html has 1 h1 elements'])];
  assert.equal((await reconcile(home, { planFile: loose })).code, 1);
  const ticked = join(root, 'slash-ticked.md');
  writeFileSync(ticked, `${readFileSync(bare, 'utf8')}${row('the h1 on `/`', 'parity')}`);
  const ok = await reconcile(home, { planFile: ticked });
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(parsed(ok).accepted[0].decision, 'd2');
});

test('hygiene.pushed is accepted only with no remote and the push on the needs-you list', async () => {
  const site = join(root, 'site-no-remote');
  mkdirSync(join(site, '.conversion'), { recursive: true });
  await git(site, 'init', '-q');
  const state = join(site, '.conversion', 'state.json');
  const pushed = [failing('hygiene.pushed', 'this branch has no upstream, so the commit being deployed exists on this machine only', ['git rev-parse --abbrev-ref --symbolic-full-name @{u} reported no upstream'], 'text')];
  writeFileSync(state, JSON.stringify({ needsYou: ['gh is not logged in: create the repo, push main and astro-rebuild, open the PR from .conversion/pr-body.md'] }));
  const ok = await reconcile(pushed, { cwd: site });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(parsed(ok).accepted[0].rule, 'no-remote');
  writeFileSync(state, JSON.stringify({ needsYou: [] }));
  assert.equal((await reconcile(pushed, { cwd: site })).code, 1, 'not on the needs-you list');
  writeFileSync(state, JSON.stringify({ needsYou: ['push main and astro-rebuild'] }));
  await git(site, 'remote', 'add', 'origin', 'https://github.com/example/site.git');
  const remote = await reconcile(pushed, { cwd: site });
  assert.equal(remote.code, 1);
  assert.match(parsed(remote).blocking[0].rows[0].reason, /has a remote/);
});

test('any other failing check blocks, a crashed one included', async () => {
  const result = await reconcile([
    failing('hygiene.pushed', 'astro-rebuild has no upstream', ['git status: no upstream'], 'text'),
    failing('output.titles', 'check crashed — boom', ['output.titles threw: boom'], 'text'),
  ]);
  assert.equal(result.code, 1);
  assert.deepEqual(parsed(result).blocking.map((b) => b.id), ['hygiene.pushed', 'output.titles']);
});

test('findings.json works too, and a crash only gate.json beside it records still blocks', async () => {
  const gate = gateFile([failing('output.sitemap', 'check crashed — boom', ['output.sitemap threw: boom'], 'text'), passing('output.h1')]);
  const findings = join(gate, '..', 'findings.json');
  writeFileSync(findings, JSON.stringify([
    { id: 'output.h1', severity: 'blocker', detail: '1 of 14 pages affected', evidence: [{ type: 'html', value: 'services/index.html has 0 h1 elements' }] },
    { id: 'output.lang', severity: 'low', detail: 'advisory', evidence: [{ type: 'html', value: 'x' }] },
  ]));
  const result = await run(['--findings', findings, '--baseline', baseline, '--plan', plan, '--json']);
  assert.equal(result.code, 1);
  const out = parsed(result);
  assert.deepEqual(out.accepted.map((a) => a.id), ['output.h1']);
  assert.deepEqual(out.blocking.map((b) => b.id), ['output.sitemap']);
});

test('the plain output names each accepted row as reproduced from live, with its decision', async () => {
  const result = await reconcile([failing('output.h1', '1 of 14 pages affected', ['services/index.html has 0 h1 elements']), SLASH_ROWS.chains], { json: false });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^accepted {2}output\.h1: \/services\/ h1 — reproduced from live \(d2\)$/m);
  assert.match(result.stdout, /^accepted {2}predecessor\.redirect-chains: \/about -> \/about is a loop and serves nothing — trailing-slash rule \(known launch-skills limitation\)$/m);
});

test('usage errors exit 2', async () => {
  assert.equal((await run(['--findings', 'nope.json', '--baseline', baseline])).code, 2);
  assert.equal((await run(['--findings', join(root, 'missing.json'), '--baseline', baseline, '--plan', plan])).code, 2);
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: node prelaunch-reconcile\.mjs/);
});
