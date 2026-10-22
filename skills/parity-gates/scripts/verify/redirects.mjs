#!/usr/bin/env node
// Redirects gate: every baseline redirect and every redirects.csv row answers, through the host's
// compiled config, in exactly one hop to its target; every target is a page or file in dist or an
// external URL; no redirect source is also a page or file in dist.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, gateExceptions, report } from '../lib/gate-cli.mjs';
import { applyExceptions, exceptionFailure } from '../lib/exceptions.mjs';
import { distFiles, readJson, requireInputs } from '../lib/dist.mjs';
import { isDynamic, isExternal, readRedirectsCsv } from '../lib/redirects-csv.mjs';
import { vercelResolver } from '../lib/vercel-resolver.mjs';
import { cloudflareResolver, parseRedirectsFile } from '../lib/cloudflare-resolver.mjs';

const NAME = 'redirects';
const DEFAULT_CSV = 'redirects.csv';
const UNVERIFIED = ' [unverified live]';
const OPTIONS = {
  host: { type: 'string', default: '', description: 'vercel or cloudflare (default: whichever config exists)' },
  config: { type: 'string', default: '', description: 'host config (default: vercel.json, or <dist>/_redirects then _redirects)' },
  csv: { type: 'string', default: DEFAULT_CSV, description: 'the redirects source, every row is checked' },
};
const NOTES = `
Each redirect is requested through a simulation of the host: for Vercel, vercel.json's cleanUrls
and trailingSlash, then its redirects in order, then dist/; for Cloudflare Pages, _redirects
(static rules before dynamic ones), then dist/ with Pages' own trailing-slash handling. Every hop
counts, so a chain the live site had (/old -> /old/ -> /new/) must now be one rule.
A shortlink the capture did not request (verified: false) is checked the same way; a failure on
one says "[unverified live]".
A redirect exception (field "redirect", path = the source, from = the baseline target, to = the
new target) approves a changed target. Write the host config with build-redirects.mjs first.
`;

const show = (hops) => hops.map((h) => `${h.status} ${h.to}`).join(' -> ');

// The paths dist serves a file at: about/index.html at /about/, about.html at /about, any file at
// its own path.
function servedPaths(dist) {
  const served = new Map();
  for (const file of distFiles(dist)) {
    served.set(`/${file}`, file);
    if (file === 'index.html') served.set('/', file);
    else if (file.endsWith('/index.html')) served.set(`/${file.slice(0, -'index.html'.length)}`, file);
    else if (file.endsWith('.html') && file !== '404.html') served.set(`/${file.slice(0, -'.html'.length)}`, file);
  }
  return served;
}

// The entries to check, by source: baseline redirects first, then redirects.csv rows not in it.
function entriesOf(baseline, rows) {
  const entries = new Map();
  for (const r of baseline) entries.set(r.from, { from: r.from, to: r.to, status: r.status, unverified: r.verified === false });
  for (const row of rows) {
    if (entries.has(row.from)) continue;
    entries.set(row.from, { from: row.from, to: row.to, status: row.status, unverified: /unverified/i.test(row.note) });
  }
  return [...entries.values()];
}

