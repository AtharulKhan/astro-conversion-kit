#!/usr/bin/env node
// Decide where the site's media lives after conversion: in the repo, or in an
// object store (Vercel Blob or Cloudflare R2) behind a rewrite.
// Exit codes: 0 plan written, 2 usage or input error.
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../../../scripts/lib/node-version.mjs';

const HELP = `Usage: node media-plan.mjs --media capture/media.json --host vercel|cloudflare
                          [--max-total 300MB] [--max-file 25MB] [--max-count 10000]
                          [--prefix /wp-content/uploads/] [--mode live-temporary]
                          --out docs/media-plan.json

Reads the captured media list (only status 200 entries count) and writes a plan:
  { mode, store?, totals: { count, bytes, largest }, reasons, prefix, thresholds }

mode is "repo" when total < --max-total, every file < --max-file and
count < --max-count; otherwise "store", with store "blob" on vercel and "r2"
on cloudflare. Pass --mode live-temporary when a store is needed but no store
credentials are available: media is then served from the live origin for now.

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

// The shared folder every media path lives under, ending in "/".
export function mediaPrefix(paths) {
  if (paths.length === 0) return WP_UPLOADS;
  if (paths.every((p) => p.startsWith(WP_UPLOADS))) return WP_UPLOADS;
  const dirs = paths.map((p) => p.split('/').slice(1, -1));
  const common = [];
  for (let i = 0; dirs.every((d) => i < d.length && d[i] === dirs[0][i]); i += 1) common.push(dirs[0][i]);
  return `/${common.map((s) => `${s}/`).join('')}`;
}

export function planMedia(entries, { host, maxTotal = DEFAULTS.maxTotal, maxFile = DEFAULTS.maxFile, maxCount = DEFAULTS.maxCount, mode, prefix } = {}) {
  if (!STORE_FOR_HOST[host]) throw new Error(`--host must be vercel or cloudflare, got "${host}"`);
  const ok = entries.filter((e) => e.status === 200);
  const bytes = ok.reduce((sum, e) => sum + (Number(e.bytes) || 0), 0);
  const largestEntry = ok.reduce((big, e) => ((Number(e.bytes) || 0) > (Number(big?.bytes) || 0) ? e : big), null);
  const largest = Number(largestEntry?.bytes) || 0;

  const reasons = [];
  if (bytes >= maxTotal) {
    reasons.push(`total media size ${formatSize(bytes)} is not under --max-total ${formatSize(maxTotal)}`);
  }
  if (largest >= maxFile) {
    const over = ok.filter((e) => (Number(e.bytes) || 0) >= maxFile).length;
    reasons.push(
      `${over} file(s) not under --max-file ${formatSize(maxFile)}; largest is ${largestEntry.path} at ${formatSize(largest)}`,
    );
  }
  if (ok.length >= maxCount) {
    reasons.push(`${ok.length} media files is not under --max-count ${maxCount}`);
  }

  if (mode !== undefined && mode !== 'live-temporary') {
    throw new Error(`--mode only accepts live-temporary, got "${mode}"`);
  }
  if (mode === 'live-temporary') reasons.push('no store credentials');
  const finalMode = mode ?? (reasons.length === 0 ? 'repo' : 'store');
  return {
    mode: finalMode,
    ...(finalMode === 'repo' ? {} : { store: STORE_FOR_HOST[host] }),
    totals: { count: ok.length, bytes, largest },
    reasons,
    prefix: prefix ?? mediaPrefix(ok.map((e) => e.path)),
    thresholds: { maxTotal, maxFile, maxCount },
  };
}

// How the built site reaches media that is not in the repo.
// Vercel: a vercel.json rewrites entry. Cloudflare: an instruction block for the runbook.
// For live-temporary, baseUrl is the live origin.
export function rewriteConfig(mode, baseUrl, prefix, { store = 'blob' } = {}) {
  if (mode === 'repo') return null;
  const base = String(baseUrl).replace(/\/+$/, '');
  const pre = `/${String(prefix).replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  if (store === 'blob') return { source: `${pre}:path*`, destination: `${base}${pre}:path*` };

  const host = new URL(base).host;
  if (mode === 'live-temporary') {
    return [
      `Media under ${pre} is served from the live origin (${base}) until a store is set up.`,
      `1. In the site's Cloudflare zone, add a proxied DNS record (for example media-origin.<zone>) pointing at ${host}.`,
      `2. Add an Origin Rule: when starts_with(http.request.uri.path, "${pre}"),`,
      `   override the DNS record and the Host header to ${host} (via the record from step 1).`,
      `3. Test: request a file under ${pre} on the new site and confirm it returns 200 with the right content type.`,
      `Replace this with the R2 setup once store credentials are available.`,
    ].join('\n');
  }
  return [
    `Media under ${pre} is served from the R2 bucket at ${base}.`,
    `1. In R2, open the bucket's settings and connect the custom domain ${host} (it must be in the site's zone).`,
    `2. In the site's zone, add an Origin Rule: when starts_with(http.request.uri.path, "${pre}"),`,
    `   override the DNS record and the Host header to ${host}.`,
    `3. Test: request a file under ${pre} on the new site and confirm it returns 200 from R2.`,
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
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
