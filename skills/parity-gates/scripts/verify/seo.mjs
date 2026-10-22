#!/usr/bin/env node
// SEO gate: per page answering 200, the built head and headings equal the baseline after
// exceptions: title, description, canonical, robots, lang, h1[], h2[], og{} and the JSON-LD
// @types. Site URLs (canonical, og:url, og:image) must be on the site's own origin.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, gateExceptions, report } from '../lib/gate-cli.mjs';
import { applyExceptions, exceptionFailure } from '../lib/exceptions.mjs';
import { attr, byTag, find, findAll, parseHtml } from '../lib/html.mjs';
import { headings, jsonLdBlocks, jsonLdTypes, metaMaps, relTokens, titleOf } from '../lib/head.mjs';
import { distFiles, firstExisting, pageFiles, pageFormat, readJson, requireInputs } from '../lib/dist.mjs';

const NAME = 'seo';
const OPTIONS = {
  origin: { type: 'string', default: '', description: 'the origin the build is for, e.g. a staging host (default: canonicalOrigin in baseline/meta.json)' },
};
const NOTES = `
canonical, og:url and og:image are compared on one origin: --origin when given, otherwise the
baseline's canonicalOrigin. A built URL must be root-relative or on that origin or on
canonicalOrigin; a URL on any other host fails. A jsonLd exception names a @type. An empty
from/to in an exception records a value the build adds or removes.
Unless PUBLIC_INDEXABLE=true the build is staging: the site template adds "noindex, nofollow" to
every page, so the built robots (the tokens of every robots meta on the page) must hold noindex
and nofollow, and the tokens left over are compared with the live robots less those two (an
empty remainder matches a page with no robots meta). PUBLIC_INDEXABLE=true compares exactly.
`;
export const SEO_FIELDS = ['title', 'description', 'canonical', 'robots', 'lang', 'h1', 'h2', 'og', 'jsonLd'];
const SCALARS = new Set(['title', 'description', 'canonical', 'robots', 'lang']);
const URL_OG_KEYS = new Set(['url', 'image']);
// What the site template's Base.astro adds to every page of a build that is not indexable.
export const STAGING_TOKENS = ['noindex', 'nofollow'];

const tokensOf = (value) => String(value ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

// The tokens of every robots meta on a page, in order, each once.
export function robotsTokens(html) {
  const metas = findAll(parseHtml(html), byTag('meta')).filter((n) => (attr(n, 'name') ?? '').trim().toLowerCase() === 'robots');
  return [...new Set(metas.flatMap((n) => tokensOf(attr(n, 'content'))))];
}

// A robots value less the staging tokens, as "a, b".
export const robotsRemainder = (tokens) => tokens.filter((t) => !STAGING_TOKENS.includes(t)).join(', ');

// Staging: [failure or null, built remainder, live remainder] for one page.
export function stagingRobots(path, html, liveRobots) {
  const tokens = robotsTokens(html);
  const missing = STAGING_TOKENS.filter((t) => !tokens.includes(t));
  const failure = missing.length
    ? { path, field: 'robots', expected: 'noindex, nofollow (a staging build, PUBLIC_INDEXABLE is not true)', actual: tokens.length ? tokens.join(', ') : null }
    : null;
  return [failure, robotsRemainder(tokens), robotsRemainder(tokensOf(liveRobots))];
}

// The fields the capture records, read from a built page. Absent values are ''.
export function seoOf(html) {
  const document = parseHtml(html);
  const { og, named } = metaMaps(document);
  const canonical = findAll(document, byTag('link')).find((n) => relTokens(n).includes('canonical'));
  return {
    title: titleOf(document) ?? '',
    description: named.description ?? '',
    canonical: (canonical && attr(canonical, 'href')) ?? '',
    robots: named.robots ?? '',
    lang: attr(find(document, byTag('html')) ?? {}, 'lang') ?? '',
    h1: headings(document, 'h1'),
    h2: headings(document, 'h2'),
    og,
    jsonLd: jsonLdTypes(jsonLdBlocks(document)),
  };
}

// A seo.json entry in the gate's shape: null becomes '', jsonLd becomes its @types.
export function baselineRecord(entry) {
  const record = {};
  for (const field of SEO_FIELDS) {
    if (SCALARS.has(field)) record[field] = entry[field] ?? '';
    else if (field === 'og') record.og = entry.og ?? {};
    else if (field === 'jsonLd') record.jsonLd = jsonLdTypes(entry.jsonLd ?? []);
    else record[field] = entry[field] ?? [];
  }
  return record;
}

const originOf = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};
const pathOf = (url) => `${url.pathname}${url.search}${url.hash}`;