export function checkRedirects({ dist, baseline, rows = [], resolve, exceptions = [], origins = [], paths = () => true }) {
  const relevant = exceptions.filter((e) => e.field === 'redirect');
  const entries = entriesOf(baseline, rows).filter((e) => paths(e.from));
  const known = new Set(entries.map((e) => e.from));
  const failures = relevant.filter((e) => paths(e.path) && !known.has(e.path)).map((e) => exceptionFailure(e, 'path not checked'));
  const served = servedPaths(dist);
  const local = (url) => {
    const own = origins.find((o) => o && (url === o || url.startsWith(`${o}/`)));
    return own ? url.slice(own.length) || '/' : url;
  };

  for (const entry of entries) {
    const { expected, staleExceptions } = applyExceptions({ redirect: local(entry.to) }, entry.from, relevant);
    failures.push(...staleExceptions.map((e) => exceptionFailure(e, 'no longer matches the baseline')));
    const target = expected.redirect;
    const tag = entry.unverified ? UNVERIFIED : '';
    const fail = (field, want, actual) => failures.push({ path: entry.from, field, expected: want, actual: `${actual}${tag}` });
    const { hops, final } = resolve(entry.from);
    const last = hops.length ? local(hops.at(-1).to) : null;

    if (hops.length === 0) fail('redirect', target, `no redirect: ${final.status} at ${final.path}`);
    else if (last !== target) fail('redirect', target, show(hops));
    else if (hops.length > 1) fail('hops', `1 hop to ${target}`, show(hops));
    else if (hops[0].status !== entry.status) fail('status', entry.status, `${hops[0].status}`);
    else if (!isExternal(local(target)) && final.status !== 200) fail('target', 'a page or file in dist', `${final.status} at ${final.path}`);

    if (!entry.from.includes('?') && !isDynamic(entry.from) && served.has(entry.from)) {
      failures.push({ path: entry.from, field: 'collision', expected: null, actual: served.get(entry.from) });
    }
  }
  return { checked: entries.length, failures };
}

function pickHost(name, args) {
  const vercel = args.config || 'vercel.json';
  const cloudflare = args.config || [join(args.dist, '_redirects'), '_redirects'].find((f) => existsSync(f)) || '_redirects';
  if (args.host && !['vercel', 'cloudflare'].includes(args.host)) {
    process.stderr.write(`${name}: --host must be vercel or cloudflare, not "${args.host}"\n`);
    process.exit(2);
  }
  let host = args.host;
  if (!host) {
    const found = [existsSync(vercel) && 'vercel', existsSync(cloudflare) && 'cloudflare'].filter(Boolean);
    if (found.length === 2 && !args.config) {
      process.stderr.write(`${name}: both ${vercel} and ${cloudflare} exist; pass --host\n`);
      process.exit(2);
    }
    host = found[0];
  }
  const config = host === 'cloudflare' ? cloudflare : vercel;
  if (!host || !existsSync(config)) {
    process.stderr.write(
      `${name}: no host config found (${host ? config : `${vercel} or ${cloudflare}`}); write it with build-redirects.mjs from redirects.csv\n`,
    );
    process.exit(2);
  }
  return { host, config };
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { options: OPTIONS, notes: NOTES });
  requireInputs(NAME, args.dist, args.baseline, ['redirects.json']);
  const { host, config } = pickHost(NAME, args);
  let rows = [];
  if (existsSync(args.csv)) {
    try {
      rows = readRedirectsCsv(args.csv);
    } catch (error) {
      process.stderr.write(`${NAME}: ${error.message}\n`);
      process.exit(2);
    }
  } else if (args.csv !== DEFAULT_CSV) {
    process.stderr.write(`${NAME}: not found: ${args.csv}\n`);
    process.exit(2);
  }
  const metaFile = join(args.baseline, 'meta.json');
  const meta = existsSync(metaFile) ? readJson(metaFile) : {};
  const origins = [meta.origin, meta.canonicalOrigin].filter(Boolean).map((o) => o.replace(/\/+$/, ''));
  let resolve;
  try {
    resolve =
      host === 'vercel'
        ? vercelResolver({ config: readJson(config), dist: args.dist, origins })
        : cloudflareResolver({ rules: parseRedirectsFile(readFileSync(config, 'utf8')), dist: args.dist, origins });
  } catch (error) {
    process.stderr.write(`${NAME}: ${config}: ${error.message}\n`);
    process.exit(2);
  }
  const results = checkRedirects({
    dist: args.dist,
    baseline: readJson(join(args.baseline, 'redirects.json')),
    rows,
    resolve,
    exceptions: gateExceptions(NAME, args),
    origins,
    paths: args.paths,
  });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
