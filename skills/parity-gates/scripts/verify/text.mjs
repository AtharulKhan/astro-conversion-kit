#!/usr/bin/env node
// Text gate: the visible text of every built page, post and archive equals the captured text in
// baseline/text/ after exceptions. A text exception replaces the whole text or a phrase in it.
// A failure prints the word diff with 5 words of context either side of each change.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, gateExceptions, report } from '../lib/gate-cli.mjs';
import { applyExceptions, exceptionFailure } from '../lib/exceptions.mjs';
import { visibleText, wordDiff } from '../lib/visible-text.mjs';
import { distFiles, firstExisting, pageFiles, pageFormat, PAGE_KINDS, readJson, requireInputs } from '../lib/dist.mjs';

const NAME = 'text';

// pages/<slug>.html -> text/<slug>.txt, the capture's naming.
const textFile = (snapshot) => snapshot.replace(/^pages\//, '').replace(/\.html$/, '.txt');

export function checkText({ dist, baseline, routes, exceptions, paths = () => true }) {
  const format = pageFormat(distFiles(dist));
  const relevant = exceptions.filter((e) => e.field === 'text');
  const checkable = routes.filter((r) => r.status === 200 && PAGE_KINDS.has(r.kind) && r.snapshot);
  const known = new Set(checkable.map((r) => r.path));
  const failures = relevant.filter((e) => paths(e.path) && !known.has(e.path)).map((e) => exceptionFailure(e, 'path not checked'));
  let checked = 0;
  for (const route of checkable) {
    if (!paths(route.path)) continue;
    checked += 1;
    const captured = join(baseline, 'text', textFile(route.snapshot));
    // A page without its captured text is never a pass.
    if (!existsSync(captured)) {
      failures.push({ path: route.path, field: 'baseline', expected: `text/${textFile(route.snapshot)}`, actual: null });
      continue;
    }
    const { expected, staleExceptions } = applyExceptions({ text: readFileSync(captured, 'utf8').trim() }, route.path, relevant);
    failures.push(...staleExceptions.map((e) => exceptionFailure(e, 'no longer matches the baseline')));
    const candidates = pageFiles(route.path, format);
    const file = firstExisting(dist, candidates);
    if (!file) {
      failures.push({ path: route.path, field: 'page', expected: candidates[0], actual: null });
      continue;
    }
    const actual = visibleText(readFileSync(join(dist, file), 'utf8'));
    if (actual !== expected.text) {
      failures.push({ path: route.path, field: 'text', expected: expected.text, actual, diff: wordDiff(expected.text, actual) });
    }
  }
  return { checked, failures };
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME);
  requireInputs(NAME, args.dist, args.baseline, ['routes.json', 'text']);
  const results = checkText({
    dist: args.dist,
    baseline: args.baseline,
    routes: readJson(join(args.baseline, 'routes.json')),
    exceptions: gateExceptions(NAME, args),
    paths: args.paths,
  });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
