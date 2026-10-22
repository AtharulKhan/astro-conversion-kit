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
