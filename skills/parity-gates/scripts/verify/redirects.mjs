#!/usr/bin/env node
// Redirects gate: every baseline redirect and every redirects.csv row answers, through the host's
// compiled config, in exactly one hop to its target; every target is a page or file in dist or an
// external URL; no redirect source is also a page or file in dist; and no built page or file is
// redirected away from its own URL by the rules (the slash rules included).
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, gateExceptions, report } from '../lib/gate-cli.mjs';
import { applyExceptions, exceptionFailure } from '../lib/exceptions.mjs';
import { distFiles, feedFiles, pageFiles, pageFormat, PAGE_KINDS, readJson, requireInputs, servedPath } from '../lib/dist.mjs';
import { isDynamic, isExternal, isNoop, readRedirectsCsv } from '../lib/redirects-csv.mjs';
import { hostResolver } from '../lib/host-resolver.mjs';

const NAME = 'redirects';
const DEFAULT_CSV = 'redirects.csv';
const UNVERIFIED = ' [unverified live]';
export const SKIP_NOOP = 'noop: destination equals source path';
export const SKIP_CLOUDFLARE_QUERY = 'query redirect, needs a Cloudflare Single Redirect';
const SAMPLE = 'sample';
const OPTIONS = {
  host: { type: 'string', default: '', description: 'vercel or cloudflare (default: whichever config exists)' },
  config: { type: 'string', default: '', description: 'host config (default: vercel.json, or <dist>/_redirects)' },
  csv: { type: 'string', default: DEFAULT_CSV, description: 'the redirects source, every row is checked' },
};
const NOTES = `
Each redirect is requested through a simulation of the host: for Vercel, vercel.json's cleanUrls
and trailingSlash, then its redirects in order, then dist/; for Cloudflare Pages, the built
dist/_redirects (static rules before dynamic ones), then dist/ with Pages' own trailing-slash
handling. The request's query string is carried to a destination that has none. Every hop counts,
so a chain the live site had (/old -> /old/ -> /new/) must now be one rule.
A splat or placeholder row is requested with a sample URL: the segment of a page in dist that its
target matches, else "${SAMPLE}"; a catch-all is also requested at its bare prefix.
Skipped, listed and counted, never passed: a query row whose target is its own path (${SKIP_NOOP}),
and on Cloudflare every query row (_redirects cannot match one; build-redirects lists them for
Single Redirects).
A shortlink the capture did not request (verified: false) is checked the same way; a failure on
one says "[unverified live]".
Every built page and file is also requested at its own URL (a baseline route at its baseline
path, any other page in the site's slash form, any other file at its path); one the rules
redirect away fails as "built page redirected by rule <rule>" (a slash rule that took
/upgrade-guide/3.5/ for a file, say). Redirect sources are left to the collision check. A
"redirected" failure cannot be excepted: fix the rule (recompile with build-redirects.mjs, or
correct the redirects.csv row that catches the page) instead.
A redirect exception (field "redirect", path = the source, from = the baseline target, to = the
new target) approves a changed target. Write the host config with build-redirects.mjs first.
`;

const show = (hops, max = 4) =>
  `${hops.slice(0, max).map((h) => `${h.status} ${h.to}`).join(' -> ')}${hops.length > max ? ' -> ...' : ''}`;
