#!/usr/bin/env node
// Page capture: a paced, read-only crawl of one site into a capture folder.
// Discovery: the home page, sitemaps (via fingerprint), --seed paths, then every same-site
// <a href>, <link rel=canonical> and HTML/hreflang <link rel=alternate> on a 200 HTML page.
// Each URL is requested once with redirects followed by hand, so chains are recorded hop by
// hop. Shortlinks (`/?p=N`) are recorded as unverified redirects and only requested with
// --verify-shortlinks.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
meta.json, sitemaps/, robots.txt, feeds/ and state.json.

  <origin>              the site, e.g. https://www.example.com
  --out <dir>           the capture folder to write (e.g. capture)
  --delay <ms>          wait between requests (default ${DEFAULT_DELAY_MS})
  --max <n>             stop after n page records (resume later with --resume)
  --resume              continue the crawl saved in <dir>/state.json
  --ua "<string>"       user agent (default: a desktop Chrome)
  --seed <path>         also request this path or URL (repeatable), e.g. old URLs to
                        check for redirects
  --verify-shortlinks   request every ?p= shortlink to confirm where it redirects
                        (by default they are recorded unverified, without a request)
  --include-query       keep query strings (by default only ?p= shortlinks keep theirs)
  --no-rest             do not use the platform's REST API for discovery
  --help                show this help

