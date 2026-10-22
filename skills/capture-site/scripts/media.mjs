#!/usr/bin/env node
// Media enumeration for a finished capture: every media file the site's pages, stylesheets, REST
// media list and image sitemaps point at, checked with one paced HEAD each (GET when HEAD is
// refused, or to download). Only files on the captured site are listed.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parse } from 'parse5';
import { assertNodeVersion } from '../../../scripts/lib/node-version.mjs';
import { BLOCK_LIMIT, DEFAULT_DELAY_MS, DEFAULT_UA, fetchPaced } from './lib/http.mjs';
import { cssUrls, FONT_EXTENSIONS, IMAGE_EXTENSIONS } from './lib/css-urls.mjs';
import { extensionOf } from './lib/page-rules.mjs';
import { mediaUrlsOf } from './lib/wp-rest.mjs';

const USAGE = `Usage: node media.mjs --capture <dir> [--download <dir>] [--delay <ms>]

List every media file of a captured site in <capture>/media.json:
  [{ url, path, source[], referencedBy[], status, contentType, bytes }]
source is where it was found: html (src, data-src, icons, preloads, links to files), srcset,
css (stylesheets and style attributes), rest (the WordPress media list, every size), sitemap
(image sitemaps), og (og:image, twitter:image). referencedBy lists the pages that use it.
Entries are keyed by path: references to the same path (another query string, http or https,
www or not) are one entry, and the first URL found for it is the one listed and requested.
Each file is checked with one paced HEAD request (GET when HEAD is refused). A file that times
out, resets the connection or answers 403 after 3 tries is listed with that status (0 for a
network error, with \`error\`); three such files in a row stop the run.

  --capture <dir>   the capture folder written by capture.mjs (reads inventory.json,
                    pages/, css/, wp-rest/media.json, sitemaps/)
  --download <dir>  also save every file that answers 200 under <dir>/<path>, byte for byte
  --delay <ms>      wait between requests (default ${DEFAULT_DELAY_MS})
  --ua "<string>"   user agent (default: a desktop Chrome)
  --help            show this help

Run it again after a stop: files already checked (and downloaded) are kept.
Exit codes: 0 done, 2 usage error or no capture, 3 stopped because the site is blocking
requests (wait, then run the same command again).`;

const SOURCE_ORDER = ['html', 'srcset', 'css', 'rest', 'sitemap', 'og'];
const MEDIA_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS, ...FONT_EXTENSIONS,
  'mp4', 'm4v', 'webm', 'mov', 'ogv', 'mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'csv', 'zip',
]);
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original'];
const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];
const ICON_RELS = new Set(['icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon']);
const PRELOAD_AS = new Set(['image', 'font', 'video', 'audio']);
const OG_KEYS = new Set([
  'og:image', 'og:image:url', 'og:image:secure_url', 'og:video', 'og:video:url', 'og:video:secure_url',
  'og:audio', 'twitter:image', 'twitter:image:src',
]);
const BLOCK_STATUSES = new Set([0, 403, 429, 503]);
const HEAD_REFUSED = new Set([400, 403, 405, 501]);
// After its retries, one file's network error or 403 is its answer; a 429 or 503 means the site
// wants us to stop.
const GIVE_UP = new Set([0, 403]);
const GET_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const RETRY_MIN_MS = 500;

class UsageError extends Error {}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const bareHost = (url) => url.host.toLowerCase().replace(/^www\./, '');

function parseArgs(argv) {
  const args = { capture: null, download: null, delayMs: DEFAULT_DELAY_MS, ua: DEFAULT_UA, help: false };
  const value = (i, flag) => {
    if (i >= argv.length || argv[i].startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--capture') args.capture = value((i += 1), arg);
    else if (arg === '--download') args.download = value((i += 1), arg);
    else if (arg === '--ua') args.ua = value((i += 1), arg);
    else if (arg === '--delay') {
      const n = Number(value((i += 1), arg));
      if (!Number.isInteger(n) || n < 0) throw new UsageError('--delay needs a whole number');
      args.delayMs = n;
    } else throw new UsageError(`unknown argument ${arg}`);
  }
  if (!args.help && !args.capture) throw new UsageError('--capture <dir> is required');
  return args;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value ?? null;

// The candidate URLs of a srcset, as the HTML rules read it: skip spaces and commas, take a run
// of non-spaces as the URL (trailing commas end it, with no descriptors), then skip descriptors up
// to the next comma outside parentheses. A URL may itself contain commas (w_300,h_200).
export function srcsetUrls(srcset) {
  const text = String(srcset ?? '');
  const space = (c) => /\s/.test(c);
  const urls = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && (space(text[i]) || text[i] === ',')) i += 1;
    const start = i;
    while (i < text.length && !space(text[i])) i += 1;
    let url = text.slice(start, i);
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else {
      for (let depth = 0; i < text.length; i += 1) {
        const c = text[i];
        if (c === '(') depth += 1;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (c === ',' && depth === 0) break;
      }
    }
    if (url) urls.push(url);
  }
  return urls;
}

