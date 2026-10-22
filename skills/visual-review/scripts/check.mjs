#!/usr/bin/env node
// The visual review's pre-PR check: re-reads the diff and style results already written and
// fails when any row fails. Exit 0 every row passes, 1 a row fails or a result is missing,
// 2 usage error or a result that is not a JSON array.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';

const BASE_THRESHOLD = 0.5;
const MAX_OVERRIDE = 2;

const HELP = `Usage: node check.mjs [--review review]

Re-reads what the review wrote and exits 1 if anything in it fails:
  <review>/diff/diff.json      template pairs (required)
  <review>/diff-all/diff.json  every-page pairs (checked when present)
  <review>/styles.json         style rows (required)

A diff row fails when it is not marked pass, carries an error, is over its
threshold, has a threshold above ${MAX_OVERRIDE}%, or has one above ${BASE_THRESHOLD}% without the
decision id of an override. A style row fails when it is not marked pass. A
required file that is missing or holds no rows fails too. The worst failing
pair is printed.

  --review   the review folder (default review)

Exit codes: 0 every row passes, 1 a row fails or a result is missing,
2 usage error or a file that is not a JSON array.`;

class UsageError extends Error {}

function parse(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        review: { type: 'string', default: 'review' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.help) return { help: true };
  const review = resolve(values.review);
  if (!existsSync(review) || !statSync(review).isDirectory()) throw new UsageError(`--review is not a folder: ${values.review}`);
  return { review };
}

// The rows of one result file, or null when it does not exist.
function readRows(file) {
  if (!existsSync(file)) return null;
  let rows;
  try {
    rows = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${error.message}`);
  }
  if (!Array.isArray(rows)) throw new UsageError(`${file} is not a JSON array of rows`);
  return rows;
}

// Why a diff row fails, or null when it passes.
function diffFailure(row) {
  if (row.error) return row.error;
  if (row.pass !== true) return 'marked failing';
  if (!(row.percent <= row.threshold)) return `${row.percent}% is over its limit of ${row.threshold}%`;
  if (row.threshold > MAX_OVERRIDE) return `threshold ${row.threshold}% is above the ${MAX_OVERRIDE}% an override may allow`;
  if (row.threshold > BASE_THRESHOLD && !row.decision) return `threshold ${row.threshold}% has no decision id`;
  return null;
}

const percentOf = (row) => (typeof row.percent === 'number' ? row.percent : 100);

function check({ review }) {
  let failed = false;
  const failingPairs = [];
  for (const [name, required] of [['diff/diff.json', true], ['diff-all/diff.json', false]]) {
    const rows = readRows(join(review, name));
    if (rows === null) {
      console.log(`${name}: not present${required ? ' (run review:diff first)' : ''}`);
      failed ||= required;
      continue;
    }
    if (!rows.length) {
      console.log(`${name}: no rows`);
      failed = true;
      continue;
    }
    const failing = rows.map((row) => ({ row, why: diffFailure(row), file: name })).filter(({ why }) => why);
    console.log(`${name}: ${rows.length - failing.length} of ${rows.length} pairs pass`);
    failingPairs.push(...failing);
  }

  const styles = readRows(join(review, 'styles.json'));
  if (styles === null) {
    console.log('styles.json: not present (run review:styles first)');
    failed = true;
  } else if (!styles.length) {
    console.log('styles.json: no rows');
    failed = true;
  } else {
    const failing = styles.filter((row) => row.pass !== true);
    console.log(`styles.json: ${styles.length - failing.length} of ${styles.length} style rows pass`);
    for (const r of failing) {
      console.log(`  FAIL ${r.route} (${r.path}) @${r.width} ${r.selector} ${r.property}: live ${r.live} | new ${r.new}`);
    }
    failed ||= failing.length > 0;
  }

  if (failingPairs.length) {
    failed = true;
    for (const { row, why, file } of failingPairs) console.log(`  FAIL ${file} ${row.route}/${row.width}: ${why}`);
    const worst = failingPairs.reduce((a, b) => (percentOf(b.row) > percentOf(a.row) ? b : a));
    console.log(`worst pair: ${worst.row.route}/${worst.row.width} ${percentOf(worst.row)}% (limit ${worst.row.threshold}%) in ${worst.file}`);
  }
  console.log(failed ? 'review:check failed' : 'review:check passed');
  return failed ? 1 : 0;
}

function main() {
  assertNodeVersion();
  let options;
  try {
    options = parse(process.argv.slice(2));
    if (options.help) {
      console.log(HELP);
      process.exit(0);
    }
    process.exit(check(options));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${HELP}`);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
