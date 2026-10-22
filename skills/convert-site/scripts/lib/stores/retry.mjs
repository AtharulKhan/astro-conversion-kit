// fetch with a doubling backoff on 429 and 5xx: 2 retries, waiting 1 s then 2 s.
// The last response is returned as is, so callers still see the failing status.

export const RETRY_DELAYS_MS = Object.freeze([1000, 2000]);

const retryable = (status) => status === 429 || status >= 500;

export async function fetchWithRetry(url, init, { delays = RETRY_DELAYS_MS } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, init);
    if (!retryable(res.status) || attempt >= delays.length) return res;
    await res.arrayBuffer();
    await new Promise((resolveWait) => setTimeout(resolveWait, delays[attempt]));
  }
}