Never requests wp-admin, wp-login, xmlrpc.php, /wp-json/ or ?s= searches.
Exit codes: 0 done, 2 usage error, 3 stopped because the site is blocking requests or
cannot be reached (wait, then run again with --resume).`;

const BLOCK_STATUSES = new Set([0, 403, 429, 503]);
const MAX_HOPS = 10;
const MAX_ATTEMPTS = 3;
const RETRY_MIN_MS = 500;
const SAVE_EVERY = 25;
const SOURCE_ORDER = ['sitemap', 'rest', 'crawl', 'shortlink', 'seed'];
const PAGE_EXTENSIONS = new Set(['', 'html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'shtml', 'cfm']);
const NEVER = /(?:^|\/)(?:wp-admin|wp-login|xmlrpc\.php)(?:[/.?]|$)/i;
const NOT_PAGES = /^\/wp-json(?:\/|$)/i;
const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)/i;
const FEED_TYPE = /^(application\/(rss|atom)\+xml|application\/xml|text\/xml)/i;
const FEED_ALTERNATE = /^application\/(rss|atom)\+xml$/;

class UsageError extends Error {}
class Blocked extends Error {}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv) {
  const args = {
    origin: null, out: null, delayMs: DEFAULT_DELAY_MS, max: null, resume: false, ua: DEFAULT_UA,
    seeds: [], verifyShortlinks: false, includeQuery: false, noRest: false, help: false,
  };
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
    else if (arg === '--verify-shortlinks') args.verifyShortlinks = true;
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

// Never requested at all, whether linked or reached through a redirect.
const forbidden = (url) => NEVER.test(url.pathname) || url.searchParams.has('s');
// Not a page: never downloaded by the crawl (files are enumerated by the media step).
const notAPage = (url) => !PAGE_EXTENSIONS.has(extensionOf(url.pathname)) || NOT_PAGES.test(url.pathname);

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
    if (forbidden(url)) return null;
    if (!state.options.includeQuery && !isShortlink(url)) url.search = '';
    if (notAPage(url)) return null;
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

const byKey = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

class Crawler {
  constructor(state, { out, fetch, delayMs }) {
    this.state = state;
    this.out = out;
    this.fetch = fetch;
    this.delayMs = delayMs;
    this.seen = new Set(state.seen);
    this.recorded = new Set(state.records.map((r) => r.url));
    this.full = new Map(); // url -> full record of this run (state.records keeps a slim copy)
    this.streak = new Set(); // distinct URLs blocked in a row
    this.lastVisited = null;
  }

  get scope() {
    this.scopeFn ??= scoper(this.state);
    return this.scopeFn;
  }

  retryWait(attempts) {
    return Math.max(RETRY_MIN_MS, this.delayMs) * 2 ** Math.max(0, attempts - 1);
  }

  // Track the block streak: three different URLs blocked in a row means the site is blocking us.
  // A single URL that keeps answering 403 does not count more than once.
  noteBlocked(url) {
    this.streak.add(url);
    return this.streak.size >= BLOCK_LIMIT;
  }

  noteOk() {
    this.streak.clear();
  }

  enqueue(href, source, base, kind = 'page') {
    const key = this.scope(href, base);
    if (!key) return null;
    if (isShortlink(new URL(key))) return null; // recorded as an unverified redirect instead
    const sources = (this.state.foundBy[key] ??= []);
    if (!sources.includes(source)) sources.push(source);
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.state.seen.push(key);
      this.state.queue.push({ url: key, attempts: 0, kind });
    }
    return key;
  }

  // Discovery fetch: retries a blocked answer (spaced out), throws Blocked on a block streak.
  discoveryFetch() {
    return async (url, options) => {
      for (let attempt = 1; ; attempt += 1) {
        const res = await this.fetch(url, options);
        if (!BLOCK_STATUSES.has(res.status)) {
          this.noteOk();
          const path = new URL(url).pathname;
          if (path === '/' && !this.homeRes) this.homeRes = res;
          else if (res.status === 200 && /sitemap|\.xml(\.gz)?$/i.test(path)) {
            writeText(join(this.out, 'sitemaps', sitemapFileName(url)), res.body);
          }
          return res;
        }
        if (this.noteBlocked(url)) throw new Blocked();
        if (attempt >= MAX_ATTEMPTS) return res;
        await sleep(this.retryWait(attempt));
      }
    };
  }

  // Discovery in resumable steps: fingerprint (home, robots, sitemap index), then each sitemap.
  // Returns 'ok' or 'blocked'.
  async discover() {
    const fetch = this.discoveryFetch();
    try {
      if (!this.state.fingerprint) {
        const fp = await fingerprint(this.state.origin, { fetch });
        if (BLOCK_STATUSES.has(fp.homeStatus)) return 'blocked';
        const live = this.homeRes?.finalUrl ? new URL(this.homeRes.finalUrl) : null;
        this.state.canonicalOrigin =
          live && bareHost(live) === bareHost(new URL(this.state.origin)) ? live.origin : this.state.origin;
        if (fp.robots) writeText(join(this.out, 'robots.txt'), fp.robots);
        const { robots, ...rest } = fp;
        this.state.fingerprint = rest;
        this.state.sitemapsDone = [];
        this.enqueue('/', 'crawl');
        for (const seed of this.state.options.seeds ?? []) this.enqueue(seed, 'seed');
        saveState(this.out, this.state);
      }
      for (const sitemap of this.state.fingerprint.sitemapUrls) {
        if (this.state.sitemapsDone.includes(sitemap)) continue;
        const entries = await expandSitemaps([sitemap], { fetch });
        for (const entry of entries) this.enqueue(entry.loc, 'sitemap');
        this.state.sitemapsDone.push(sitemap);
        saveState(this.out, this.state);
      }
    } catch (err) {
      if (err instanceof Blocked) return 'blocked';
      throw err;
    }
    this.state.phase = 'crawl';
    return 'ok';
  }

  // Follow one URL's redirects by hand. Returns { blocked, status } or { res, finalUrl, chain[] }.
  // A hop to another site, a forbidden path, a file or a loop ends the chain without a request.
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
      if (offSite || looped || forbidden(next) || notAPage(next) || hop === MAX_HOPS) {
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

  addRecord(record) {
    this.full.set(record.url, record);
    const { text, jsonLd, ...slim } = record;
    this.state.records.push(slim);
  }

  record(key, res, kind = 'page') {
    this.recorded.add(key);
    const type = res.headers?.['content-type'] ?? '';
    const body = typeof res.body === 'string' ? res.body : '';
    if (res.status === 200 && (FEED_TYPE.test(type) || (kind === 'feed' && !HTML_TYPE.test(type)))) {
      const file = `feeds/${this.slugFor(key)}.xml`;
      writeText(join(this.out, file), res.body);
      this.state.feeds.push({ url: key, path: pathOf(key), status: res.status, contentType: type, file });
      return;
    }
    if (HTML_TYPE.test(type)) {
      const slug = this.slugFor(key);
      const snapshot = `pages/${slug}.html`;
      writeText(join(this.out, snapshot), body);
      const record = extractPage(body, key, { status: res.status, finalUrl: key, snapshot });
      writeText(join(this.out, 'text', `${slug}.txt`), `${record.text}\n`);
      this.addRecord(record);
      if (res.status === 200) this.follow(record);
      return;
    }
    // Any other 200 is a file, not a page; a non-200 is still recorded with its status.
    if (res.status !== 200) this.addRecord(extractPage('', key, { status: res.status, finalUrl: key }));
  }

  follow(record) {
    for (const href of record.internalLinks) this.enqueue(href, 'crawl', record.url);
    if (record.canonical) this.enqueue(record.canonical, 'crawl', record.url);
    for (const alt of record.alternates) {
      if (alt.type && FEED_ALTERNATE.test(alt.type)) this.enqueue(alt.href, 'crawl', record.url, 'feed');
      else if (!alt.type || alt.type === 'text/html' || alt.hreflang) this.enqueue(alt.href, 'crawl', record.url);
    }
  }

  async visit(item) {
    const result = await this.fetchChain(item.url);
    if (result.blocked) return result;
    const { res, chain } = result;
    if (chain.length === 0) {
      this.record(item.url, res, item.kind);
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
    if (!finalKey || isShortlink(new URL(finalKey))) return {};
    if (!this.seen.has(finalKey)) {
      this.seen.add(finalKey);
      this.state.seen.push(finalKey);
      this.state.foundBy[finalKey] = [...(this.state.foundBy[item.url] ?? ['crawl'])];
      if (res && result.finalUrl === finalKey) this.record(finalKey, res, item.kind);
      else this.state.queue.push({ url: finalKey, attempts: 0, kind: item.kind });
    } else if (res && result.finalUrl === finalKey && !this.recorded.has(finalKey)) {
      // In place: drain() holds this same array.
      const queued = this.state.queue.findIndex((q) => q.url === finalKey);
      if (queued !== -1) this.state.queue.splice(queued, 1);
      this.record(finalKey, res, item.kind);
    }
    return {};
  }

  // Shortlinks that point at a page (its rel=shortlink) or appear in a page's links.
  shortlinks() {
    const found = new Map();
    const records = this.state.records.filter((r) => r.status === 200);
    for (const r of records) {
      if (r.shortlink?.startsWith('/') && isShortlink(new URL(r.shortlink, this.state.canonicalOrigin))) {
        if (!found.has(r.shortlink)) found.set(r.shortlink, r.path);
      }
    }
    for (const r of records) {
      for (const link of r.internalLinks) {
        if (!found.has(link) && isShortlink(new URL(link, this.state.canonicalOrigin))) found.set(link, null);
      }
    }
    return found;
  }

  async visitShortlink(item) {
    const result = await this.fetchChain(new URL(item.url, this.state.canonicalOrigin).href);
    if (result.blocked) return result;
    const { res, chain } = result;
    const final = chain.length === 0 ? null : result.offSite ? result.finalUrl : pathOf(result.finalUrl);
    this.state.shortlinkChecks[item.url] = {
      to: final,
      status: chain[0]?.status ?? res.status,
      hops: chain.slice(1).map((c) => pathOf(c.url)),
    };
    return {};
  }

  // Work through a queue with per-URL retries and the block streak.
  // Returns 'done', 'max' or 'blocked'.
  async drain(queue, visit, giveUp, max = null) {
    let sinceSave = 0;
    while (queue.length > 0) {
      if (max && this.state.records.length >= max) return 'max';
      const item = queue.shift();
      if (item.attempts > 0 && this.lastVisited === item.url) await sleep(this.retryWait(item.attempts));
      this.lastVisited = item.url;
      const result = await visit(item);
      if (result.blocked) {
        if (this.noteBlocked(item.url)) {
          queue.unshift(item);
          return 'blocked';
        }
        item.attempts += 1;
        if (item.attempts < MAX_ATTEMPTS) queue.push(item);
        else giveUp(item, result.status);
      } else this.noteOk();
      sinceSave += 1;
      if (sinceSave >= SAVE_EVERY) {
        saveState(this.out, this.state);
        sinceSave = 0;
      }
    }
    return 'done';
  }

  async crawl(max) {
    const outcome = await this.drain(
      this.state.queue,
      (item) => this.visit(item),
      (item, status) => this.record(item.url, { status, headers: {}, body: '' }, item.kind),
      max,
    );
    if (outcome === 'done') this.state.phase = 'done';
    return outcome;
  }

  async verifyShortlinks() {
    this.state.shortlinkChecks ??= {};
    this.state.verifyQueue ??= [];
    const queued = new Set(this.state.verifyQueue.map((q) => q.url));
    for (const from of this.shortlinks().keys()) {
      if (!this.state.shortlinkChecks[from] && !queued.has(from)) this.state.verifyQueue.push({ url: from, attempts: 0 });
    }
    return this.drain(
      this.state.verifyQueue,
      (item) => this.visitShortlink(item),
      (item, status) => {
        this.state.shortlinkChecks[item.url] = { to: null, status, hops: [] };
      },
    );
  }

  // A record from an earlier run keeps text and JSON-LD on disk only; read them back.
  fullRecord(slim) {
    const kept = this.full.get(slim.url);
    if (kept) return kept;
    if (!slim.snapshot) return { ...slim, text: '', jsonLd: [] };
    const html = readFileSync(join(this.out, slim.snapshot), 'utf8');
    const slug = slim.snapshot.replace(/^pages\//, '').replace(/\.html$/, '');
    const text = readFileSync(join(this.out, 'text', `${slug}.txt`), 'utf8').trim();
    return { ...slim, text, jsonLd: extractPage(html, slim.url).jsonLd };
  }

  redirectList() {
    const byFrom = new Map(this.state.redirects.map((r) => [r.from, r]));
    const checks = this.state.shortlinkChecks ?? {};
    for (const [from, to] of this.shortlinks()) {
      if (byFrom.has(from)) continue;
      const check = checks[from];
      byFrom.set(
        from,
        check
          ? { from, to: check.to, status: check.status, source: 'shortlink', verified: true, hops: check.hops }
          : { from, to, status: to ? 301 : null, source: 'shortlink', verified: false, hops: [] },
      );
    }
    return [...byFrom.values()].sort(byKey('from'));
  }

  writeOutputs({ finished }) {
    const { records, feeds, foundBy } = this.state;
    const inventory = records
      .map((r) => {
        const { text, jsonLd, snapshot, alternates, shortlink, ...head } = this.fullRecord(r);
        // Keep the brief's field order: snapshot and text last, then the crawl extras.
        return { ...head, snapshot, text, jsonLd, alternates, shortlink, foundBy: sortSources(foundBy[r.url] ?? []) };
      })
      .sort(byKey('path'));
    const json = (file, data) => writeText(join(this.out, file), `${JSON.stringify(data, null, 2)}\n`);
    json('inventory.json', inventory);
    json('redirects.json', this.redirectList());
    json('feeds/index.json', [...feeds].sort(byKey('path')));
    json('meta.json', {
      origin: this.state.origin,
      canonicalOrigin: this.state.canonicalOrigin ?? null,
      startedAt: this.state.startedAt,
      finishedAt: finished ? new Date().toISOString() : null,
      options: this.state.options,
    });

    const internal = {};
    const external = {};
    const add = (map, target, from) => {
      (map[target] ??= new Set()).add(from);
    };
    for (const r of inventory) {
      for (const link of r.internalLinks) if (link !== r.path) add(internal, link, r.path);
      for (const link of r.externalLinks) add(external, link, r.path);
    }
    const plain = (map) => Object.fromEntries(Object.keys(map).sort().map((k) => [k, [...map[k]].sort()]));
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
  const crawler = new Crawler(state, { out, fetch, delayMs: args.delayMs });
  const stopBlocked = () => {
    saveState(out, state);
    console.error(
      `Stopped: ${state.origin} is blocking requests or cannot be reached. Wait a while, then run the same command with --resume.`,
    );
    process.exit(3);
  };

  if (state.phase === 'discover') {
    if ((await crawler.discover()) === 'blocked') stopBlocked();
    saveState(out, state);
  }

  let outcome = state.phase === 'crawl' ? await crawler.crawl(args.max) : 'done';
  if (outcome === 'done' && args.verifyShortlinks) outcome = await crawler.verifyShortlinks();
  const inventory = crawler.writeOutputs({ finished: outcome === 'done' });
  if (outcome === 'blocked') stopBlocked();
  saveState(out, state);

  const failed = inventory.filter((r) => r.status !== 200).length;
  const tail = outcome === 'max' ? ` Stopped at --max ${args.max}; ${state.queue.length} URLs left (use --resume).` : '';
  console.log(
    `Captured ${inventory.length} pages (${failed} not 200), ${crawler.redirectList().length} redirects, ${state.feeds.length} feeds into ${out}.${tail}`,
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
