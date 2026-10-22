#!/usr/bin/env node
// Decide where the site's media lives after conversion: in the repo, or in an
// object store (Vercel Blob or Cloudflare R2) behind a rewrite.
// Exit codes: 0 plan written, 2 usage or input error.
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';

const HELP = `Usage: node media-plan.mjs --media capture/media.json --host vercel|cloudflare
                          [--max-total 300MB] [--max-file 25MB] [--max-count 10000]
                          [--prefix /wp-content/uploads/] [--mode live-temporary]
                          --out docs/media-plan.json

Reads the captured media list (only status 200 entries count) and writes a plan:
  { mode, store?, totals: { count, bytes, largest }, reasons, prefix, thresholds }

mode is "repo" when total < --max-total, every file < --max-file and
count < --max-count; otherwise "store", with store "blob" on vercel and "r2"
on cloudflare. Pass --mode live-temporary when a store is needed but no store
credentials are available: media is then proxied from the live origin, for
staging only (the plan carries a warning saying so).

The prefix is never "/": when media paths share no folder the script exits 2
and lists the top-level prefixes seen; pass --prefix to choose. Files outside
the chosen prefix are listed in reasons.

Sizes accept 300MB, 25MB, 1KB, 1GB or a plain byte count.
Exit codes: 0 plan written, 2 usage or input error.`;

export const DEFAULTS = Object.freeze({
  maxTotal: 300 * 1024 * 1024,
  maxFile: 25 * 1024 * 1024,
  maxCount: 10000,
});

const STORE_FOR_HOST = { vercel: 'blob', cloudflare: 'r2' };
const UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
const WP_UPLOADS = '/wp-content/uploads/';

export function parseSize(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?\s*$/i.exec(String(text));
  if (!match) throw new Error(`not a size: "${text}" (use forms like 300MB, 25MB, 1KB or 1024)`);
  return Math.round(Number(match[1]) * UNITS[(match[2] || 'B').toUpperCase()]);
}

function parseCount(text) {
  if (!/^\d+$/.test(String(text))) throw new Error(`--max-count must be a whole number, got "${text}"`);
  return Number(text);
}

function formatSize(bytes) {
  if (bytes >= UNITS.MB) return `${(bytes / UNITS.MB).toFixed(1)} MB`;
  if (bytes >= UNITS.KB) return `${(bytes / UNITS.KB).toFixed(1)} KB`;
  return `${bytes} B`;
}

export const LIVE_TEMPORARY_WARNING =
  'staging only: media is proxied from the live site; create the store and upload before DNS moves, then regenerate this config';

// The shared folder every media path lives under, ending in "/". Never "/":
// a rewrite of the whole site to the store would swallow every page.
export function mediaPrefix(paths) {
  if (paths.length === 0) return WP_UPLOADS;
  if (paths.every((p) => p.startsWith(WP_UPLOADS))) return WP_UPLOADS;
  const dirs = paths.map((p) => p.split('/').slice(1, -1));
  const common = [];
  for (let i = 0; dirs.every((d) => i < d.length && d[i] === dirs[0][i]); i += 1) common.push(dirs[0][i]);
  if (common.length === 0) {
    const tops = [...new Set(dirs.map((d) => (d.length ? `/${d[0]}/` : '/ (files at the site root)')))].sort();
    throw new Error(
      `media paths share no folder, so the prefix would be "/"; top-level prefixes seen: ${tops.join(', ')}. Pass --prefix to choose one.`,
    );
  }
  return `/${common.map((seg) => `${seg}/`).join('')}`;
}

export function planMedia(entries, { host, maxTotal = DEFAULTS.maxTotal, maxFile = DEFAULTS.maxFile, maxCount = DEFAULTS.maxCount, mode, prefix } = {}) {
  if (!STORE_FOR_HOST[host]) throw new Error(`--host must be vercel or cloudflare, got "${host}"`);
  if (mode !== undefined && mode !== 'live-temporary') {
    throw new Error(`--mode only accepts live-temporary, got "${mode}"`);
  }
  if (prefix !== undefined && !/^\/.+\/$/.test(prefix)) {
    throw new Error(`--prefix must start and end with "/" and must not be "/", got "${prefix}"`);
  }
  const ok = entries.filter((e) => e.status === 200);
  const bytes = ok.reduce((sum, e) => sum + (Number(e.bytes) || 0), 0);
  const largestEntry = ok.reduce((big, e) => ((Number(e.bytes) || 0) > (Number(big?.bytes) || 0) ? e : big), null);
  const largest = Number(largestEntry?.bytes) || 0;

  // Limit reasons decide the mode; the other reasons are warnings.
  const limits = [];
  if (bytes >= maxTotal) {
    limits.push(`total media size ${formatSize(bytes)} is not under --max-total ${formatSize(maxTotal)}`);
  }
  if (largest >= maxFile) {
    const over = ok.filter((e) => (Number(e.bytes) || 0) >= maxFile).length;
    limits.push(
      `${over} file(s) not under --max-file ${formatSize(maxFile)}; largest is ${largestEntry.path} at ${formatSize(largest)}`,
    );
  }
  if (ok.length >= maxCount) {
    limits.push(`${ok.length} media files is not under --max-count ${maxCount}`);
  }

  const chosenPrefix = prefix ?? mediaPrefix(ok.map((e) => e.path));
  const reasons = [...limits];
  const outside = ok.filter((e) => !e.path.startsWith(chosenPrefix)).map((e) => e.path);
  if (outside.length) {
    const shown = outside.slice(0, 10).join(', ');
    reasons.push(
      `${outside.length} file(s) outside the prefix ${chosenPrefix} are not covered by the rewrite: ${shown}${outside.length > 10 ? ', ...' : ''}`,
    );
  }
  if (mode === 'live-temporary') reasons.push('no store credentials');

  const finalMode = mode ?? (limits.length === 0 ? 'repo' : 'store');
  return {
    mode: finalMode,
    ...(finalMode === 'repo' ? {} : { store: STORE_FOR_HOST[host] }),
    ...(finalMode === 'live-temporary' ? { warning: LIVE_TEMPORARY_WARNING } : {}),
    totals: { count: ok.length, bytes, largest },
    reasons,
    prefix: chosenPrefix,
    thresholds: { maxTotal, maxFile, maxCount },
  };
}

