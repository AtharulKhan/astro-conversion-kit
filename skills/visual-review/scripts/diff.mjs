#!/usr/bin/env node
// Pixel diff of two screenshot trees written by shoot.mjs.
// Exit 0 every pair passes, 1 any pair fails, 2 usage or environment error.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { assertNodeVersion } from './lib/node-version.mjs';

const HELP = `Usage: node diff.mjs --a <dir> --b <dir> --out <dir> [--threshold 0.5] [--per-route overrides.json]

Compares every <route>/<width>.png in --a with the same file in --b on their
common width and height (pixelmatch threshold 0.1, anti-aliasing ignored) and
writes <out>/<route>/<width>.png diff images and <out>/diff.json
([{ route, width, percent, pass, heightA, heightB, percentUnaligned, offset,
threshold, reason }]).

When the aligned comparison fails, the images are also compared with b moved
by up to 1 pixel in each direction (overlapping area only) and the lowest
percentage is kept, so sub-pixel rounding that shifts a layout by 1 pixel is
not reported as a difference. offset is the [dx, dy] used; percentUnaligned is
the aligned result. Shifts wider than 1 pixel are never searched.

A pair passes when at most --threshold percent of pixels differ (default 0.5),
the widths match, and the heights differ by no more than 2 percent. A file
present on only one side, or one that cannot be read as a PNG, fails.

  --per-route  JSON object of per-route thresholds in percent, each with the
               reason it is looser, for example
               { "home": { "threshold": 1.5, "reason": "rotating testimonial" } }

Exit codes: 0 all pass, 1 any failure (listed on stdout), 2 usage error.`;

const PIXELMATCH = { threshold: 0.1, includeAA: false };
const MAX_HEIGHT_DIFF = 0.02;
const OFFSETS = [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => [dx, dy])).filter(([dx, dy]) => dx || dy);

class UsageError extends Error {}

function percentOption(value, name) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new UsageError(`${name} must be a percentage from 0 to 100`);
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
  return Object.fromEntries(Object.entries(raw).map(([route, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new UsageError(`--per-route ${route} must be { "threshold": <percent>, "reason": "<why>" }`);
    }
    if (typeof value.reason !== 'string' || !value.reason.trim()) throw new UsageError(`--per-route ${route} needs a reason`);
    if (typeof value.threshold !== 'number') throw new UsageError(`--per-route ${route} threshold must be a number`);
    return [route, { threshold: percentOption(value.threshold, `--per-route ${route} threshold`), reason: value.reason.trim() }];
  }));
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

// The w x h block of png whose top-left corner is (x0, y0), as RGBA bytes.
function crop(png, x0, y0, w, h) {
  if (x0 === 0 && y0 === 0 && png.width === w && png.height === h) return png.data;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const start = ((y + y0) * png.width + x0) * 4;
    png.data.copy(data, y * w * 4, start, start + w * 4);
  }
  return data;
}

// Compares a with b moved by (dx, dy), over the area where both overlap.
function matchAt(pngA, pngB, dx, dy) {
  const w = Math.min(pngA.width, pngB.width) - Math.abs(dx);
  const h = Math.min(pngA.height, pngB.height) - Math.abs(dy);
  const diff = new PNG({ width: w, height: h });
  const dataA = crop(pngA, Math.max(0, -dx), Math.max(0, -dy), w, h);
  const dataB = crop(pngB, Math.max(0, dx), Math.max(0, dy), w, h);
  const differing = pixelmatch(dataA, dataB, diff.data, w, h, PIXELMATCH);
  return { percent: Math.round((differing / (w * h)) * 100 * 1000) / 1000, offset: [dx, dy], diff };
}

function readSide(dir, key, present) {
  if (!present) return { png: null, error: `missing from ${dir}` };
  try {
    return { png: PNG.sync.read(readFileSync(join(dir, key))), error: null };
  } catch (error) {
    return { png: null, error: `cannot read ${join(dir, key)}: ${error.message}` };
  }
}

function compare(key, { a, b, out, threshold, overrides }, inA, inB) {
  const [route, file] = key.split('/');
  const width = Number.parseInt(file, 10);
  const limit = overrides[route]?.threshold ?? threshold;
  const reason = overrides[route]?.reason ?? null;
  const sideA = readSide(a, key, inA);
  const sideB = readSide(b, key, inB);
  const row = {
    route, width, percent: 100, pass: false,
    heightA: sideA.png?.height ?? null, heightB: sideB.png?.height ?? null,
    percentUnaligned: 100, offset: [0, 0], threshold: limit, reason,
  };
  if (sideA.error || sideB.error) {
    row.error = [sideA.error, sideB.error].filter(Boolean).join('; ');
    return { row, why: row.error };
  }

  const aligned = matchAt(sideA.png, sideB.png, 0, 0);
  let best = aligned;
  if (aligned.percent > limit) {
    for (const [dx, dy] of OFFSETS) {
      const candidate = matchAt(sideA.png, sideB.png, dx, dy);
      if (candidate.percent < best.percent) best = candidate;
    }
  }
  mkdirSync(join(out, route), { recursive: true });
  writeFileSync(join(out, key), PNG.sync.write(best.diff));

  row.percent = best.percent;
  row.percentUnaligned = aligned.percent;
  row.offset = best.offset;
  const { height: hA, width: wA } = sideA.png;
  const { height: hB, width: wB } = sideB.png;
  const reasons = [];
  if (row.percent > limit) reasons.push(`${row.percent}% of pixels differ (limit ${limit}%)`);
  if (Math.abs(hA - hB) / Math.max(hA, hB) > MAX_HEIGHT_DIFF) reasons.push(`height ${hA}px vs ${hB}px`);
  if (wA !== wB) reasons.push(`width ${wA}px vs ${wB}px`);
  row.pass = reasons.length === 0;
  return { row, why: reasons.join('; ') };
}

function describe(row) {
  const parts = [];
  if (row.offset[0] || row.offset[1]) parts.push(`offset ${row.offset.join(',')}, ${row.percentUnaligned}% unaligned`);
  if (row.reason) parts.push(`threshold ${row.threshold}%: ${row.reason}`);
  return parts.length ? ` [${parts.join('; ')}]` : '';
}

function diffTrees(options) {
  const inA = shots(options.a);
  const inB = shots(options.b);
  const keys = [...new Set([...inA, ...inB])].sort();
  mkdirSync(options.out, { recursive: true });
  const rows = [];
  for (const key of keys) {
    const { row, why } = compare(key, options, inA.has(key), inB.has(key));
    rows.push(row);
    console.log(`${row.pass ? 'pass' : 'FAIL'} ${key} ${row.percent}%${describe(row)}${why ? ` (${why})` : ''}`);
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
