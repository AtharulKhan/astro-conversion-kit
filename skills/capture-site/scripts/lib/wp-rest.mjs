// WordPress REST dump: dumpWpRest(origin, outDir, { fetch }) pages through wp/v2/{pages, posts,
// media, categories, tags, users} with per_page=100 (following X-WP-TotalPages) and saves each
// list as <outDir>/wp-rest/<type>.json. `users` is optional: many sites close it, and its absence
// is not an error. Returns { pagePaths[], postPaths[], mediaUrls[], errors[{ url, status }] }:
// page and post paths on this site (www or not), and every media URL, the original plus every
// registered size in media_details.sizes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REST_TYPES = ['pages', 'posts', 'media', 'categories', 'tags', 'users'];
const OPTIONAL = new Set(['users']);
const PER_PAGE = 100;
const MAX_PAGES = 1000;

const bareHost = (url) => url.host.toLowerCase().replace(/^www\./, '');

export function mediaUrlsOf(items) {
  const urls = [];
  for (const item of items ?? []) {
    urls.push(item?.source_url);
    for (const size of Object.values(item?.media_details?.sizes ?? {})) urls.push(size?.source_url);
  }
  return [...new Set(urls.filter((u) => typeof u === 'string' && u))];
}

function sitePaths(items, origin) {
  const site = bareHost(new URL(origin));
  const paths = [];
  for (const item of items) {
    try {
      const url = new URL(item.link);
      if (bareHost(url) === site) paths.push(url.pathname + url.search);
    } catch {
      // no usable link
    }
  }
  return [...new Set(paths)];
}

function parseList(res) {
  if (res.status !== 200) return null;
  try {
    const data = JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export async function dumpWpRest(origin, outDir, { fetch }) {
  const lists = {};
  const errors = [];
  for (const type of REST_TYPES) {
    const items = [];
    let failed = false;
    for (let page = 1, total = 1; page <= total; page += 1) {
      const url = `${origin}/wp-json/wp/v2/${type}?per_page=${PER_PAGE}&page=${page}`;
      const res = await fetch(url);
      const data = parseList(res);
      if (!data) {
        if (!OPTIONAL.has(type)) errors.push({ url, status: res.status });
        failed = true;
        break;
      }
      items.push(...data);
      total = Math.min(Number(res.headers?.['x-wp-totalpages']) || 1, MAX_PAGES);
    }
    if (failed && items.length === 0) continue;
    lists[type] = items;
    mkdirSync(join(outDir, 'wp-rest'), { recursive: true });
    writeFileSync(join(outDir, 'wp-rest', `${type}.json`), `${JSON.stringify(items, null, 2)}\n`);
  }
  return {
    pagePaths: sitePaths(lists.pages ?? [], origin),
    postPaths: sitePaths(lists.posts ?? [], origin),
    mediaUrls: mediaUrlsOf(lists.media),
    errors,
  };
}
