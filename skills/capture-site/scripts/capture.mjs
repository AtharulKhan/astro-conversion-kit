#!/usr/bin/env node
// Page capture: a paced, read-only crawl of one site into a capture folder.
// Discovery: the home page, sitemaps (via fingerprint), --seed paths, then every same-site
// <a href>, <link rel=canonical|alternate|shortlink> on a 200 HTML page. Each URL is requested
// once with redirects followed by hand, so chains are recorded hop by hop.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../../../scripts/lib/node-version.mjs';
import { fingerprint } from './fingerprint.mjs';
import { BLOCK_LIMIT, DEFAULT_DELAY_MS, DEFAULT_UA, fetchPaced, http } from './lib/http.mjs';
import { expandSitemaps } from './lib/sitemaps.mjs';
import { extractPage } from './lib/extract.mjs';
import { slugFor } from './lib/slug.mjs';
import { loadState, newState, saveState } from './lib/state.mjs';

const USAGE = `Usage: node capture.mjs <origin> --out <dir> [options]

Crawl a live site, read-only and paced, into a capture folder: one record per page in
inventory.json, the raw HTML in pages/<slug>.html, the visible text in text/<slug>.txt,
redirects.json (chains collapsed, hops kept), links.json, scripts.json (third-party vendors),
sitemaps/, robots.txt, feeds/ and state.json.

  <origin>              the site, e.g. https://www.example.com
  --out <dir>           the capture folder to write (e.g. capture)
  --delay <ms>          wait between requests (default ${DEFAULT_DELAY_MS})
  --max <n>             stop after n page records (resume later with --resume)
  --resume              continue the crawl saved in <dir>/state.json
  --ua "<string>"       user agent (default: a desktop Chrome)
  --seed <path>         also request this path or URL (repeatable), e.g. old URLs to
                        check for redirects
  --include-query       keep query strings (by default only ?p= shortlinks keep theirs)
  --no-rest             do not use the platform's REST API for discovery
  --help                show this help

Never requests wp-admin, wp-login, xmlrpc.php or ?s= searches.
Exit codes: 0 done, 2 usage or unreachable site, 3 stopped because the site is blocking
requests (wait, then run again with --resume).`;

