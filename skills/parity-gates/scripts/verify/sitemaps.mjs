#!/usr/bin/env node
// Sitemaps gate: dist/sitemap-index.xml (or sitemap.xml) lists exactly the indexable pages,
// posts and archives the baseline recorded at 200, on the build's origin, and every feed the
// live site served is built with as many items as the captured feed.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, report } from '../lib/gate-cli.mjs';
import { feedFiles, firstExisting, originOf, PAGE_KINDS, readJson, requireInputs } from '../lib/dist.mjs';

const NAME = 'sitemaps';
const OPTIONS = {
  capture: { type: 'string', default: 'capture', description: 'the capture folder, for the captured feeds' },
  origin: { type: 'string', default: '', description: 'the origin the sitemap URLs must be on (default: canonicalOrigin in baseline/meta.json)' },
};
const NOTES = `
Expected in the sitemap: every page, post and archive route at 200 without noindex. A sitemap
index is followed to its child sitemaps in dist. Feed items are <item> (RSS) or <entry> (Atom).
`;
const TOP = ['sitemap-index.xml', 'sitemap.xml'];

const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function locs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/g)].map((m) => unescapeXml(m[1]));
}

export const itemCount = (xml) => (xml.match(/<(?:item|entry)[\s>]/g) ?? []).length;

const pathOf = (loc) => {
  try {
    return decode(new URL(loc).pathname);
  } catch {
    return loc;
  }
};

// { urls: [loc], failures } from the top sitemap and, for an index, its children in dist.
export function readSitemaps(dist) {
  const top = firstExisting(dist, TOP);
  if (!top) return { urls: null, failures: [{ path: '/', field: 'sitemap', expected: TOP[0], actual: null }] };
  const xml = readFileSync(join(dist, top), 'utf8');
  if (!/<sitemapindex[\s>]/.test(xml)) return { urls: locs(xml), failures: [] };
  const urls = [];
  const failures = [];
  for (const child of locs(xml)) {
    const path = pathOf(child);
    const file = path.replace(/^\/+/, '');
    if (!file || !existsSync(join(dist, file))) {
      failures.push({ path, field: 'sitemap', expected: file, actual: null });
      continue;
    }
    urls.push(...locs(readFileSync(join(dist, file), 'utf8')));
  }
  return { urls, failures };
}

export function checkSitemaps({ dist, capture, routes, compareOrigin, paths = () => true }) {
  const pages = routes.filter((r) => r.status === 200 && PAGE_KINDS.has(r.kind) && !r.noindex && paths(r.path));
  const feeds = routes.filter((r) => r.status === 200 && r.kind === 'feed' && paths(r.path));
  const { urls, failures } = readSitemaps(dist);
  if (urls) {
    const listed = new Map();
    for (const url of urls) if (!listed.has(pathOf(url))) listed.set(pathOf(url), url);
    const expected = new Set(pages.map((r) => decode(r.path)));
    for (const path of expected) {
      const want = `${compareOrigin}${new URL(path, compareOrigin).pathname}`;
      const got = listed.get(path) ?? null;
      if (got !== want) failures.push({ path, field: 'sitemap', expected: want, actual: got });
    }
    for (const [path, url] of listed) {
      if (!expected.has(path) && paths(path)) failures.push({ path, field: 'sitemap', expected: null, actual: url });
    }
  }
  for (const feed of feeds) {
    const candidates = feedFiles(feed.path);
    const file = firstExisting(dist, candidates);
    if (!file) {
      failures.push({ path: feed.path, field: 'feed', expected: candidates[0], actual: null });
      continue;
    }
    const captured = feed.snapshot ? join(capture, feed.snapshot) : null;
    if (!captured || !existsSync(captured)) {
      failures.push({ path: feed.path, field: 'baseline', expected: feed.snapshot ?? 'a captured feed', actual: null });
      continue;
    }
    const want = itemCount(readFileSync(captured, 'utf8'));
    const got = itemCount(readFileSync(join(dist, file), 'utf8'));
    if (want !== got) failures.push({ path: feed.path, field: 'items', expected: want, actual: got });
  }
  return { checked: pages.length + feeds.length, failures };
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { options: OPTIONS, notes: NOTES });
  if (args.origin && !originOf(args.origin)) {
    process.stderr.write(`${NAME}: --origin must be a URL such as https://www.example.com, got ${args.origin}\n`);
    process.exit(2);
  }
  requireInputs(NAME, args.dist, args.baseline, ['routes.json', 'meta.json']);
  const routes = readJson(join(args.baseline, 'routes.json'));
  const meta = readJson(join(args.baseline, 'meta.json'));
  const compareOrigin = originOf(args.origin) ?? originOf(meta.canonicalOrigin ?? '') ?? originOf(meta.origin ?? '');
  if (!compareOrigin) {
    process.stderr.write(`${NAME}: ${join(args.baseline, 'meta.json')} has no canonicalOrigin or origin; rebuild the baseline\n`);
    process.exit(2);
  }
  const hasFeeds = routes.some((r) => r.status === 200 && r.kind === 'feed' && args.paths(r.path));
  if (hasFeeds && !(existsSync(args.capture) && statSync(args.capture).isDirectory())) {
    process.stderr.write(`${NAME}: not found: ${args.capture} (the capture, for its feeds; pass --capture)\n`);
    process.exit(2);
  }
  const results = checkSitemaps({ dist: args.dist, capture: args.capture, routes, compareOrigin, paths: args.paths });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
