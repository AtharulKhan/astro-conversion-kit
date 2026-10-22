// What a scaffolded site's own files say and do: the exceptions helpers and the plan template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INIT = join(ROOT, 'skills', 'convert-site', 'scripts', 'init-site.mjs');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

// The record shape every gate reads (skills/parity-gates/scripts/lib/exceptions.mjs).
const EXCEPTION = {
  path: '/about/', field: 'title', from: 'About', to: 'About us', reason: 'fixture', approvedBy: 'default, d1', date: '2026-10-22',
};
// A proposal carries the decision id; several records may share one.
const PROPOSALS = [
  { id: 'd3', path: '/services/', field: 'h1', from: '', to: 'Services', reason: 'missing-h1', approvedBy: 'proposed', date: '2026-10-22' },
  { id: 'd3', path: '/about/', field: 'h1', from: '', to: 'About', reason: 'missing-h1', approvedBy: 'proposed', date: '2026-10-22' },
];

function scaffold(t) {
  const base = mkdtempSync(join(tmpdir(), 'site-templates-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const kit = join(base, 'kit');
  cpSync(join(ROOT, 'package.json'), join(kit, 'package.json'));
  cpSync(join(ROOT, 'skills', 'convert-site', 'templates'), join(kit, 'skills', 'convert-site', 'templates'), { recursive: true });
  const dir = join(base, 'site');
  const result = spawnSync(process.execPath, [
    INIT, '--dir', dir, '--origin', 'https://www.fixture-roofing.test/', '--name', 'Fixture Roofing Co',
    '--host', 'vercel', '--no-install', '--astro-version', '7.4.2', '--kit', kit,
  ], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return dir;
}

// Imports the generated src/lib/exceptions.mjs in a fresh process, with or without PROPOSALS=on.
function helpers(dir, proposals) {
  const url = pathToFileURL(join(dir, 'src', 'lib', 'exceptions.mjs')).href;
  const code = `
    const m = await import(${JSON.stringify(url)});
    console.log(JSON.stringify({
      exception: m.exceptionFor('/about/', 'title') ?? null,
      wrongField: m.exceptionFor('/about/', 'description') ?? null,
      wrongPath: m.exceptionFor('/contact/', 'title') ?? null,
      proposal: m.proposalOn('d3'),
      noProposal: m.proposalOn('d9'),
      proposals: m.proposals.length,
    }));`;
  const env = { ...process.env };
  delete env.PROPOSALS;
  if (proposals) env.PROPOSALS = 'on';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('exceptionFor matches path and field; proposalOn(id) is true only with PROPOSALS=on', (t) => {
  const dir = scaffold(t);
  writeFileSync(join(dir, 'exceptions.json'), JSON.stringify([EXCEPTION]));
  writeFileSync(join(dir, 'proposals.json'), JSON.stringify(PROPOSALS));

  const off = helpers(dir, false);
  assert.deepEqual(off.exception, EXCEPTION);
  assert.equal(off.wrongField, null);
  assert.equal(off.wrongPath, null);
  assert.equal(off.proposal, false, 'a proposal is off unless PROPOSALS=on');
  assert.equal(off.proposals, 0);

  const on = helpers(dir, true);
  assert.equal(on.proposal, true);
  assert.equal(on.noProposal, false);
  assert.equal(on.proposals, 2);
});

test('the plan template\'s decisions table has the kit\'s decision columns', (t) => {
  const plan = readFileSync(join(scaffold(t), 'docs', 'plan.md'), 'utf8');
  assert.match(plan, /\| Id \| Date \| Topic \| Choice \| Default \| Reason \| Cost if wrong \|/);
  assert.doesNotMatch(plan, /\| Date \| Decision \| Why \| Who \|/);
});

test('the site AGENTS.md states the proposal and exception rules', (t) => {
  const agents = readFileSync(join(scaffold(t), 'AGENTS.md'), 'utf8');
  assert.match(agents, /"approvedBy": "proposed"/);
  assert.match(agents, /moves to `exceptions\.json`/);
  assert.match(agents, /substitute `to` for `from` for that one field/);
  assert.doesNotMatch(agents, /skip exactly that check/);
});
