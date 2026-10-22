#!/usr/bin/env node
// Headers gate: the host config sends, on every path, X-Content-Type-Options: nosniff, a
// Referrer-Policy, X-Frame-Options or a CSP frame-ancestors, and X-Robots-Tag: noindex unless
// PUBLIC_INDEXABLE=true (a production build, which must not send noindex). The config is
// vercel.json's headers, or else a Netlify/Cloudflare _headers file in dist or public.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, report } from '../lib/gate-cli.mjs';

const NAME = 'headers';
const DEFAULT_VERCEL = 'vercel.json';
const OPTIONS = {
  vercel: { type: 'string', default: DEFAULT_VERCEL, description: 'the Vercel config, read when it exists' },
  'headers-file': { type: 'string', default: '', description: 'the _headers file (default: <dist>/_headers, then public/_headers)' },
};
const NOTES = `
Only rules for every path count: vercel.json sources /(.*), /:path* and /:path(.*) without
has/missing conditions, and the _headers path /*. A _headers whole-host pattern such as
https://*.pages.dev/* counts only as the preview host's noindex: it meets the
noindex requirement, and is ignored when PUBLIC_INDEXABLE=true. PUBLIC_INDEXABLE=true in the environment marks a production build: noindex is
then forbidden instead of required.
`;
const VERCEL_ALL = new Set(['/(.*)', '/:path*', '/:path(.*)']);
const HOST_ALL = /^https?:\/\/[^/]+\/\*$/;

function fail(message) {
  process.stderr.write(`${NAME}: ${message}\n`);
  process.exit(2);
}

// { source, headers: Map(lower-case name -> value), hostHeaders } of the catch-all vercel.json
// rules; vercel.json has no whole-host patterns, so hostHeaders is empty.
export function vercelHeaders(config) {
  const headers = new Map();
  let source = '/(.*)';
  for (const rule of config.headers ?? []) {
    // A rule with has/missing conditions applies to some requests only.
    if (!VERCEL_ALL.has(rule.source) || rule.has || rule.missing) continue;
    source = rule.source;
    for (const { key, value } of rule.headers ?? []) headers.set(String(key).toLowerCase(), String(value));
  }
  return { source, headers, hostHeaders: new Map() };
}

// The same from a _headers file: a path line, then indented "Name: value" lines. Headers of a
// whole-host pattern (https://*.pages.dev/*) go to hostHeaders: they cover that host only.
export function headersFileHeaders(text) {
  const headers = new Map();
  const hostHeaders = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = line.trim();
      continue;
    }
    const match = /^\s+([^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1].trim().toLowerCase();
    if (current === '/*') headers.set(name, match[2].trim());
    else if (HOST_ALL.test(current ?? '')) hostHeaders.set(name, match[2].trim());
  }
  return { source: '/*', headers, hostHeaders };
}

// A whole-host noindex (the preview host) satisfies the staging requirement, but is not a
// production noindex: only the every-path rule decides whether production is indexable.
export function checkHeaders({ source, headers, hostHeaders = new Map() }, { indexable }) {
  const failures = [];
  const get = (name) => headers.get(name.toLowerCase()) ?? null;
  const nosniff = get('X-Content-Type-Options');
  if ((nosniff ?? '').toLowerCase() !== 'nosniff') failures.push({ path: source, field: 'X-Content-Type-Options', expected: 'nosniff', actual: nosniff });
  if (!get('Referrer-Policy')) failures.push({ path: source, field: 'Referrer-Policy', expected: 'a referrer policy', actual: null });
  if (!get('X-Frame-Options') && !/\bframe-ancestors\b/i.test(get('Content-Security-Policy') ?? '')) {
    failures.push({ path: source, field: 'X-Frame-Options', expected: 'X-Frame-Options or CSP frame-ancestors', actual: null });
  }
  const robots = get('X-Robots-Tag');
  const noindex = /\bnoindex\b/i.test(robots ?? '');
  const hostNoindex = /\bnoindex\b/i.test(hostHeaders.get('x-robots-tag') ?? '');
  if (!indexable && !noindex && !hostNoindex) failures.push({ path: source, field: 'X-Robots-Tag', expected: 'noindex', actual: robots });
  if (indexable && noindex) failures.push({ path: source, field: 'X-Robots-Tag', expected: 'no noindex (PUBLIC_INDEXABLE=true)', actual: robots });
  return { checked: 4, failures };
}

function loadConfig(args) {
  if (existsSync(args.vercel)) {
    try {
      return vercelHeaders(JSON.parse(readFileSync(args.vercel, 'utf8')));
    } catch (error) {
      return fail(`${args.vercel}: not valid JSON (${error.message})`);
    }
  }
  if (args.vercel !== DEFAULT_VERCEL) fail(`${args.vercel}: not found`);
  if (args.headersFile && !existsSync(args.headersFile)) fail(`${args.headersFile}: not found`);
  const file = args.headersFile || [join(args.dist, '_headers'), join('public', '_headers')].find((f) => existsSync(f));
  return file ? headersFileHeaders(readFileSync(file, 'utf8')) : null;
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { options: OPTIONS, notes: NOTES });
  const config = loadConfig(args);
  const results = config
    ? checkHeaders(config, { indexable: process.env.PUBLIC_INDEXABLE === 'true' })
    : { checked: 0, failures: [{ path: '/', field: 'config', expected: 'vercel.json or _headers', actual: null }] };
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
