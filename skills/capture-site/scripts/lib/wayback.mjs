// Legacy URLs from the Wayback Machine's CDX API.
// waybackPaths(host, { fetch, known, out, endpoint }) asks for every URL archived with a 200 on the
// host (one request), keeps page-like paths on that host (www or not; query strings dropped;
// never wp-admin, wp-login, xmlrpc.php or /wp-json/), drops the `known` paths, and returns the
// rest sorted. With `out`, writes them one per line to <out>/wayback-unverified.txt.
// Throws when the API cannot be reached or does not answer with JSON.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CDX_ENDPOINT = 'http://web.archive.org/cdx/search/cdx';
export const WAYBACK_FILE = 'wayback-unverified.txt';
// The crawl's notion of a page (kept in step with capture.mjs).
const PAGE_EXTENSIONS = new Set(['', 'html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'shtml', 'cfm']);
const NEVER = /(?:^|\/)(?:wp-admin|wp-login|xmlrpc\.php)(?:[/.?]|$)/i;
const NOT_PAGES = /^\/wp-json(?:\/|$)/i;

const bareHost = (host) => host.toLowerCase().replace(/^www\./, '');

export function cdxUrl(host, endpoint = CDX_ENDPOINT) {
  return `${endpoint}?url=${host}/*&output=json&fl=original&collapse=urlkey&filter=statuscode:200`;
}

function isPage(pathname) {
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  const extension = dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
  return PAGE_EXTENSIONS.has(extension) && !NEVER.test(pathname) && !NOT_PAGES.test(pathname);
}

export async function waybackPaths(host, { fetch, known = [], out = null, endpoint = CDX_ENDPOINT } = {}) {
  const res = await fetch(cdxUrl(host, endpoint));
  if (res.status !== 200) {
    throw new Error(`the Wayback CDX API answered ${res.status || 'nothing'}${res.error ? ` (${res.error})` : ''}`);
  }
  const text = (Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '')).trim();
  let rows = [];
  if (text) {
    try {
      rows = JSON.parse(text);
    } catch {
      throw new Error('the Wayback CDX API did not answer with JSON');
    }
    if (!Array.isArray(rows)) throw new Error('the Wayback CDX API did not answer with a JSON list');
  }
  const site = bareHost(host);
  const skip = new Set(known);
  const paths = new Set();
  for (const row of rows.slice(1)) {
    let url;
    try {
      url = new URL(Array.isArray(row) ? row[0] : row);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || bareHost(url.host) !== site) continue;
    if (!isPage(url.pathname) || skip.has(url.pathname)) continue;
    paths.add(url.pathname);
  }
  const sorted = [...paths].sort();
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, WAYBACK_FILE), sorted.map((p) => `${p}\n`).join(''));
  }
  return sorted;
}