// Every media reference in one page's HTML: [{ href, source, needsExtension }]. A style
// attribute's url()s are resolved against the page.
function pageRefs(html, pageUrl) {
  const refs = [];
  const add = (href, source, needsExtension = false) => {
    if (href && !/^data:/i.test(href.trim())) refs.push({ href: href.trim(), source, needsExtension });
  };
  const walk = (node) => {
    const tag = node.tagName;
    if (tag === 'img' || tag === 'source') {
      const lazy = LAZY_SRC.map((n) => attr(node, n)).find(Boolean);
      add(lazy ?? attr(node, 'src'), 'html');
      for (const name of ['srcset', ...LAZY_SRCSET]) for (const url of srcsetUrls(attr(node, name))) add(url, 'srcset');
    } else if (tag === 'video' || tag === 'audio') {
      add(attr(node, 'src'), 'html');
      add(attr(node, 'poster'), 'html');
    } else if (tag === 'link') {
      const rels = (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/);
      if (rels.some((r) => ICON_RELS.has(r))) add(attr(node, 'href'), 'html');
      else if (rels.includes('preload') && PRELOAD_AS.has((attr(node, 'as') ?? '').toLowerCase())) add(attr(node, 'href'), 'html');
    } else if (tag === 'a' || tag === 'area') {
      add(attr(node, 'href'), 'html', true);
    } else if (tag === 'meta') {
      const key = (attr(node, 'property') ?? attr(node, 'name') ?? '').toLowerCase();
      if (OG_KEYS.has(key)) add(attr(node, 'content'), 'og');
    }
    const style = attr(node, 'style');
    if (style) for (const url of cssUrls(`x{${style}}`, pageUrl)) add(url, 'css');
    for (const child of node.content?.childNodes ?? node.childNodes ?? []) walk(child);
  };
  walk(parse(html));
  return refs;
}

function sitemapImages(dir) {
  if (!existsSync(dir)) return [];
  const urls = [];
  for (const name of readdirSync(dir).sort()) {
    let buffer = readFileSync(join(dir, name));
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      try {
        buffer = gunzipSync(buffer);
      } catch {
        continue;
      }
    }
    for (const m of buffer.toString('utf8').matchAll(/<image:loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/image:loc>/gi)) {
      urls.push(m[1].trim().replace(/&amp;/g, '&'));
    }
  }
  return urls;
}