// How the built site reaches media that is not in the repo.
// Vercel (store "blob"): a vercel.json rewrites entry. Cloudflare (store "r2"):
// an instruction block for the runbook. Pages cannot rewrite to another origin,
// so a Pages Function (R2_FUNCTION_TEMPLATE) bound to the bucket as MEDIA serves
// the media prefix. "store" mode needs the store named; { bucket } names the R2
// bucket in the instructions.
// live-temporary (staging only) points at the live origin given as baseUrl and
// carries LIVE_TEMPORARY_WARNING: on the rewrite object as a non-enumerable
// "warning" property (so JSON.stringify leaves vercel.json valid), and as the
// first line of the Cloudflare block, which is a _redirects line to the live origin.
export const R2_FUNCTION_TEMPLATE = 'skills/convert-site/templates/cloudflare/r2-media-function.js';

export function rewriteConfig(mode, baseUrl, prefix, { store, bucket } = {}) {
  if (mode === 'repo') return null;
  if (mode !== 'store' && mode !== 'live-temporary') throw new Error(`unknown media mode "${mode}"`);
  if (mode === 'store' && !store) throw new Error('rewriteConfig: store mode needs { store: "blob" | "r2" }');
  const kind = store ?? 'blob';
  if (kind !== 'blob' && kind !== 'r2') throw new Error(`unknown store "${kind}"`);
  const base = String(baseUrl).replace(/\/+$/, '');
  const pre = `/${String(prefix).replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  const live = mode === 'live-temporary';

  if (kind === 'blob') {
    const rewrite = { source: `${pre}:path*`, destination: `${base}${pre}:path*` };
    if (live) Object.defineProperty(rewrite, 'warning', { value: LIVE_TEMPORARY_WARNING, enumerable: false });
    return rewrite;
  }

  if (live) {
    return [
      LIVE_TEMPORARY_WARNING,
      `Media under ${pre} redirects to the live origin (${base}) until a store is set up.`,
      'Add this line to _redirects, before any other rule that matches the prefix:',
      `${pre}* ${base}${pre}:splat 302`,
      `Test: request a file under ${pre} on the preview and confirm it redirects to the live file.`,
    ].join('\n');
  }
  const name = bucket ?? '<bucket>';
  return [
    `Media under ${pre} is served from the R2 bucket ${name} by a Pages Function.`,
    'This is the only code that runs at the edge, and only because media is over the repository threshold.',
    `1. Copy ${R2_FUNCTION_TEMPLATE} from the kit to functions${pre}[[path]].js in this repository.`,
    `2. Add an R2 bucket binding named MEDIA for bucket ${name} to the Pages project, in the dashboard`,
    `   (Settings, Bindings) or in wrangler.toml ([[r2_buckets]] binding = "MEDIA", bucket_name = "${name}").`,
    `3. Deploy, then request one file under ${pre} on the new site and confirm it returns 200`,
    '   with the right content type and size.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else throw new Error(`unexpected argument "${arg}"`);
  }
  return opts;
}

function main() {
  assertNodeVersion();
  let opts;
  let plan;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(HELP);
      return;
    }
    for (const name of ['media', 'host', 'out']) if (!opts[name]) throw new Error(`--${name} is required`);
    const entries = JSON.parse(readFileSync(opts.media, 'utf8'));
    if (!Array.isArray(entries)) throw new Error(`${opts.media} is not a JSON array`);
    plan = planMedia(entries, {
      host: opts.host,
      maxTotal: opts['max-total'] ? parseSize(opts['max-total']) : DEFAULTS.maxTotal,
      maxFile: opts['max-file'] ? parseSize(opts['max-file']) : DEFAULTS.maxFile,
      maxCount: opts['max-count'] ? parseCount(opts['max-count']) : DEFAULTS.maxCount,
      mode: opts.mode,
      prefix: opts.prefix,
    });
  } catch (err) {
    console.error(`media-plan: ${err.message}`);
    console.error('Run with --help for usage.');
    process.exit(2);
  }
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify(plan, null, 2)}\n`);
  const where = plan.store ? `${plan.mode} (${plan.store})` : plan.mode;
  console.log(`media: ${plan.totals.count} files, ${formatSize(plan.totals.bytes)} -> ${where}; wrote ${opts.out}`);
  for (const reason of plan.reasons) console.log(`  - ${reason}`);
  if (plan.warning) console.log(`warning: ${plan.warning}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
