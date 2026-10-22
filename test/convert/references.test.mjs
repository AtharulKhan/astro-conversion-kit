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
