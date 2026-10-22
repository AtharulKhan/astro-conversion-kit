// Sitemap expansion: walk sitemap indexes down to their leaf URL sets.
// expandSitemaps(urls, { fetch, onError }) -> [{ loc, lastmod, source }], deduplicated by loc, first
// source wins. A gzipped sitemap that decodes past MAX_TEXT_BYTES (http.mjs's 20 MB text cap, so
// a small .xml.gz cannot expand to gigabytes in memory) is skipped and reported to
// onError({ url, status: 'too-large' }); parseSitemap marks it { tooLarge: true } with no entries.
// A bare `/sitemap.xml` that is a URL set is also paged Drupal-style (`?page=1`, `?page=2`, ...)
// until a page is non-200, lists no <loc>, or adds nothing new.

import { gunzipSync } from 'node:zlib';
import { MAX_TEXT_BYTES, TOO_LARGE } from './http.mjs';

const MAX_PAGES = 10_000;

function decode(text) {
  return text
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .trim()
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tag(block, name) {
  const match = block.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i'));
  return match ? decode(match[1]) : null;
}

function blocks(xml, name) {
  return [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'gi'))].map((m) => m[1]);
}

// A gzipped sitemap (`.xml.gz`) arrives as a binary Buffer starting with the gzip magic bytes.
// Past MAX_TEXT_BYTES decoded it is null; a corrupt one reads as empty.
function toText(body) {
  if (!Buffer.isBuffer(body)) return String(body ?? '');
  if (body[0] === 0x1f && body[1] === 0x8b) {
    try {
      return gunzipSync(body, { maxOutputLength: MAX_TEXT_BYTES }).toString('utf8');
    } catch (err) {
      if (err.code === 'ERR_BUFFER_TOO_LARGE') return null;
      return '';
    }
  }
  return body.toString('utf8');
}

export function parseSitemap(xml, base) {
  const text = toText(xml);
  if (text === null) return { index: false, children: [], entries: [], tooLarge: true };
  const resolveLoc = (loc) => {
    try {
      return new URL(loc, base).href;
    } catch {
      return null;
    }
  };
  if (/<(?:[\w-]+:)?sitemapindex\b/i.test(text)) {
    const children = blocks(text, 'sitemap').map((b) => tag(b, 'loc')).map((loc) => loc && resolveLoc(loc)).filter(Boolean);
    return { index: true, children, entries: [] };
  }
  const entries = blocks(text, 'url')
    .map((b) => ({ loc: tag(b, 'loc'), lastmod: tag(b, 'lastmod') }))
    .map((e) => ({ loc: e.loc && resolveLoc(e.loc), lastmod: e.lastmod || null }))
    .filter((e) => e.loc);
  return { index: false, children: [], entries };
}

function isPageable(url) {
  const parsed = new URL(url);
  return parsed.pathname.endsWith('/sitemap.xml') && !parsed.searchParams.has('page');
}

function pageUrl(url, page) {
  const parsed = new URL(url);
  parsed.searchParams.set('page', String(page));
  return parsed.href;
}

export async function expandSitemaps(urls, { fetch, onError = () => {} }) {
  const visited = new Set();
  const byLoc = new Map();
  const queue = [...urls];

  const load = async (url) => {
    visited.add(url);
    const res = await fetch(url, { redirect: 'follow' });
    if (res.status !== 200) return null;
    const sitemap = parseSitemap(res.body, res.finalUrl || url);
    if (!sitemap.tooLarge) return sitemap;
    onError({ url, status: TOO_LARGE });
    return null;
  };

  const add = (entries, source) => {
    let added = 0;
    for (const { loc, lastmod } of entries) {
      if (byLoc.has(loc)) continue;
      byLoc.set(loc, { loc, lastmod, source });
      added += 1;
    }
    return added;
  };

  while (queue.length > 0) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    const sitemap = await load(url);
    if (!sitemap) continue;
    if (sitemap.index) {
      queue.push(...sitemap.children);
      continue;
    }
    add(sitemap.entries, url);
    if (!isPageable(url)) continue;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const next = pageUrl(url, page);
      if (visited.has(next)) continue;
      const paged = await load(next);
      if (!paged) break;
      if (paged.index) {
        queue.push(...paged.children);
        break;
      }
      if (paged.entries.length === 0) break;
      // Page 1 often repeats the bare sitemap; any later page that adds nothing means the query is ignored.
      if (add(paged.entries, next) === 0 && page > 1) break;
    }
  }

  return [...byLoc.values()];
}