// A baseline URL on the captured site, or a built URL that is root-relative or on an allowed
// origin, is moved to the comparison origin; anything else is compared as written.
export function sameOrigin(value, origins, compareOrigin, { rootRelative }) {
  if (typeof value !== 'string' || value === '') return value;
  if (rootRelative && value.startsWith('/') && !value.startsWith('//')) return `${compareOrigin}${pathOf(new URL(value, compareOrigin))}`;
  const origin = originOf(value);
  return origin && origins.includes(origin) ? `${compareOrigin}${pathOf(new URL(value))}` : value;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function compareSeo(path, expected, actual, { siteOrigins, allowedOrigins, compareOrigin }) {
  const want = (v) => sameOrigin(v, siteOrigins, compareOrigin, { rootRelative: false });
  const got = (v) => sameOrigin(v, allowedOrigins, compareOrigin, { rootRelative: true });
  const failures = [];
  for (const field of SEO_FIELDS) {
    let e = expected[field] ?? '';
    let a = actual[field] ?? '';
    if (field === 'canonical') [e, a] = [want(e), got(a)];
    if (Array.isArray(e)) e = e.filter((item) => item !== '');
    if (field === 'og') {
      const keys = [...new Set([...Object.keys(e), ...Object.keys(a)])].sort();
      const pair = (obj, fix) => Object.fromEntries(keys.filter((k) => (obj[k] ?? '') !== '').map((k) => [k, URL_OG_KEYS.has(k) ? fix(obj[k]) : obj[k]]));
      [e, a] = [pair(e, want), pair(a, got)];
    }
    if (!same(e, a)) failures.push({ path, field, expected: e, actual: a });
  }
  return failures;
}

export function checkSeo({ dist, routes, seo, meta, exceptions, origin = '', paths = () => true, staging = false }) {
  const format = pageFormat(distFiles(dist));
  const canonicalOrigin = originOf(meta.canonicalOrigin ?? '') ?? originOf(meta.origin ?? '');
  const compareOrigin = (origin && originOf(origin)) || canonicalOrigin;
  const context = {
    compareOrigin,
    siteOrigins: [...new Set([canonicalOrigin, originOf(meta.origin ?? '')].filter(Boolean))],
    allowedOrigins: [...new Set([canonicalOrigin, compareOrigin].filter(Boolean))],
  };
  const relevant = exceptions.filter((e) => SEO_FIELDS.includes(e.field));
  const checkable = routes.filter((r) => r.status === 200 && seo[r.path]);
  const known = new Set(checkable.map((r) => r.path));
  const failures = relevant.filter((e) => paths(e.path) && !known.has(e.path)).map((e) => exceptionFailure(e, 'path not checked'));
  let checked = 0;
  for (const route of checkable) {
    if (!paths(route.path)) continue;
    checked += 1;
    const { expected, staleExceptions } = applyExceptions(baselineRecord(seo[route.path]), route.path, relevant);
    failures.push(...staleExceptions.map((e) => exceptionFailure(e, 'no longer matches the baseline')));
    const candidates = pageFiles(route.path, format);
    const file = firstExisting(dist, candidates);
    if (!file) {
      failures.push({ path: route.path, field: 'page', expected: candidates[0], actual: null });
      continue;
    }
    const html = readFileSync(join(dist, file), 'utf8');
    let actual = seoOf(html);
    let want = expected;
    if (staging) {
      const [failure, built, live] = stagingRobots(route.path, html, expected.robots);
      if (failure) failures.push(failure);
      // Compared on copies: the baseline record is never changed.
      actual = { ...actual, robots: built };
      want = { ...expected, robots: live };
    }
    failures.push(...compareSeo(route.path, want, actual, context));
  }
  return { checked, failures };
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { options: OPTIONS, notes: NOTES });
  if (args.origin && !originOf(args.origin)) {
    process.stderr.write(`${NAME}: --origin must be a URL such as https://www.example.com, got ${args.origin}\n`);
    process.exit(2);
  }
  requireInputs(NAME, args.dist, args.baseline, ['routes.json', 'seo.json', 'meta.json']);
  const meta = readJson(join(args.baseline, 'meta.json'));
  if (!originOf(meta.canonicalOrigin ?? '') && !originOf(meta.origin ?? '')) {
    process.stderr.write(`${NAME}: ${join(args.baseline, 'meta.json')} has no canonicalOrigin or origin; rebuild the baseline\n`);
    process.exit(2);
  }
  const results = checkSeo({
    dist: args.dist,
    routes: readJson(join(args.baseline, 'routes.json')),
    seo: readJson(join(args.baseline, 'seo.json')),
    meta,
    exceptions: gateExceptions(NAME, args),
    origin: args.origin,
    paths: args.paths,
    staging: process.env.PUBLIC_INDEXABLE !== 'true',
  });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
