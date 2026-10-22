// Cloudflare R2 through its S3-compatible API, signed with AWS Signature V4
// using node:crypto (no SDK). Path-style URLs: <endpoint>/<bucket>/<key>.
// Secrets are only used to derive the signing key, never logged.
import { createHash, createHmac } from 'node:crypto';

export const R2_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding per path segment, as S3 expects (no double encoding).
export function encodeKey(key) {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

// Returns the full header set to send (host included for signing; fetch sets it itself).
export function signV4({ method, url, headers = {}, payloadHash, accessKeyId, secretAccessKey, region = 'auto', service = 's3', date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const all = {
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host: u.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(all).sort();
  const signedHeaders = names.join(';');
  const query = [...u.searchParams]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    method,
    u.pathname || '/',
    query,
    names.map((n) => `${n}:${all[n]}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

function withoutHost(headers) {
  const { host, ...rest } = headers;
  return rest;
}

export function createR2Store({ env = process.env, endpoint } = {}) {
  const base = (endpoint ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  const creds = { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY };
  const objectUrl = (key) => `${base}/${encodeKey(env.R2_BUCKET)}/${encodeKey(key)}`;
  return {
    async put(key, body, contentType) {
      const url = objectUrl(key);
      const headers = signV4({
        method: 'PUT',
        url,
        headers: { 'content-type': contentType, 'cache-control': 'public, max-age=31536000' },
        payloadHash: sha256(body),
        ...creds,
      });
      const res = await fetch(url, { method: 'PUT', headers: withoutHost(headers), body });
      const text = await res.text();
      if (!res.ok) throw new Error(`R2 PUT ${key} answered ${res.status}: ${text.slice(0, 200)}`);
      return { url, etag: res.headers.get('etag') };
    },
    async head(url) {
      const headers = signV4({ method: 'HEAD', url, payloadHash: EMPTY_SHA256, ...creds });
      const res = await fetch(url, { method: 'HEAD', headers: withoutHost(headers) });
      if (!res.ok) throw new Error(`HEAD ${url} answered ${res.status}`);
      return { bytes: Number(res.headers.get('content-length')), etag: res.headers.get('etag') };
    },
  };
}
