// Vercel Blob over its REST API (no SDK): PUT the object, HEAD its public URL.
// The token is only ever sent in the authorization header, never logged.
import { fetchWithRetry } from './retry.mjs';

export const BLOB_ENDPOINT = 'https://blob.vercel-storage.com';
export const BLOB_ENV = ['BLOB_READ_WRITE_TOKEN'];

// The full PUT header set; authorization and x-content-type are filled per request.
// Verified against a real Blob store: pending.
// x-allow-overwrite lets a re-PUT succeed after a failed HEAD or a lost manifest.
export const BLOB_PUT_HEADERS = Object.freeze({
  authorization: 'Bearer <BLOB_READ_WRITE_TOKEN>',
  'x-api-version': '7',
  'x-content-type': '<content type>',
  'x-add-random-suffix': '0',
  'x-allow-overwrite': '1',
  'x-cache-control-max-age': '31536000',
});

function blobPutHeaders(token, contentType) {
  return { ...BLOB_PUT_HEADERS, authorization: `Bearer ${token}`, 'x-content-type': contentType };
}

export function createBlobStore({ env = process.env, endpoint = BLOB_ENDPOINT } = {}) {
  const token = env.BLOB_READ_WRITE_TOKEN;
  const base = endpoint.replace(/\/+$/, '');
  return {
    async put(key, body, contentType) {
      const res = await fetchWithRetry(`${base}/${encodeKey(key)}`, {
        method: 'PUT',
        headers: blobPutHeaders(token, contentType),
        body,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Blob PUT ${key} answered ${res.status}: ${text.slice(0, 200)}`);
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Blob PUT ${key} returned a response that is not JSON`);
      }
      if (!json.url) throw new Error(`Blob PUT ${key} response has no url`);
      return { url: json.url, etag: res.headers.get('etag') ?? json.etag ?? null };
    },
    async head(url) {
      const res = await fetchWithRetry(url, { method: 'HEAD' });
      if (!res.ok) throw new Error(`HEAD ${url} answered ${res.status}`);
      return { bytes: Number(res.headers.get('content-length')), etag: res.headers.get('etag') };
    },
  };
}

function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}
