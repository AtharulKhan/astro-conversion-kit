#!/usr/bin/env node
// Suggestions report: runs every check in checks/ over the capture, the baseline and, when
// given, the visual review, Lighthouse reports and gate results, and writes a report of what is
// worth improving. Read-only: it never changes the site, the capture or the baseline.
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertNodeVersion } from './lib/node-version.mjs';
import { CATEGORIES, itemProblems } from './lib/item.mjs';
import { InputError, loadContext } from './lib/load.mjs';
import { buildResult, renderMarkdown } from './lib/report.mjs';

const USAGE = `Usage: node suggest.mjs --capture <dir> --baseline <dir> --out <file.md> [options]

List what is worth improving on the site the conversion reproduced as-is: SEO, content, links,
accessibility, performance, security, analytics and design. Every suggestion names a path, the
evidence, why it matters, effort (S|M|L), risk (none|low|medium|high) and whether convert-site
can apply it mechanically. Nothing is applied: apply a check later with convert-site --apply <id>.

  --capture <dir>     the capture folder (capture.mjs, media.mjs, templates.mjs output)
  --baseline <dir>    the baseline folder (build-baseline.mjs output)
  --review <dir>      optional visual-review folder: styles.json and new/manifest.json with its
                      screenshots (feeds inconsistent-spacing and mobile-overflow)
  --lighthouse <dir>  optional Lighthouse JSON reports, one <slug>.json per page
                      (default: <capture>/lighthouse-live when it exists)
  --gates <file>      optional gate results, [{ gate, checked, failed, failures[] }], summarised
                      in the header
  --out <file>        the markdown report to write, e.g. docs/suggestions.md
  --json <file>       also write the result as JSON:
                      { origin, capturedAt, generatedAt, counts, gates, checks[], items[] },
                      items [{ id, path, element?, evidence, why, effort, risk, applyable,
                      pages? }] (pages: every page an item grouped across pages covers)
  --help              show this help

Checks with no input (no review, no Lighthouse) are listed as not covered.
Exit codes: 0 report written (whatever it found), 2 usage error or missing input.`;

const OPTIONS = {
  capture: { type: 'string' },
  baseline: { type: 'string' },
  review: { type: 'string' },
  lighthouse: { type: 'string' },
  gates: { type: 'string' },
  out: { type: 'string' },
  json: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
};

const CHECKS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'checks');

export async function loadChecks(dir = CHECKS_DIR) {
  const checks = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort()) {
    const check = (await import(pathToFileURL(join(dir, name)).href)).default;
    if (!check?.id || !CATEGORIES.includes(check.category) || typeof check.run !== 'function') {
      throw new Error(`checks/${name} does not export { id, title, category, run }`);
    }
    checks.push(check);
  }
  return checks;
}

// Runs each check on its own: one that throws, or returns an item without the shape, is
// reported as "check failed: <message>" under Not covered and the others still run.
// partial(ctx) names the half of a check that had no input while the rest of it ran.
export function runChecks(checks, ctx) {
  return checks.map((check) => {
    try {
      const notCovered = check.notCovered?.(ctx) ?? null;
      if (notCovered) return { check, items: [], notCovered, partial: null };
      const items = check.run(ctx);
      for (const item of items) {
        const problems = itemProblems(item);
        if (problems.length) throw new Error(`malformed item for ${item.path ?? 'no path'} (${problems.join('; ')})`);
      }
      let partial = null;
      try {
        partial = check.partial?.(ctx) ?? null;
      } catch (error) {
        partial = `coverage note failed: ${error.message}`;
      }
      return { check, items, notCovered: null, partial };
    } catch (error) {
      return { check, items: [], notCovered: `check failed: ${error.message}`, partial: null };
    }
  });
}

export async function suggest(options) {
  const ctx = loadContext(options);
  return buildResult({ checks: runChecks(await loadChecks(), ctx), ctx, generatedAt: new Date().toISOString() });
}

function writeFile(file, text) {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, text);
}

async function main(argv) {
  let args;
  try {
    ({ values: args } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.capture || !args.baseline || !args.out) {
    console.error(`--capture, --baseline and --out are required\n\n${USAGE}`);
    return 2;
  }
  let result;
  try {
    result = await suggest(args);
  } catch (error) {
    if (error instanceof InputError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  writeFile(args.out, renderMarkdown(result));
  if (args.json) writeFile(args.json, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${result.counts.total} suggestions written to ${args.out}`);
  return 0;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  assertNodeVersion();
  process.exitCode = await main(process.argv.slice(2));
}
