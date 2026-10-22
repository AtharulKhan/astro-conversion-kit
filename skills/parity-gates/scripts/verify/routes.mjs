#!/usr/bin/env node
// Routes gate: every page, post, archive and feed the baseline recorded at 200 is built, every
// noindex route still says noindex, and the build has nothing the live site did not.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, pathMatcher, report } from '../lib/gate-cli.mjs';
import { attr, find, parseHtml } from '../lib/html.mjs';
import { distFiles, feedFiles, pageFiles, pageFormat, PAGE_KINDS, readJson, requireInputs, servedPath } from '../lib/dist.mjs';

const NAME = 'routes';
const OPTIONS = {
  'allow-extra': { type: 'string', default: '', description: 'comma-separated extra paths the build may have, * matches anything' },
};
// Files every Astro build may carry besides the baseline routes, media and redirect sources.
const ALWAYS_ALLOWED = [
  /^404\.html$/,
  /^_astro\//,
  /^robots\.txt$/,
  /^sitemap(?:-index|-\d+)?\.xml$/,
  /^_(?:redirects|headers|routes\.json)$/,
  // The icon set and web app manifest a launch needs (pre-launch checks for them at the root).
  /^favicon(?:-[\w.-]+)?\.(?:ico|svg|png)$/,
  /^icon-[\w.-]+\.png$/,
  /^apple-touch-icon(?:-[\w.-]+)?\.png$/,
  /^(?:site|manifest)\.webmanifest$/,
];
const NOTES = `
A page may be built as <path>/index.html or <path>.html; both are accepted for every route.
The .html form (build.format "file") is served at /about rather than /about/, so the live site's
slashed URLs change: the redirects gate checks that they still answer.
Redirect sources are allowed as pages (Astro writes a meta-refresh page for each redirect).
The site's own scripts the capture saved (baseline/js.json) may be built at their live paths,
and the live sitemap file names (baseline/sitemaps.json) at the root; built or not, they are
never extras.
`;

function robotsOf(html) {
  const meta = find(parseHtml(html), (n) => n.tagName === 'meta' && (attr(n, 'name') ?? '').toLowerCase() === 'robots');
  return meta ? attr(meta, 'content') : null;
}

const decode = (path) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

export function checkRoutes({ dist, routes, media, redirects = [], scripts = [], sitemaps = [], paths = () => true, allowExtra = () => false }) {
  const files = distFiles(dist);
  const present = new Set(files);
  const format = pageFormat(files);
  const expected = new Set();
  const failures = [];
  let checked = 0;

  for (const route of routes) {
    if (route.status !== 200) continue;
    const isFeed = route.kind === 'feed';
    if (!isFeed && !PAGE_KINDS.has(route.kind)) continue;
    const candidates = isFeed ? feedFiles(route.path) : pageFiles(route.path, format);
    candidates.forEach((c) => expected.add(c));
    if (!paths(route.path)) continue;
    checked += 1;
    const file = candidates.find((c) => present.has(c));
    if (!file) {
      failures.push({ path: route.path, field: 'file', expected: candidates[0], actual: null });
      continue;
    }
    if (route.noindex) {
      const robots = robotsOf(readFileSync(join(dist, file), 'utf8'));
      if (!/\bnoindex\b/i.test(robots ?? '')) failures.push({ path: route.path, field: 'robots', expected: 'noindex', actual: robots });
    }
  }

  for (const item of media) expected.add(decode(item.path).replace(/^\/+/, ''));
  for (const script of scripts) expected.add(decode(new URL(script.src).pathname).replace(/^\/+/, ''));
  for (const name of sitemaps) expected.add(name);
  for (const redirect of redirects) pageFiles(redirect.from, format).forEach((c) => expected.add(c));
  for (const file of files) {
    if (expected.has(file) || ALWAYS_ALLOWED.some((re) => re.test(file))) continue;
    const path = servedPath(file);
    if (!paths(path) || allowExtra(path) || allowExtra(`/${file}`)) continue;
    failures.push({ path, field: 'extra', expected: null, actual: file });
  }
  return { checked, failures };
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { options: OPTIONS, notes: NOTES });
  requireInputs(NAME, args.dist, args.baseline, ['routes.json', 'media.json', 'redirects.json']);
  const results = checkRoutes({
    dist: args.dist,
    routes: readJson(join(args.baseline, 'routes.json')),
    media: readJson(join(args.baseline, 'media.json')),
    redirects: readJson(join(args.baseline, 'redirects.json')),
    scripts: existsSync(join(args.baseline, 'js.json')) ? readJson(join(args.baseline, 'js.json')) : [],
    sitemaps: existsSync(join(args.baseline, 'sitemaps.json')) ? readJson(join(args.baseline, 'sitemaps.json')) : [],
    paths: args.paths,
    allowExtra: args.allowExtra ? pathMatcher(args.allowExtra) : () => false,
  });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
