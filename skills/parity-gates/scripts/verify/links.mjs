#!/usr/bin/env node
// Links gate: every internal href and src in every built page resolves to a built page, a built
// file, a baseline redirect source or a baseline media path. A link to /about where the build
// serves /about/ is reported as unslashed, even when the live site redirected it.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, gateExceptions, report } from '../lib/gate-cli.mjs';
import { exceptionFailure } from '../lib/exceptions.mjs';
import { attr, findAll, parseHtml } from '../lib/html.mjs';
import { relTokens } from '../lib/head.mjs';
import { srcsetUrls } from '../lib/srcset.mjs';
import { distFiles, feedFiles, htmlPages, originOf, pageFiles, pageFormat, readJson, requireInputs } from '../lib/dist.mjs';

const NAME = 'links';
const OPTIONS = {
  origin: { type: 'string', default: '', description: 'the origin the build is for; absolute links on it are internal (as are links on the baseline origin and canonicalOrigin)' },
};
const NOTES = `
Checked: a/area/link href (not rel=canonical, which the seo gate owns), img/source/script/iframe/
video/audio/track/embed src, srcset, data-src, data-srcset and poster. Root-relative and relative
URLs are internal; so are absolute URLs on --origin or on the baseline's origin or
canonicalOrigin. A link exception names the page in path and the built href in to.
`;
export const BROKEN = 'a built page, file, redirect source or media path';
const SKIP_SCHEME = /^(?:mailto|tel|sms|javascript|data|blob|about):/i;
const URL_ATTRS = {
  a: ['href'],
  area: ['href'],
  link: ['href'],
  img: ['src', 'srcset', 'data-src', 'data-srcset', 'data-lazy-src', 'data-lazy-srcset'],
  source: ['src', 'srcset', 'data-src', 'data-srcset'],
  script: ['src'],
  iframe: ['src', 'data-src'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  embed: ['src'],
};

const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// The URL-bearing attribute values of a page, in document order, each once.
export function pageUrls(html) {
  const urls = [];
  for (const node of findAll(parseHtml(html), (n) => n.tagName in URL_ATTRS)) {
    if (node.tagName === 'link' && relTokens(node).includes('canonical')) continue;
    for (const name of URL_ATTRS[node.tagName]) {
      const value = attr(node, name);
      if (!value || !value.trim()) continue;
      urls.push(...(name.endsWith('srcset') ? srcsetUrls(value) : [value.trim()]));
    }
  }
  return [...new Set(urls)];
}

// null when href resolves, otherwise the failure's expected value.
export function resolveLink(url, { present, format, redirectSources, mediaPaths }) {
  const path = decode(url.pathname);
  const rel = path.replace(/^\/+/, '');
  if (url.search && redirectSources.has(`${path}${url.search}`)) return null;
  const isPage = (p) => pageFiles(p, format).some((c) => present.has(c)) || feedFiles(p).some((c) => present.has(c));
  if (format === 'directory' && !path.endsWith('/') && !present.has(rel) && isPage(`${path}/`)) return `${path}/`;
  if (redirectSources.has(path) || mediaPaths.has(path)) return null;
  if (rel && present.has(rel)) return null;
  if ((path.endsWith('/') || format === 'file') && isPage(path)) return null;
  return BROKEN;
}

export function checkLinks({ dist, redirects, media, meta, exceptions, origin = '', paths = () => true }) {
  const files = distFiles(dist);
  const context = {
    present: new Set(files),
    format: pageFormat(files),
    redirectSources: new Set(redirects.map((r) => decode(r.from))),
    mediaPaths: new Set(media.map((m) => decode(m.path))),
  };
  const base = 'http://links.invalid';
  const internal = new Set([base, originOf(origin), originOf(meta.origin ?? ''), originOf(meta.canonicalOrigin ?? '')].filter(Boolean));
  const relevant = exceptions.filter((e) => e.field === 'link');
  const pages = htmlPages(files).filter((p) => paths(p.path));
  const known = new Set(pages.map((p) => p.path));
  const failures = relevant.filter((e) => paths(e.path) && !known.has(e.path)).map((e) => exceptionFailure(e, 'path not checked'));
  for (const page of pages) {
    const pageUrl = new URL(page.path, base);
    const broken = [];
    for (const href of pageUrls(readFileSync(join(dist, page.file), 'utf8'))) {
      if (href.startsWith('#') || SKIP_SCHEME.test(href)) continue;
      let url;
      try {
        url = new URL(href, pageUrl);
      } catch {
        broken.push({ href, expected: BROKEN });
        continue;
      }
      if (!internal.has(url.origin)) continue;
      const expected = resolveLink(url, context);
      if (expected) broken.push({ href, expected });
    }
    const excepted = new Set();
    for (const exception of relevant.filter((e) => e.path === page.path)) {
      if (broken.some((b) => b.href === exception.to)) excepted.add(exception.to);
      else failures.push(exceptionFailure(exception, 'no longer matches the build'));
    }
    for (const { href, expected } of broken) {
      if (!excepted.has(href)) failures.push({ path: page.path, field: 'link', expected, actual: href });
    }
  }
  return { checked: pages.length, failures };
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { options: OPTIONS, notes: NOTES });
  if (args.origin && !originOf(args.origin)) {
    process.stderr.write(`${NAME}: --origin must be a URL such as https://www.example.com, got ${args.origin}\n`);
    process.exit(2);
  }
  requireInputs(NAME, args.dist, args.baseline, ['redirects.json', 'media.json', 'meta.json']);
  const results = checkLinks({
    dist: args.dist,
    redirects: readJson(join(args.baseline, 'redirects.json')),
    media: readJson(join(args.baseline, 'media.json')),
    meta: readJson(join(args.baseline, 'meta.json')),
    exceptions: gateExceptions(NAME, args),
    origin: args.origin,
    paths: args.paths,
  });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
