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

const PIXELMATCH = { threshold: 0.1, includeAA: false };
const MAX_OVERRIDE = 2;
const DEFAULT_OVERRIDES = 'docs/visual-overrides.json';

const HELP = `Usage: node diff.mjs --a <dir> --b <dir> --out <dir> [--threshold 0.5]
                     [--overrides docs/visual-overrides.json]

Compares every <route>/<width>.png in --a with the same file in --b
(pixelmatch threshold 0.1, anti-aliasing ignored) and writes
<out>/<route>/<width>.png diff images and <out>/diff.json
([{ route, width, percent, pass, heightA, heightB, heightMismatch,
percentUnaligned, offset, threshold, reason, decision }]).

When the heights differ, the rows the taller image has and the shorter one
lacks are counted as differing pixels (painted red at the foot of the diff
image), so a missing footer or section fails. heightMismatch says the heights
differ; the difference is counted, never ignored.

When the aligned comparison fails, the images are also compared with b moved
by up to 1 pixel in each direction (overlapping area only) and the lowest
percentage is kept, so sub-pixel rounding that shifts a layout by 1 pixel is
not reported as a difference. offset is the [dx, dy] used; percentUnaligned is
the aligned result. Shifts wider than 1 pixel are never searched.

A pair passes when at most --threshold percent of pixels differ (default 0.5)
and the widths match. A file present on only one side, or one that cannot be
read as a PNG, fails.

  --overrides  JSON object of per-route thresholds, committed with the site
               (default docs/visual-overrides.json; when that file does not
               exist there are none). Each entry names the decision that
               allowed it, a threshold of at most ${MAX_OVERRIDE}% and why, e.g.
               { "home": { "id": "d12", "threshold": 1.5,
                           "reason": "rotating testimonial" } }
               A named file that does not exist, an entry without an id or a
               reason, or a threshold above ${MAX_OVERRIDE}% exits 2.

Exit codes: 0 all pass, 1 any failure (listed on stdout), 2 usage error.`;

const OFFSETS = [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => [dx, dy])).filter(([dx, dy]) => dx || dy);

class UsageError extends Error {}

function percentOption(value, name) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new UsageError(`${name} must be a percentage from 0 to 100`);
  return n;
}

// Per-route overrides: { route: { id, threshold, reason } }. The default file may be absent;
// a file named on the command line may not.
function readOverrides(file, named) {
  if (!named && !existsSync(file)) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read --overrides ${file}: ${error.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError(`${file} must be a JSON object keyed by route`);
  return Object.fromEntries(Object.entries(raw).map(([route, value]) => {
    const where = `${file} ${route}`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new UsageError(`${where} must be { "id": "<decision id>", "threshold": <percent>, "reason": "<why>" }`);
    }
    if (typeof value.id !== 'string' || !value.id.trim()) throw new UsageError(`${where} needs the id of the decision that allowed it`);
    if (typeof value.reason !== 'string' || !value.reason.trim()) throw new UsageError(`${where} needs a reason`);
    if (typeof value.threshold !== 'number' || !Number.isFinite(value.threshold) || value.threshold < 0 || value.threshold > MAX_OVERRIDE) {
      throw new UsageError(`${where} threshold must be a number from 0 to ${MAX_OVERRIDE} (percent)`);
    }
    return [route, { id: value.id.trim(), threshold: value.threshold, reason: value.reason.trim() }];
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
        overrides: { type: 'string' },
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
    overrides: readOverrides(resolve(values.overrides ?? DEFAULT_OVERRIDES), values.overrides !== undefined),
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

// Compares a with b moved by (dx, dy) over the area where both overlap, then counts every
// row the taller image has beyond the shorter one as differing (red in the diff image).
function matchAt(pngA, pngB, dx, dy) {
  const w = Math.min(pngA.width, pngB.width) - Math.abs(dx);
  const h = Math.min(pngA.height, pngB.height) - Math.abs(dy);
  const extraRows = Math.abs(pngA.height - pngB.height);
  const diff = new PNG({ width: w, height: h + extraRows });
  const dataA = crop(pngA, Math.max(0, -dx), Math.max(0, -dy), w, h);
  const dataB = crop(pngB, Math.max(0, dx), Math.max(0, dy), w, h);
  const overlap = Buffer.alloc(w * h * 4);
  const differing = pixelmatch(dataA, dataB, overlap, w, h, PIXELMATCH) + extraRows * w;
  overlap.copy(diff.data);
  for (let i = w * h * 4; i < diff.data.length; i += 4) diff.data.set([255, 0, 0, 255], i);
  const total = w * (h + extraRows);
  return { percent: Math.round((differing / total) * 100 * 1000) / 1000, offset: [dx, dy], diff };
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
  const decision = overrides[route]?.id ?? null;
  const sideA = readSide(a, key, inA);
  const sideB = readSide(b, key, inB);
  const row = {
    route, width, percent: 100, pass: false,
    heightA: sideA.png?.height ?? null, heightB: sideB.png?.height ?? null, heightMismatch: false,
    percentUnaligned: 100, offset: [0, 0], threshold: limit, reason, decision,
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
  row.heightMismatch = hA !== hB;
  const reasons = [];
  if (row.percent > limit) reasons.push(`${row.percent}% of pixels differ (limit ${limit}%)`);
  if (row.heightMismatch) reasons.push(`height ${hA}px vs ${hB}px: ${Math.abs(hA - hB)} rows on one side only, counted as differing`);
  if (wA !== wB) reasons.push(`width ${wA}px vs ${wB}px`);
  row.pass = row.percent <= limit && wA === wB;
  return { row, why: reasons.join('; ') };
}

function describe(row) {
  const parts = [];
  if (row.offset[0] || row.offset[1]) parts.push(`offset ${row.offset.join(',')}, ${row.percentUnaligned}% unaligned`);
  if (row.reason) parts.push(`threshold ${row.threshold}% (${row.decision}): ${row.reason}`);
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