// Every media file the capture points at, keyed by path.
export function collectMedia(captureDir) {
  const meta = existsSync(join(captureDir, 'meta.json')) ? readJson(join(captureDir, 'meta.json')) : {};
  const inventory = readJson(join(captureDir, 'inventory.json'));
  const origin = meta.canonicalOrigin ?? meta.origin ?? (inventory[0] ? new URL(inventory[0].url).origin : null);
  if (!origin) throw new UsageError(`${captureDir} has no origin in meta.json and no pages`);
  const site = new URL(origin);
  const found = new Map();

  const add = (href, base, source, page, needsExtension = false) => {
    let url;
    try {
      url = new URL(href, base);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || bareHost(url) !== bareHost(site)) return;
    url.protocol = site.protocol;
    url.host = site.host;
    url.hash = '';
    if (url.pathname.endsWith('/')) return;
    const ext = extensionOf(url.pathname);
    if (needsExtension && !MEDIA_EXTENSIONS.has(ext)) return;
    const entry = found.get(url.pathname) ?? { url: url.href, path: url.pathname, source: new Set(), referencedBy: new Set() };
    found.set(url.pathname, entry);
    entry.source.add(source);
    if (page) entry.referencedBy.add(page);
  };

  for (const record of inventory) {
    if (record.status !== 200 || !record.snapshot) continue;
    const file = join(captureDir, record.snapshot);
    if (!existsSync(file)) continue;
    const pageUrl = new URL(record.path, origin).href;
    for (const ref of pageRefs(readFileSync(file, 'utf8'), pageUrl)) {
      add(ref.href, pageUrl, ref.source, record.path, ref.needsExtension);
    }
  }

  const manifestFile = join(captureDir, 'css', 'manifest.json');
  for (const entry of existsSync(manifestFile) ? readJson(manifestFile) : []) {
    if (!entry?.file || !existsSync(join(captureDir, 'css', entry.file))) continue;
    const base = entry.href ?? new URL(entry.pages?.[0] ?? '/', origin).href;
    for (const url of cssUrls(readFileSync(join(captureDir, 'css', entry.file), 'utf8'), base)) {
      for (const page of entry.pages?.length ? entry.pages : [null]) add(url, base, 'css', page);
    }
  }

  const restMedia = join(captureDir, 'wp-rest', 'media.json');
  if (existsSync(restMedia)) for (const url of mediaUrlsOf(readJson(restMedia))) add(url, origin, 'rest', null);
  for (const url of sitemapImages(join(captureDir, 'sitemaps'))) add(url, origin, 'sitemap', null);

  return [...found.values()]
    .map((e) => ({
      url: e.url,
      path: e.path,
      source: SOURCE_ORDER.filter((s) => e.source.has(s)),
      referencedBy: [...e.referencedBy].sort(),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function downloadTarget(dir, path) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path;
  }
  const root = resolve(dir);
  const target = resolve(root, `.${decoded}`);
  return target.startsWith(root + sep) ? target : null;
}

const fileHolds = (file, bytes) => {
  try {
    return statSync(file).size === bytes;
  } catch {
    return false;
  }
};

async function main() {
  assertNodeVersion();
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const captureDir = resolve(args.capture);
  if (!existsSync(join(captureDir, 'inventory.json'))) {
    console.error(`No capture in ${captureDir}: inventory.json is missing (run capture.mjs first).`);
    process.exit(2);
  }

  let media;
  try {
    media = collectMedia(captureDir);
  } catch (err) {
    console.error(`Cannot read the capture in ${captureDir}: ${err.message}`);
    process.exit(2);
  }
  const outFile = join(captureDir, 'media.json');
  const earlier = new Map();
  try {
    for (const e of existsSync(outFile) ? readJson(outFile) : []) earlier.set(e.path, e);
  } catch {
    // an unreadable earlier list is simply redone
  }
  const write = () => writeFileSync(outFile, `${JSON.stringify(media, null, 2)}\n`);
  const request = (url, options) => fetchPaced(url, { ...options, delayMs: args.delayMs, ua: args.ua });
  const streak = new Set();

  // Every entry carries the fields from the start, so a stopped run lists what is left as null.
  for (const entry of media) Object.assign(entry, { status: null, contentType: null, bytes: null });
  for (const entry of media) {
    const before = earlier.get(entry.path);
    const target = args.download ? downloadTarget(args.download, entry.path) : null;
    if (before && before.status !== null && !BLOCK_STATUSES.has(before.status)) {
      const downloaded = !args.download || before.status !== 200 || !target || fileHolds(target, before.bytes);
      if (downloaded) {
        Object.assign(entry, { status: before.status, contentType: before.contentType, bytes: before.bytes });
        if (before.location) entry.location = before.location;
        continue;
      }
    }

    let res;
    let viaGet = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      viaGet = Boolean(args.download);
      if (!viaGet) {
        res = await request(entry.url, { method: 'HEAD' });
        const length = res.headers?.['content-length'];
        viaGet = HEAD_REFUSED.has(res.status) || (res.status === 200 && length === undefined);
      }
      if (viaGet) res = await request(entry.url, { raw: true, timeoutMs: GET_TIMEOUT_MS });
      if (!BLOCK_STATUSES.has(res.status)) break;
      if (attempt < MAX_ATTEMPTS) await sleep(Math.max(RETRY_MIN_MS, args.delayMs) * 2 ** (attempt - 1));
    }

    const blocked = BLOCK_STATUSES.has(res.status);
    const stop = () => {
      write();
      console.error(
        `Stopped: ${new URL(entry.url).origin} is blocking requests or cannot be reached. Wait a while, then run the same command again; files already checked are kept.`,
      );
      process.exit(3);
    };
    if (blocked && !GIVE_UP.has(res.status)) stop();
    if (blocked) streak.add(entry.path);
    else streak.clear();

    entry.status = res.status;
    entry.contentType = res.headers?.['content-type'] ?? null;
    const length = Number(res.headers?.['content-length']);
    entry.bytes = res.status === 0 ? null : viaGet ? res.body.length : Number.isFinite(length) ? length : null;
    if (res.status === 0) entry.error = res.error ?? 'network error';
    if (res.status >= 300 && res.status < 400 && res.headers?.location) {
      entry.location = new URL(res.headers.location, entry.url).href;
    }
    if (streak.size >= BLOCK_LIMIT) stop();
    if (args.download && res.status === 200 && target) {
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, res.body);
    }
  }

  write();
  const ok = media.filter((m) => m.status === 200);
  const bytes = ok.reduce((sum, m) => sum + (m.bytes ?? 0), 0);
  const saved = args.download ? `, saved under ${resolve(args.download)}` : '';
  console.log(`Listed ${media.length} media files (${media.length - ok.length} not 200, ${bytes} bytes) in ${outFile}${saved}.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