const BLOCK_STATUSES = new Set([0, 403, 429, 503]);
const SLOW_DOWN = new Set([429, 503]);
const MAX_HOPS = 10;
const MAX_ATTEMPTS = 3;
const SAVE_EVERY = 25;
const SOURCE_ORDER = ['sitemap', 'rest', 'crawl', 'shortlink', 'seed'];
const PAGE_EXTENSIONS = new Set(['', 'html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'shtml', 'cfm']);
const NEVER = /(?:^|\/)(?:wp-admin|wp-login|xmlrpc\.php)(?:[/.?]|$)/i;
const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)/i;
const FEED_TYPE = /^(application\/(rss|atom)\+xml|application\/xml|text\/xml)/i;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { origin: null, out: null, delayMs: DEFAULT_DELAY_MS, max: null, resume: false, ua: DEFAULT_UA, seeds: [], includeQuery: false, noRest: false, help: false };
  const value = (i, flag) => {
    if (i >= argv.length || argv[i].startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--out') args.out = value((i += 1), arg);
    else if (arg === '--delay' || arg === '--max') {
      const n = Number(value((i += 1), arg));
      if (!Number.isInteger(n) || n < (arg === '--max' ? 1 : 0)) throw new UsageError(`${arg} needs a whole number`);
      if (arg === '--delay') args.delayMs = n;
      else args.max = n;
    } else if (arg === '--ua') args.ua = value((i += 1), arg);
    else if (arg === '--seed') args.seeds.push(value((i += 1), arg));
    else if (arg === '--resume') args.resume = true;
    else if (arg === '--include-query') args.includeQuery = true;
    else if (arg === '--no-rest') args.noRest = true;
    else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else if (args.origin) throw new UsageError('only one origin is allowed');
    else args.origin = arg;
  }
  if (args.help) return args;
  if (!args.origin) throw new UsageError('an origin is required');
  try {
    const origin = new URL(args.origin);
    if (!/^https?:$/.test(origin.protocol)) throw new Error();
    args.origin = origin.origin;
  } catch {
    throw new UsageError(`${args.origin} is not an http(s) origin`);
  }
  if (!args.out) throw new UsageError('--out <dir> is required');
  return args;
}

const bareHost = (url) => url.host.toLowerCase().replace(/^www\./, '');
const pathOf = (href) => {
  const url = new URL(href);
  return url.pathname + url.search;
};

function isShortlink(url) {
  if (url.pathname !== '/') return false;
  const keys = [...url.searchParams.keys()];
  return keys.length === 1 && ['p', 'page_id'].includes(keys[0]) && /^\d+$/.test(url.searchParams.get(keys[0]));
}

function extensionOf(pathname) {
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
}

// The crawl's view of a URL: its canonical key (same site, canonical scheme and host, no
// fragment, query kept only where the rules allow), or null when it is out of scope.
function scoper(state) {
  const canonical = new URL(state.canonicalOrigin);
  return (href, base = state.canonicalOrigin) => {
    let url;
    try {
      url = new URL(href, base);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(url.protocol) || bareHost(url) !== bareHost(canonical)) return null;
    url.protocol = canonical.protocol;
    url.host = canonical.host;
    url.hash = '';
    if (url.searchParams.has('s')) return null;
    if (!state.options.includeQuery && !isShortlink(url)) url.search = '';
    if (NEVER.test(url.pathname)) return null;
    if (!PAGE_EXTENSIONS.has(extensionOf(url.pathname))) return null;
    return url.href;
  };
}

function sourceFor(key, foundBy) {
  if (isShortlink(new URL(key))) return 'shortlink';
  const sources = foundBy[key] ?? [];
  return ['sitemap', 'rest', 'crawl', 'seed'].find((s) => sources.includes(s)) ?? 'crawl';
}

function sortSources(sources) {
  return [...new Set(sources)].sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
}

function writeText(file, content) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

function sitemapFileName(href) {
  const url = new URL(href);
  const name = basename(url.pathname) || 'sitemap.xml';
  if (!url.search) return name;
  const suffix = url.search.slice(1).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return name.replace(/(\.xml(?:\.gz)?)?$/i, (ext) => `-${suffix}${ext}`);
}

class Crawler {
  constructor(state, { out, fetch }) {
    this.state = state;
    this.out = out;
    this.fetch = fetch;
    this.seen = new Set(state.seen);
    this.recorded = new Set(state.records.map((r) => r.url));
  }

  get scope() {
    this.scopeFn ??= scoper(this.state);
    return this.scopeFn;
  }

  enqueue(href, source, base) {
    const key = this.scope(href, base);
    if (!key) return null;
    const sources = (this.state.foundBy[key] ??= []);
    if (!sources.includes(source)) sources.push(source);
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.state.seen.push(key);
      this.state.queue.push({ url: key, attempts: 0 });
    }
    return key;
  }

  // Discovery: fingerprint (home, robots, sitemap index), then the sitemaps themselves.
  // Returns 'ok', 'blocked' or 'unreachable'.
  async discover(seeds) {
    let home = null;
    let slowedDown = false;
    const recording = async (url, options) => {
      const res = await this.fetch(url, options);
      if (SLOW_DOWN.has(res.status)) slowedDown = true;
      const path = new URL(url).pathname;
      if (!home && path === '/') home = res;
      else if (res.status === 200 && /sitemap|\.xml(\.gz)?$/i.test(path)) {
        writeText(join(this.out, 'sitemaps', sitemapFileName(url)), res.body);
      }
      return res;
    };

    const fp = await fingerprint(this.state.origin, { fetch: recording });
    if (fp.homeStatus === 0) return 'unreachable';
    if (BLOCK_STATUSES.has(fp.homeStatus)) return 'blocked';
    const live = home?.finalUrl ? new URL(home.finalUrl) : null;
    this.state.canonicalOrigin =
      live && bareHost(live) === bareHost(new URL(this.state.origin)) ? live.origin : this.state.origin;
    if (fp.robots) writeText(join(this.out, 'robots.txt'), fp.robots);

    const entries = await expandSitemaps(fp.sitemapUrls, { fetch: recording });
    if (slowedDown || http.blocked >= BLOCK_LIMIT) return 'blocked';

    const { robots, ...rest } = fp;
    this.state.fingerprint = rest;
    this.enqueue('/', 'crawl');
    for (const seed of seeds) this.enqueue(seed, 'seed');
    for (const entry of entries) this.enqueue(entry.loc, 'sitemap');
    this.state.phase = 'crawl';
    return 'ok';
  }

  // Follow one URL's redirects by hand. Returns { blocked } or { res, finalUrl, chain[] }.
  async fetchChain(start) {
    const chain = [];
    let current = start;
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      const res = await this.fetch(current, { redirect: 'manual' });
      if (BLOCK_STATUSES.has(res.status)) return { blocked: true, status: res.status };
      const location = res.headers?.location;
      if (res.status < 300 || res.status >= 400 || !location) return { res, finalUrl: current, chain };
      chain.push({ url: current, status: res.status });
      const next = new URL(location, current);
      next.hash = '';
      const offSite = bareHost(next) !== bareHost(new URL(this.state.canonicalOrigin));
      const looped = chain.some((c) => c.url === next.href);
      if (offSite || looped || NEVER.test(next.pathname) || hop === MAX_HOPS) {
        return { res: null, finalUrl: next.href, chain, offSite, looped };
      }
      current = next.href;
    }
    return { res: null, finalUrl: current, chain };
  }

  slugFor(key) {
    let slug = slugFor(pathOf(key));
    for (let n = 2; this.state.slugs[slug] && this.state.slugs[slug] !== key; n += 1) slug = `${slugFor(pathOf(key))}-${n}`;
    this.state.slugs[slug] = key;
    return slug;
  }

  record(key, res) {
    this.recorded.add(key);
    const type = res.headers?.['content-type'] ?? '';
    const body = typeof res.body === 'string' ? res.body : '';
    if (HTML_TYPE.test(type)) {
      const slug = this.slugFor(key);
      const snapshot = `pages/${slug}.html`;
      writeText(join(this.out, snapshot), body);
      const record = extractPage(body, key, { status: res.status, finalUrl: key, snapshot });
      writeText(join(this.out, 'text', `${slug}.txt`), `${record.text}\n`);
      this.state.records.push(record);
      if (res.status === 200) this.follow(record);
      return;
    }
    if (res.status === 200 && FEED_TYPE.test(type)) {
      const file = `feeds/${this.slugFor(key)}.xml`;
      writeText(join(this.out, file), res.body);
      this.state.feeds.push({ url: key, path: pathOf(key), status: res.status, contentType: type, file });
      return;
    }
    // Any other 200 is a file, not a page; a non-200 is still recorded with its status.
    if (res.status !== 200) this.state.records.push(extractPage('', key, { status: res.status, finalUrl: key }));
  }

  follow(record) {
    const sourceOf = (href) => {
      try {
        return isShortlink(new URL(href, record.url)) ? 'shortlink' : 'crawl';
      } catch {
        return 'crawl';
      }
    };
    const targets = [...record.internalLinks, record.canonical, ...record.alternates].filter(Boolean);
    for (const href of targets) this.enqueue(href, sourceOf(href), record.url);
    if (record.shortlink) this.enqueue(record.shortlink, 'shortlink', record.url);
  }

  async visit(item) {
    const result = await this.fetchChain(item.url);
    if (result.blocked) return result;
    const { res, chain } = result;
    if (chain.length === 0) {
      this.record(item.url, res);
      return {};
    }

    const finalKey = result.offSite ? null : this.scope(result.finalUrl);
    this.state.redirects.push({
      from: pathOf(item.url),
      to: result.offSite ? result.finalUrl : pathOf(result.finalUrl),
      status: chain[0].status,
      source: sourceFor(item.url, this.state.foundBy),
      hops: chain.slice(1).map((c) => pathOf(c.url)),
      ...(result.looped ? { error: 'loop' } : {}),
    });
    if (!finalKey) return {};
    if (!this.seen.has(finalKey)) {
      this.seen.add(finalKey);
      this.state.seen.push(finalKey);
      this.state.foundBy[finalKey] = [...(this.state.foundBy[item.url] ?? ['crawl'])];
      if (res && result.finalUrl === finalKey) this.record(finalKey, res);
      else this.state.queue.push({ url: finalKey, attempts: 0 });
    } else if (res && result.finalUrl === finalKey && !this.recorded.has(finalKey)) {
      this.state.queue = this.state.queue.filter((q) => q.url !== finalKey);
      this.record(finalKey, res);
    }
    return {};
  }

  // Returns 'done', 'max' or 'blocked'.
  async crawl(max) {
    let sinceSave = 0;
    while (this.state.queue.length > 0) {
      if (max && this.state.records.length >= max) return 'max';
      const item = this.state.queue.shift();
      const result = await this.visit(item);
      if (result.blocked) {
        if (http.blocked >= BLOCK_LIMIT) {
          this.state.queue.unshift(item);
          return 'blocked';
        }
        item.attempts += 1;
        if (item.attempts < MAX_ATTEMPTS) this.state.queue.push(item);
        else this.record(item.url, { status: result.status, headers: {}, body: '' });
      }
      sinceSave += 1;
      if (sinceSave >= SAVE_EVERY) {
        saveState(this.out, this.state);
        sinceSave = 0;
      }
    }
    this.state.phase = 'done';
    return 'done';
  }

  writeOutputs() {
    const { records, redirects, feeds, foundBy } = this.state;
    const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const inventory = records.map((r) => ({ ...r, foundBy: sortSources(foundBy[r.url] ?? []) })).sort(byPath);
    const json = (file, data) => writeText(join(this.out, file), `${JSON.stringify(data, null, 2)}\n`);
    json('inventory.json', inventory);
    json('redirects.json', [...redirects].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)));
    json('feeds/index.json', [...feeds].sort(byPath));

    const internal = {};
    const external = {};
    const add = (map, target, from) => {
      (map[target] ??= new Set()).add(from);
    };
    for (const r of inventory) {
      for (const link of r.internalLinks) if (link !== r.path) add(internal, link, r.path);
      for (const link of r.externalLinks) add(external, link, r.path);
    }
    const plain = (map) =>
      Object.fromEntries(Object.keys(map).sort().map((k) => [k, [...map[k]].sort()]));
    json('links.json', { internal: plain(internal), external: plain(external) });

    const vendors = {};
    for (const r of inventory) {
      for (const s of r.scripts) {
        if (s.vendor === 'other') continue;
        const v = (vendors[s.vendor] ??= { id: null, ids: [], pages: [] });
        if (s.id && !v.ids.includes(s.id)) v.ids.push(s.id);
        if (!v.pages.includes(r.path)) v.pages.push(r.path);
        v.id ??= s.id;
      }
    }
    json('scripts.json', Object.fromEntries(Object.keys(vendors).sort().map((k) => [k, vendors[k]])));
    return inventory;
  }
}

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

  const out = resolve(args.out);
  let state;
  if (args.resume) {
    try {
      state = loadState(out);
    } catch (err) {
      console.error(`Cannot read the saved crawl: ${err.message}`);
      process.exit(2);
    }
    if (!state) {
      console.error(`Nothing to resume: ${join(out, 'state.json')} does not exist.`);
      process.exit(2);
    }
    if (bareHost(new URL(state.origin)) !== bareHost(new URL(args.origin))) {
      console.error(`The saved crawl in ${out} is for ${state.origin}, not ${args.origin}.`);
      process.exit(2);
    }
  } else {
    state = newState(args.origin, { includeQuery: args.includeQuery, noRest: args.noRest, seeds: args.seeds });
  }
  mkdirSync(out, { recursive: true });

  http.resetBlocked();
  const fetch = (url, options) => fetchPaced(url, { ...options, delayMs: args.delayMs, ua: args.ua });
  const crawler = new Crawler(state, { out, fetch });
  const stopBlocked = () => {
    saveState(out, state);
    console.error(`Stopped: ${state.origin} is blocking requests. Wait a while, then run the same command with --resume.`);
    process.exit(3);
  };

  if (state.phase === 'discover') {
    const discovered = await crawler.discover(state.options.seeds ?? []);
    if (discovered === 'unreachable') {
      console.error(`Could not reach ${state.origin}.`);
      process.exit(2);
    }
    if (discovered === 'blocked') stopBlocked();
    saveState(out, state);
  }

  const outcome = state.phase === 'crawl' ? await crawler.crawl(args.max) : 'done';
  const inventory = crawler.writeOutputs();
  if (outcome === 'blocked') stopBlocked();
  saveState(out, state);

  const failed = inventory.filter((r) => r.status !== 200).length;
  const tail = outcome === 'max' ? ` Stopped at --max ${args.max}; ${state.queue.length} URLs left (use --resume).` : '';
  console.log(
    `Captured ${inventory.length} pages (${failed} not 200), ${state.redirects.length} redirects, ${state.feeds.length} feeds into ${out}.${tail}`,
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
