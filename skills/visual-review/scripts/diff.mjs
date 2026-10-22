#!/usr/bin/env node
// Pixel diff of two screenshot trees written by shoot.mjs.
// Exit 0 every pair passes, 1 any pair fails, 2 usage or environment error.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { assertNodeVersion } from '../../../scripts/lib/node-version.mjs';

const HELP = `Usage: node diff.mjs --a <dir> --b <dir> --out <dir> [--threshold 0.5] [--per-route overrides.json]

Compares every <route>/<width>.png in --a with the same file in --b on their
common width and height (pixelmatch threshold 0.1, anti-aliasing ignored) and
writes <out>/<route>/<width>.png diff images and <out>/diff.json
([{ route, width, percent, pass, heightA, heightB }]).

A pair passes when at most --threshold percent of pixels differ (default 0.5),
the widths match, and the heights differ by no more than 2 percent. A file
present on only one side fails.

  --per-route  JSON object of per-route thresholds in percent, for example
               { "home": 1.5, "blog": { "threshold": 2 } }

Exit codes: 0 all pass, 1 any failure (listed on stdout), 2 usage error.`;

const PIXELMATCH = { threshold: 0.1, includeAA: false };
const MAX_HEIGHT_DIFF = 0.02;

class UsageError extends Error {}

function percentOption(value, name) {
  const n = Number(value);
  if (value === '' || !Number.isFinite(n) || n < 0 || n > 100) throw new UsageError(`${name} must be a percentage from 0 to 100`);
  return n;
}

function readOverrides(file) {
  if (!file) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read --per-route ${file}: ${error.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError('--per-route must be a JSON object keyed by route');
  return Object.fromEntries(Object.entries(raw).map(([route, value]) => [
    route,
    percentOption(typeof value === 'object' && value !== null ? value.threshold : value, `--per-route ${route}`),
  ]));
}

function parse(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        a: { type: 'string' },
        b: { type: 'string' },
        out: { type: 'string' },
        threshold: { type: 'string', default: '0.5' },
        'per-route': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.help) return { help: true };
  if (!values.a || !values.b || !values.out) throw new UsageError('--a, --b and --out are required');
  for (const side of ['a', 'b']) {
    if (!existsSync(values[side])) throw new UsageError(`--${side} does not exist: ${values[side]}`);
  }
  return {
    a: resolve(values.a),
    b: resolve(values.b),
    out: resolve(values.out),
    threshold: percentOption(values.threshold, '--threshold'),
    overrides: readOverrides(values['per-route']),
  };
}

// Every "<route>/<width>.png" under dir.
function shots(dir) {
  const found = new Set();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(join(dir, entry.name))) {
      if (/^\d+\.png$/.test(file)) found.add(`${entry.name}/${file}`);
    }
  }
  return found;
}

function crop(png, width, height) {
  if (png.width === width && png.height === height) return png.data;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) png.data.copy(data, y * width * 4, y * png.width * 4, (y * png.width + width) * 4);
  return data;
}

function compare(key, { a, b, out, threshold, overrides }, inA, inB) {
  const [route, file] = key.split('/');
  const width = Number.parseInt(file, 10);
  const limit = overrides[route] ?? threshold;
  const pngA = inA ? PNG.sync.read(readFileSync(join(a, key))) : null;
  const pngB = inB ? PNG.sync.read(readFileSync(join(b, key))) : null;
  const row = { route, width, percent: 100, pass: false, heightA: pngA?.height ?? null, heightB: pngB?.height ?? null };
  if (!pngA || !pngB) return { row, reason: `missing from --${pngA ? 'b' : 'a'}` };

  const w = Math.min(pngA.width, pngB.width);
  const h = Math.min(pngA.height, pngB.height);
  const diff = new PNG({ width: w, height: h });
  const differing = pixelmatch(crop(pngA, w, h), crop(pngB, w, h), diff.data, w, h, PIXELMATCH);
  mkdirSync(join(out, route), { recursive: true });
  writeFileSync(join(out, key), PNG.sync.write(diff));

  row.percent = Math.round((differing / (w * h)) * 100 * 1000) / 1000;
  const heightDiff = Math.abs(pngA.height - pngB.height) / Math.max(pngA.height, pngB.height);
  const reasons = [];
  if (row.percent > limit) reasons.push(`${row.percent}% of pixels differ (limit ${limit}%)`);
  if (heightDiff > MAX_HEIGHT_DIFF) reasons.push(`height ${pngA.height}px vs ${pngB.height}px`);
  if (pngA.width !== pngB.width) reasons.push(`width ${pngA.width}px vs ${pngB.width}px`);
  row.pass = reasons.length === 0;
  return { row, reason: reasons.join('; ') };
}

function diffTrees(options) {
  const inA = shots(options.a);
  const inB = shots(options.b);
  const keys = [...new Set([...inA, ...inB])].sort();
  mkdirSync(options.out, { recursive: true });
  const rows = [];
  for (const key of keys) {
    const { row, reason } = compare(key, options, inA.has(key), inB.has(key));
    rows.push(row);
    console.log(`${row.pass ? 'pass' : 'FAIL'} ${key} ${row.percent}%${reason ? ` (${reason})` : ''}`);
  }
  writeFileSync(join(options.out, 'diff.json'), `${JSON.stringify(rows, null, 2)}\n`);
  return rows.every((row) => row.pass) ? 0 : 1;
}

function main() {
  assertNodeVersion();
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }
  try {
    process.exit(diffTrees(options));
  } catch (error) {
    console.error(`environment error: ${error.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
