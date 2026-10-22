// Vercel Blob over its REST API (no SDK): PUT the object, HEAD its public URL.
// The token is only ever sent in the authorization header, never logged.

export const BLOB_ENDPOINT = 'https://blob.vercel-storage.com';
export const BLOB_ENV = ['BLOB_READ_WRITE_TOKEN'];

export function createBlobStore({ env = process.env, endpoint = BLOB_ENDPOINT } = {}) {
  const token = env.BLOB_READ_WRITE_TOKEN;
  const base = endpoint.replace(/\/+$/, '');
  return {
    async put(key, body, contentType) {
      const res = await fetch(`${base}/${encodeKey(key)}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'x-api-version': '7',
          'x-content-type': contentType,
          'x-add-random-suffix': '0',
          'x-cache-control-max-age': '31536000',
        },
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
      const res = await fetch(url, { method: 'HEAD' });
      if (!res.ok) throw new Error(`HEAD ${url} answered ${res.status}`);
      return { bytes: Number(res.headers.get('content-length')), etag: res.headers.get('etag') };
    },
  };
}

function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}
