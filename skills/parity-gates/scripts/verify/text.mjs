#!/usr/bin/env node
// Text gate: the visible text of every built page, post and archive equals the captured text in
// baseline/text/ after exceptions. A text exception replaces the whole text or a phrase in it.
// A failure prints the word diff with 5 words of context either side of each change.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, report } from '../lib/gate-cli.mjs';
import { applyExceptions, loadExceptions } from '../lib/exceptions.mjs';
import { visibleText, wordDiff } from '../lib/visible-text.mjs';
import { distFiles, pageFile, pageFormat, PAGE_KINDS, readJson, requireInputs } from '../lib/dist.mjs';

const NAME = 'text';

// pages/<slug>.html -> text/<slug>.txt, the capture's naming.
const textFile = (snapshot) => snapshot.replace(/^pages\//, '').replace(/\.html$/, '.txt');

export function checkText({ dist, baseline, routes, exceptions, paths = () => true, warn = () => {} }) {
  const format = pageFormat(distFiles(dist));
  const relevant = exceptions.filter((e) => e.field === 'text');
  const failures = [];
  let checked = 0;
  for (const route of routes) {
    if (route.status !== 200 || !PAGE_KINDS.has(route.kind) || !route.snapshot || !paths(route.path)) continue;
    checked += 1;
    const captured = join(baseline, 'text', textFile(route.snapshot));
    // A page without its captured text is never a pass.
    if (!existsSync(captured)) {
      failures.push({ path: route.path, field: 'baseline', expected: `text/${textFile(route.snapshot)}`, actual: null });
      continue;
    }
    const file = pageFile(route.path, format);
    if (!existsSync(join(dist, file))) {
      failures.push({ path: route.path, field: 'page', expected: file, actual: null });
      continue;
    }
    const { expected, staleExceptions } = applyExceptions({ text: readFileSync(captured, 'utf8').trim() }, route.path, relevant);
    for (const e of staleExceptions) warn(`${NAME}: stale exception: ${e.path} text ${JSON.stringify(e.from)} no longer matches the baseline`);
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
  let exceptions;
  try {
    exceptions = loadExceptions(args.exceptions, { proposals: args.proposals });
  } catch (error) {
    process.stderr.write(`${NAME}: ${error.message}\n`);
    process.exit(2);
  }
  const results = checkText({
    dist: args.dist,
    baseline: args.baseline,
    routes: readJson(join(args.baseline, 'routes.json')),
    exceptions,
    paths: args.paths,
    warn: (line) => process.stderr.write(`${line}\n`),
  });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
