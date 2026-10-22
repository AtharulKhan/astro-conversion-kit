#!/usr/bin/env node
// Upload the media cache to an object store, verify every object by HEAD, and
// keep a resumable manifest of what is safely stored.
// Exit codes: 0 all uploaded and verified, 1 an upload or verification failed,
// 2 usage or environment error (including missing credentials).
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../../../scripts/lib/node-version.mjs';
import { createBlobStore, BLOB_ENV, BLOB_ENDPOINT } from './lib/stores/blob.mjs';
import { createR2Store, R2_ENV } from './lib/stores/r2.mjs';

const HELP = `Usage: node media-upload.mjs --store blob|r2 --dir <cache> --manifest media-manifest.json
                            --prefix /wp-content/uploads/ [--endpoint <url>]

Uploads every file under <cache><prefix> (the cache mirrors site paths, so
<cache>/wp-content/uploads/2026/01/a.jpg is the site path
/wp-content/uploads/2026/01/a.jpg and the object key wp-content/uploads/2026/01/a.jpg).
Each upload is checked with a HEAD whose content-length must match the file.
The manifest ([{ path, bytes, url, etag }]) is rewritten after every verified
upload; files already in it with the same size are skipped, so a rerun resumes.

Credentials come from the environment:
  blob: BLOB_READ_WRITE_TOKEN
  r2:   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
--endpoint overrides the API base (default ${BLOB_ENDPOINT} for blob,
https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com for r2).

Exit codes: 0 done, 1 an upload or verification failed, 2 usage or missing credentials.`;

const STORES = {
  blob: { env: BLOB_ENV, create: createBlobStore },
  r2: { env: R2_ENV, create: createR2Store },
};

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export function contentTypeFor(file) {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function usage(message) {
  console.error(`media-upload: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usage(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else usage(`unexpected argument "${arg}"`);
  }
  return opts;
}

async function main() {
  assertNodeVersion();
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }
  for (const name of ['store', 'dir', 'manifest', 'prefix']) if (!opts[name]) usage(`--${name} is required (see --help)`);
  const kind = STORES[opts.store];
  if (!kind) usage(`--store must be blob or r2, got "${opts.store}"`);

  const missing = kind.env.filter((name) => !process.env[name]);
  if (missing.length) {
    usage(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set; export ${missing.length === 1 ? 'it' : 'them'} and run again.`);
  }

  const prefix = `/${opts.prefix.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  const root = join(opts.dir, prefix);
  if (!existsSync(root) || !statSync(root).isDirectory()) usage(`no media folder at ${root}`);

  let manifest = [];
  if (existsSync(opts.manifest)) {
    try {
      manifest = JSON.parse(readFileSync(opts.manifest, 'utf8'));
      if (!Array.isArray(manifest)) throw new Error('not an array');
    } catch (err) {
      usage(`cannot read manifest ${opts.manifest}: ${err.message}`);
    }
  }
  const done = new Map(manifest.map((e) => [e.path, e]));
  const save = () => {
    mkdirSync(dirname(opts.manifest), { recursive: true });
    writeFileSync(opts.manifest, `${JSON.stringify([...done.values()], null, 2)}\n`);
  };

  const store = kind.create({ env: process.env, ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) });
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  for (const file of walk(root)) {
    const sitePath = `/${relative(opts.dir, file).split(sep).join('/')}`;
    const body = readFileSync(file);
    if (done.get(sitePath)?.bytes === body.length) {
      skipped += 1;
      continue;
    }
    try {
      const key = sitePath.slice(1);
      const put = await store.put(key, body, contentTypeFor(file));
      const head = await store.head(put.url);
      if (head.bytes !== body.length) {
        throw new Error(`size mismatch for ${sitePath}: local ${body.length} bytes, store reports ${head.bytes}`);
      }
      done.set(sitePath, { path: sitePath, bytes: body.length, url: put.url, etag: head.etag ?? put.etag ?? null });
      save();
      uploaded += 1;
      console.log(`uploaded ${sitePath} (${body.length} bytes)`);
    } catch (err) {
      failed += 1;
      console.error(`failed ${sitePath}: ${err.message}`);
    }
  }
  if (!existsSync(opts.manifest)) save();
  console.log(`media-upload (${opts.store}): uploaded ${uploaded}, skipped ${skipped}, failed ${failed}; manifest ${opts.manifest}`);
  if (failed) process.exit(1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`media-upload: ${err.message}`);
    process.exit(1);
  });
}
