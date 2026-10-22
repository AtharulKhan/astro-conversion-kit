#!/usr/bin/env node
// SEO gate: per page answering 200, the built head and headings equal the baseline after
// exceptions: title, description, canonical, robots, lang, h1[], h2[], og{} and the JSON-LD
// @types. Site URLs (canonical, og:url, og:image) are compared origin-relative: with --origin
// the build must carry the baseline URL on that origin, without it only the paths are compared.
// A jsonLd exception names a @type (from "Organization", to "LocalBusiness").
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, report } from '../lib/gate-cli.mjs';
import { applyExceptions, loadExceptions } from '../lib/exceptions.mjs';
import { attr, byTag, find, findAll, parseHtml, walk } from '../lib/html.mjs';
import { normaliseText } from '../lib/visible-text.mjs';
import { distFiles, pageFile, pageFormat, readJson, requireInputs } from '../lib/dist.mjs';

const NAME = 'seo';
const OPTIONS = {
  origin: { type: 'string', default: '', description: 'the new site origin; without it site URLs are compared by path' },
};
export const SEO_FIELDS = ['title', 'description', 'canonical', 'robots', 'lang', 'h1', 'h2', 'og', 'jsonLd'];
const URL_OG_KEYS = ['url', 'image'];

function textOf(node) {
  const parts = [];
  walk(node, (n) => {
    if (n.nodeName === '#text') parts.push(n.value);
    return n.tagName === 'script' || n.tagName === 'style' ? false : undefined;
  });
  return normaliseText(parts.join(' '));
}

// JSON-LD @types of every top-level node, flattening arrays and @graph, in document order.
export function jsonLdTypes(blocks) {
  const types = [];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      types.push(...[].concat(value['@type'] ?? []));
      if (value['@graph']) visit(value['@graph']);
    }
  };
  visit(blocks);
  return [...new Set(types)];
}

// The same fields the capture records, read from a built page.
export function seoOf(html) {
  const document = parseHtml(html);
  const og = {};
  const named = {};
  for (const meta of findAll(document, byTag('meta'))) {
    const key = (attr(meta, 'property') ?? attr(meta, 'name') ?? '').trim().toLowerCase();
    const content = attr(meta, 'content');
    if (!key || content === null) continue;
    if (key.startsWith('og:')) og[key.slice(3)] ??= content;
    named[key] ??= content;
  }
  const canonical = findAll(document, byTag('link')).find((n) =>
    (attr(n, 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'),
  );
  const blocks = [];
  for (const node of findAll(document, (n) => n.tagName === 'script' && (attr(n, 'type') ?? '').toLowerCase() === 'application/ld+json')) {
    try {
      blocks.push(JSON.parse(node.childNodes.map((c) => c.value ?? '').join('').trim()));
    } catch {
      // A broken block has no types, so a type the baseline had shows as missing.
    }
  }
  const title = find(document, byTag('title'));
  const headings = (tag) => findAll(document, byTag(tag)).map(textOf).filter(Boolean);
  return {
    title: title ? textOf(title) : null,
    description: named.description ?? null,
    canonical: canonical ? attr(canonical, 'href') : null,
    robots: named.robots ?? null,
    lang: attr(find(document, byTag('html')) ?? {}, 'lang'),
    h1: headings('h1'),
    h2: headings('h2'),
    og,
    jsonLd: jsonLdTypes(blocks),
  };
}

const pathOf = (value) => {
  try {
    const url = new URL(value, 'http://site.invalid');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
};

// A pair of URL values made comparable. A baseline URL on the captured site's origin is moved to
// --origin, or both sides are reduced to their paths when no origin was given.
export function urlPair(expected, actual, { siteOrigins, origin }) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return [expected, actual];
  let parsed;
  try {
    parsed = new URL(expected);
  } catch {
    return [expected, actual];
  }
  if (!siteOrigins.includes(parsed.origin)) return [expected, actual];
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (origin) return [`${origin}${path}`, actual];
  return [path, pathOf(actual)];
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// og keys in a fixed order, URL values made comparable; undefined values drop out of the JSON.
function ogPair(want, got, context) {
  const keys = [...new Set([...Object.keys(want ?? {}), ...Object.keys(got ?? {})])].sort();
  const a = {};
  const b = {};
  for (const key of keys) {
    [a[key], b[key]] = URL_OG_KEYS.includes(key) ? urlPair(want?.[key], got?.[key], context) : [want?.[key], got?.[key]];
  }
  return [a, b];
}

export function compareSeo(path, expected, actual, context) {
  const failures = [];
  for (const field of SEO_FIELDS) {
    let want = expected[field] ?? null;
    let got = actual[field] ?? null;
    if (field === 'canonical') [want, got] = urlPair(want, got, context);
    if (field === 'og') [want, got] = ogPair(want, got, context);
    if (!same(want, got)) failures.push({ path, field, expected: want, actual: got });
  }
  return failures;
}

export function checkSeo({ dist, routes, seo, meta, exceptions, origin = '', paths = () => true, warn = () => {} }) {
  const files = distFiles(dist);
  const format = pageFormat(files);
  const siteOrigins = [...new Set([meta.canonicalOrigin, meta.origin].filter(Boolean).map((o) => new URL(o).origin))];
  const context = { siteOrigins, origin: origin ? new URL(origin).origin : '' };
  const relevant = exceptions.filter((e) => SEO_FIELDS.includes(e.field));
  const failures = [];
  let checked = 0;
  for (const route of routes) {
    if (route.status !== 200 || !seo[route.path] || !paths(route.path)) continue;
    checked += 1;
    const file = pageFile(route.path, format);
    if (!existsSync(join(dist, file))) {
      failures.push({ path: route.path, field: 'page', expected: file, actual: null });
      continue;
    }
    const baseline = { ...seo[route.path], jsonLd: jsonLdTypes(seo[route.path].jsonLd ?? []) };
    const { expected, staleExceptions } = applyExceptions(baseline, route.path, relevant);
    for (const e of staleExceptions) warn(`${NAME}: stale exception: ${e.path} ${e.field} ${JSON.stringify(e.from)} no longer matches the baseline`);
    failures.push(...compareSeo(route.path, expected, seoOf(readFileSync(join(dist, file), 'utf8')), context));
  }
  return { checked, failures };
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { options: OPTIONS });
  if (args.origin && !URL.canParse(args.origin)) {
    process.stderr.write(`${NAME}: --origin must be a URL such as https://www.example.com, got ${args.origin}\n`);
    process.exit(2);
  }
  requireInputs(NAME, args.dist, args.baseline, ['routes.json', 'seo.json', 'meta.json']);
  let exceptions;
  try {
    exceptions = loadExceptions(args.exceptions, { proposals: args.proposals });
  } catch (error) {
    process.stderr.write(`${NAME}: ${error.message}\n`);
    process.exit(2);
  }
  const results = checkSeo({
    dist: args.dist,
    routes: readJson(join(args.baseline, 'routes.json')),
    seo: readJson(join(args.baseline, 'seo.json')),
    meta: readJson(join(args.baseline, 'meta.json')),
    exceptions,
    origin: args.origin,
    paths: args.paths,
    warn: (line) => process.stderr.write(`${line}\n`),
  });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
