// convert-site's own docs: the rules a run follows that no script can enforce for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL = join(import.meta.dirname, '..', '..', 'skills', 'convert-site');
const read = (path) => readFileSync(join(SKILL, path), 'utf8');

test('phases.md: CSS coverage runs on up to 10 pages per template, and says the full-page diff catches over-pruning', () => {
  const phases = read('references/phases.md');
  const call = phases.split('\n').find((line) => line.includes('css-coverage.mjs'));
  assert.ok(call, 'the css-coverage call');
  assert.match(call, /--routes "\$\(node -e .*capture\/templates\.json.*slice\(0,10\).*\)"/);
  assert.doesNotMatch(call, /--routes capture\/inventory\.json/);
  assert.match(phases, /up to 10 pages per template/);
  assert.match(phases, /full-page diff[^.]*over-prun/);
});

test('phases.md: review:check is the proof of phases 8 and 12; overrides and blocked analytics are stated', () => {
  const phases = read('references/phases.md');
  const section = (n) => phases.split(/^## /m).find((s) => s.startsWith(`${n}. `));
  for (const n of [8, 12]) assert.match(section(n), /\*\*Proof:\*\* `npm run review:check` exits 0/);
  assert.match(phases, /`docs\/visual-overrides\.json`[\s\S]*"threshold": <at most 2>/);
  assert.match(phases.replace(/\s+/g, ' '), /blocks analytics, tag, pixel and chat hosts/);
});

test('phases.md §2: the Wayback second pass, its Notes proof, and route statuses in the proof', () => {
  const capture = read('references/phases.md').split(/^## /m).find((s) => s.startsWith('2. '));
  assert.match(capture, /capture\.mjs \$LIVE --out capture --resume --seed-file capture\/wayback-unverified\.txt/);
  assert.match(capture, /Wayback second pass: N of M archived paths verified/);
  assert.match(capture, /Still failing after retries: <path> \(<status> after 3 attempts\)/);
  const proof = capture.split('**Proof:**')[1].replace(/\s+/g, ' ');
  assert.match(proof, /no route with a status other than 200\/3xx\/404\/410, or an exception for each/);
});

test('build-rules.md copies media outside the prefix; SKILL.md names routes as an exception field', () => {
  assert.match(read('references/build-rules.md').replace(/\s+/g, ' '), /files outside the media prefix are copied to `?public\/`? at their live paths/);
  const skill = read('SKILL.md').replace(/\s+/g, ' ');
  assert.match(skill, /`routes`[^.]*a route the capture could not read: `from` is its status as a string, `to` is `"skip"` or the built replacement path/);
  assert.doesNotMatch(skill, /Forms, routes and scripts are not exception fields/);
});

test('intake.md: the message asks only what the owner knows, the Vercel team included', () => {
  const template = read('references/intake.md').split('## The template')[1].split('\n## ')[0];
  for (const asked of [/Repository\./, /Hosting\./, /Vercel team/, /`npx vercel teams ls`/, /Domain\./, /Test address\./, /Search Console\./, /Consent/]) {
    assert.match(template, asked);
  }
  // What the capture answers is never asked before it.
  assert.doesNotMatch(template, /<n> found|Found: <GA4|Out of scope \(needs a server\)|Large media/);
});

test('hosting-vercel.md: link with the scope, connect Git, deploy, and the needs-you line when a step fails', () => {
  const vercel = read('references/hosting-vercel.md');
  const steps = ['npx vercel link --yes --project <slug> --scope <team>', 'npx vercel git connect https://github.com/<owner>/<slug>.git', 'npx vercel deploy --yes'];
  const at = steps.map((s) => vercel.indexOf(`    ${s}\n`));
  assert.ok(at.every((i) => i > 0) && at[0] < at[1] && at[1] < at[2], 'the three steps in order');
  assert.match(vercel, /`link` fails[^\n]*`npx vercel teams ls`/);
  assert.match(vercel, /`git connect` fails/);
});

test('a protected site ends the run with the resume command; SKILL.md has the nvm line and the scaffold exception', () => {
  const capture = read('references/phases.md').split(/^## /m).find((s) => s.startsWith('2. ')).replace(/\s+/g, ' ');
  assert.match(capture, /\*\*A protected site\.\*\* The host is serving a bot challenge/);
  assert.match(capture, /capture\.mjs \$LIVE --out capture --resume`/);
  assert.match(capture, /Nothing is scaffolded/);
  const skill = read('SKILL.md').replace(/\s+/g, ' ');
  assert.match(skill, /Every Node command in a fresh shell starts with `source ~\/\.nvm\/nvm\.sh && nvm use 22\.23\.4`/);
  assert.match(skill, /init-site makes one commit on `main`, the exception to "never commit to main"/);
});

test('build-rules.md: the 404 page from capture/meta.json notFound, and every sitemap robots.txt names', () => {
  const rules = read('references/build-rules.md').replace(/\s+/g, ' ');
  assert.match(rules, /`src\/pages\/404\.astro` holds the site's own 404 page in its layout: the markup is in `capture\/pages\/404\.html`/);
  assert.match(rules, /When `notFound\.snapshot` is null the live site has no 404 page/);
  assert.doesNotMatch(rules, /holds the captured 404 page's markup/);
  assert.match(rules, /`capture\/sitemaps\/` holds every sitemap robots\.txt names/);
});

test('phases.md §2: the three meanings of capture exit 3; a bot challenge is the protected site', () => {
  const capture = read('references/phases.md').split(/^## /m).find((s) => s.startsWith('2. ')).replace(/\s+/g, ' ');
  assert.match(capture, /\*\*Exit 3 from the capture\*\* means one of three things/);
  assert.match(capture, /blocked: <host> anti-bot challenge \(<cause>\)/);
  assert.match(capture, /Allowlist the capture machine's public IP on the host or in the WAF/);
  assert.match(capture, /never continue to templates, media or the baseline/);
});

test('forms.md: GET forms are compared with live and need no endpoint', () => {
  const forms = read('references/forms.md').replace(/\s+/g, ' ');
  assert.match(forms, /A `GET` form, such as a search box, is not a contact form/);
  assert.match(forms, /applies to POST forms only/);
});

test('round 3 lines: styles spelled out, redirects:build after the first build, hygiene.pushed in the proof, 404 assets, suspect-challenge, the estimate is "about"', () => {
  const phases = read('references/phases.md').replace(/\s+/g, ' ');
  assert.match(phases, /npm run review:styles -- --live \$LIVE --new http:\/\/localhost:4321 --routes capture\/templates\.json --widths 390,768,1440 --out review\/styles\.json/);
  assert.match(phases, /`npm run redirects:build`, and again after the first `npm run build`/);
  const proof = phases.split('## 10. prelaunch')[1].split('**Proof:**')[1];
  assert.match(proof, /accepts `hygiene\.pushed` only while the repository has no remote and the push is on the needs-you list/);
  assert.match(phases, /A route with status "suspect-challenge"/);
  assert.match(read('references/build-rules.md').replace(/\s+/g, ' '), /The 404 page's own stylesheets, scripts and media are not collected/);
  const intake = read('references/intake.md').split('\n## ')[0].replace(/\s+/g, ' ');
  assert.match(intake, /Say "about": the estimate leaves out/);
});

test('intake.md: the time estimate counts every live read per page, per coverage page, per template and per media file', () => {
  const intake = read('references/intake.md');
  const estimate = intake.split('\n## ')[0];
  for (const part of [/capture/, /coverage/, /live shots/, /style/, /media file/, /2\.5 s/]) assert.match(estimate, part);
});

test('SKILL.md: at most 200 lines; the read-only rule names every script that reads live, and blocked analytics', () => {
  const skill = read('SKILL.md');
  const lines = skill.trimEnd().split('\n').length;
  assert.ok(lines <= 200, `${lines} lines`);
  const rule = /^2\. \*\*The live site is read-only\.\*\*[\s\S]*?(?=\n\d\. )/m.exec(skill)?.[0];
  assert.ok(rule, 'golden rule 2');
  for (const name of ['capture scripts', 'shoot.mjs', 'styles.mjs', 'css-coverage.mjs', 'launch-audit --old-url', 'pre-launch --predecessor-url']) {
    assert.ok(rule.replace(/\s+/g, ' ').includes(name), name);
  }
  assert.match(rule, /[Aa]nalytics (are|is) blocked/);
});