const withoutQuery = (url) => url.split('?')[0];
const unslash = (path) => path.replace(/\/+$/, '') || '/';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// The paths dist serves a file at (about/index.html at /about/, about.html at /about, any file at
// its own path), and the page paths among them.
function servedPaths(dist) {
  const served = new Map();
  const pages = [];
  for (const file of distFiles(dist)) {
    served.set(`/${file}`, file);
    let page = null;
    if (file === 'index.html') page = '/';
    else if (file.endsWith('/index.html')) page = `/${file.slice(0, -'index.html'.length)}`;
    else if (file.endsWith('.html') && file !== '404.html') page = `/${file.slice(0, -'.html'.length)}`;
    if (page) {
      served.set(page, file);
      pages.push(page);
    }
  }
  return { served, pages };
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

const PARAM = /:(\w+)([*+?]?)|\*/g;

// Sample requests for a splat or placeholder row: [{ url, target }]. The values come from the first
// dist page the target pattern matches, else "sample"; a "*" catch-all adds its bare prefix.
export function samplesFor(from, to, pages) {
  const names = [...from.matchAll(PARAM)].map((m) => m[1] ?? 'splat');
  let values = Object.fromEntries(names.map((n) => [n, SAMPLE]));
  if (!isExternal(to) && /:\w/.test(to)) {
    const targetNames = [];
    const re = to
      .split(/(:\w+[*+?]?)/)
      .map((part) => {
        const m = /^:(\w+)/.exec(part);
        if (!m) return escapeRe(part);
        targetNames.push(m[1]);
        return '([^/]+)';
      })
      .join('');
    const pattern = new RegExp(`^${re.replace(/\\\/$/, '')}\\/?$`);
    for (const page of pages) {
      const m = pattern.exec(page);
      if (m) {
        values = { ...values, ...Object.fromEntries(targetNames.map((n, i) => [n, m[i + 1]])) };
        break;
      }
    }
  }
  const fillFrom = (v) => from.replace(PARAM, (m, name) => v[name ?? 'splat'] ?? '');
  const fillTo = (v) => to.replace(/:(\w+)[*+?]?/g, (m, name) => (name in v ? v[name] : m)).replace(/([^:])\/{2,}/g, '$1/');
  const samples = [{ url: fillFrom(values), target: fillTo(values) }];
  const star = [...from.matchAll(PARAM)].find((m) => m[0] === '*' || m[2] === '*');
  if (star) {
    const bare = { ...values, [star[1] ?? 'splat']: '' };
    samples.push({ url: fillFrom(bare), target: fillTo(bare) });
  }
  return samples;
}

const HOST_FILES = new Set(['_redirects', '_headers', '_routes.json', '404.html']);

// The URL each built page and file answers at: [{ url, page }]. A built baseline route keeps its
// baseline path; any other page takes the site's slash form (from the baseline's pages, slashed when
// they say nothing), any other file its own path.
export function builtUrls(files, routes = []) {
  const present = new Set(files);
  const format = pageFormat(files);
  const covered = new Set();
  const urls = [];
  const pages = routes.filter((r) => r.status === 200 && PAGE_KINDS.has(r.kind) && r.path !== '/');
  const slashed = pages.filter((r) => r.path.endsWith('/')).length >= pages.length / 2;
  for (const route of routes) {
    if (route.status !== 200 || !(PAGE_KINDS.has(route.kind) || route.kind === 'feed')) continue;
    const file = (route.kind === 'feed' ? feedFiles(route.path) : pageFiles(route.path, format)).find((c) => present.has(c));
    if (!file || covered.has(file)) continue;
    covered.add(file);
    urls.push({ url: route.path, page: true });
  }
  for (const file of files) {
    if (covered.has(file) || HOST_FILES.has(file)) continue;
    if (file.endsWith('.html')) {
      const path = servedPath(file);
      urls.push({ url: slashed || path === '/' ? path : path.slice(0, -1), page: true });
    } else urls.push({ url: encodeURI(`/${file}`), page: false });
  }
  return urls;
}

export function checkRedirects({ dist, baseline, rows = [], routes = [], resolve, host = 'vercel', exceptions = [], origins = [], paths = () => true }) {
  const relevant = exceptions.filter((e) => e.field === 'redirect');
  const entries = entriesOf(baseline, rows).filter((e) => paths(e.from));
  const known = new Set(entries.map((e) => e.from));
  const failures = relevant.filter((e) => paths(e.path) && !known.has(e.path)).map((e) => exceptionFailure(e, 'path not checked'));
  const skips = [];
  const { served, pages } = servedPaths(dist);
  const local = (url) => {
    const own = origins.find((o) => o && (url === o || url.startsWith(`${o}/`)));
    return own ? url.slice(own.length) || '/' : url;
  };
  let checked = 0;

  for (const entry of entries) {
    const { expected, staleExceptions } = applyExceptions({ redirect: local(entry.to) }, entry.from, relevant);
    failures.push(...staleExceptions.map((e) => exceptionFailure(e, 'no longer matches the baseline')));
    const target = expected.redirect;
    if (isNoop({ from: entry.from, to: target })) {
      skips.push({ from: entry.from, reason: SKIP_NOOP });
      continue;
    }
    if (host === 'cloudflare' && entry.from.includes('?')) {
      skips.push({ from: entry.from, reason: SKIP_CLOUDFLARE_QUERY });
      continue;
    }
    const dynamic = isDynamic(entry.from);
    const requests = dynamic ? samplesFor(entry.from, target, pages) : [{ url: entry.from, target }];
    for (const request of requests) {
      checked += 1;
      const note = `${dynamic ? ` (sample ${request.url})` : ''}${entry.unverified ? UNVERIFIED : ''}`;
      const fail = (field, want, actual) => failures.push({ path: entry.from, field, expected: want, actual: `${actual}${note}` });
      const want = request.target;
      const { hops, final } = resolve(request.url);
      let last = hops.length ? local(hops.at(-1).to) : null;
      if (last !== null && !want.includes('?')) last = withoutQuery(last);
      const same = dynamic ? (a, b) => unslash(a) === unslash(b) : (a, b) => a === b;

      if (final.status === 'loop') fail('loop', `1 hop to ${want}`, show(hops));
      else if (hops.length === 0) fail('redirect', want, `no redirect: ${final.status} at ${final.path}`);
      else if (!same(last, want)) fail('redirect', want, show(hops));
      else if (hops.length > 1) fail('hops', `1 hop to ${want}`, show(hops));
      else if (hops[0].status !== entry.status) fail('status', entry.status, `${hops[0].status}`);
      else if (!isExternal(local(want)) && final.status !== 200) {
        fail('target', 'a page or file in dist', `${final.status} at ${withoutQuery(final.path)}`);
      }
    }
    if (!entry.from.includes('?') && !dynamic && served.has(entry.from)) {
      failures.push({ path: entry.from, field: 'collision', expected: null, actual: served.get(entry.from) });
    }
  }
  const built = builtUrls(distFiles(dist), routes).filter((b) => !known.has(b.url) && paths(b.url));
  let redirected = 0;
  for (const { url, page } of built) {
    const { hops } = resolve(url);
    if (!hops.length) continue;
    redirected += 1;
    failures.push({ path: url, field: 'redirected', expected: 'no redirect', actual: `built ${page ? 'page' : 'file'} redirected by rule ${hops[0].rule ?? 'unknown'}: ${show(hops)}` });
  }
  const notes = [`${built.length} built pages and files requested through the rules: ${redirected} redirected`];
  if (!skips.length) return { checked, failures, notes };
  const skipReason = [...new Set(skips.map((s) => s.reason.split(':')[0]))].join('; ');
  return { checked, failures, skipped: skips.length, skipReason, skips, notes };
}

const exit2 = (message) => {
  process.stderr.write(`${NAME}: ${message}\n`);
  process.exit(2);
};

// Cloudflare reads the _redirects Astro copied into dist/ from public/; a copy anywhere else is not
// what deploys.
function pickHost(args) {
  if (args.host && !['vercel', 'cloudflare'].includes(args.host)) exit2(`--host must be vercel or cloudflare, not "${args.host}"`);
  const vercel = args.config || 'vercel.json';
  const cloudflare = args.config || join(args.dist, '_redirects');
  let host = args.host;
  if (!host) {
    const found = [existsSync(vercel) && 'vercel', existsSync(cloudflare) && 'cloudflare'].filter(Boolean);
    if (found.length === 2 && !args.config) exit2(`both ${vercel} and ${cloudflare} exist; pass --host`);
    host = found[0];
  }
  const config = host === 'cloudflare' ? cloudflare : vercel;
  if (host && existsSync(config)) return { host, config };
  const stray = ['public/_redirects', '_redirects'].find((f) => existsSync(f));
  if (host !== 'vercel' && stray && !args.config) exit2(`${stray} exists but ${cloudflare} does not: run the build (Astro copies public/_redirects into dist/)`);
  return exit2(`no host config found (${host ? config : `${vercel} or ${cloudflare}`}); write it with build-redirects.mjs from redirects.csv`);
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { options: OPTIONS, notes: NOTES });
  requireInputs(NAME, args.dist, args.baseline, ['redirects.json']);
  const { host, config } = pickHost(args);
  let rows = [];
  if (existsSync(args.csv)) {
    try {
      rows = readRedirectsCsv(args.csv);
    } catch (error) {
      exit2(error.message);
    }
  } else if (args.csv !== DEFAULT_CSV) exit2(`not found: ${args.csv}`);
  const metaFile = join(args.baseline, 'meta.json');
  const meta = existsSync(metaFile) ? readJson(metaFile) : {};
  const origins = [meta.origin, meta.canonicalOrigin].filter(Boolean).map((o) => o.replace(/\/+$/, ''));
  let resolve;
  try {
    resolve = hostResolver({ host, config, dist: args.dist, origins, explain: true });
  } catch (error) {
    exit2(`${config}: ${error.message}`);
  }
  const results = checkRedirects({
    dist: args.dist,
    baseline: readJson(join(args.baseline, 'redirects.json')),
    rows,
    routes: existsSync(join(args.baseline, 'routes.json')) ? readJson(join(args.baseline, 'routes.json')) : [],
    resolve,
    host,
    exceptions: gateExceptions(NAME, args),
    origins,
    paths: args.paths,
  });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
