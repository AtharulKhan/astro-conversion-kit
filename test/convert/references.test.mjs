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
