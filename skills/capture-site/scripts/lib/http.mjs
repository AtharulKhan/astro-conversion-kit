// Paced, read-only HTTP for live sites.
// fetchPaced(url, { delayMs, ua, redirect, method, raw }) -> { status, headers, body, finalUrl, error? }
// - body is a string for text types and a Buffer otherwise; `raw: true` always gives the Buffer;
// - method defaults to GET (HEAD for a size check without the body);
// - timeoutMs (default 30 s) bounds the whole request, body included;
// - waits delayMs (default 2500) since the previous request to the same host;
// - doubles that host's wait after a 429 or 503, back to normal after a success;
// - counts consecutive 403/429/503/network errors in `blocked` (callers stop at 3);
// - never throws: a network error comes back as status 0 with `error` set.

export const DEFAULT_DELAY_MS = 2500;
export const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const BLOCK_LIMIT = 3;

export const TIMEOUT_MS = 30_000;
const MAX_BACKOFF = 32;
const BLOCK_STATUSES = new Set([403, 429, 503]);
const BACKOFF_STATUSES = new Set([429, 503]);
const TEXT_TYPE = /^(text\/|application\/(.*\+)?(xml|json|javascript)|image\/svg\+xml)/i;

const hosts = new Map(); // host -> { lastAt, backoff }

export let blocked = 0;

export function resetBlocked() {
  blocked = 0;
}

export const http = {
  get blocked() {
    return blocked;
  },
  resetBlocked,
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function pace(host, delayMs) {
  const state = hosts.get(host) ?? { lastAt: 0, backoff: 1 };
  hosts.set(host, state);
  const wait = state.lastAt + delayMs * state.backoff - Date.now();
  if (wait > 0) await sleep(wait);
  state.lastAt = Date.now();
  return state;
}

export async function fetchPaced(url, { delayMs = DEFAULT_DELAY_MS, ua = DEFAULT_UA, redirect = 'manual', method = 'GET', raw = false, timeoutMs = TIMEOUT_MS } = {}) {
  const target = new URL(url);
  const state = await pace(target.host, delayMs);
  let res;
  let buffer;
  try {
    res = await fetch(target, {
      method,
      redirect,
      headers: { 'User-Agent': ua, Accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Inside the try: a reset or timeout partway through the body is a network error too.
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    blocked += 1;
    state.lastAt = Date.now();
    return { status: 0, headers: {}, body: '', finalUrl: target.href, error: err.cause?.code ?? err.message };
  }

  const headers = Object.fromEntries(res.headers);
  const type = headers['content-type'] ?? 'text/plain';
  const body = !raw && TEXT_TYPE.test(type) ? buffer.toString('utf8') : buffer;
  state.lastAt = Date.now();

  if (BLOCK_STATUSES.has(res.status)) blocked += 1;
  else blocked = 0;
  if (BACKOFF_STATUSES.has(res.status)) state.backoff = Math.min(state.backoff * 2, MAX_BACKOFF);
  else if (res.status < 400) state.backoff = 1;

  return { status: res.status, headers, body, finalUrl: res.url || target.href };
}
