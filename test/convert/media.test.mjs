import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFixture } from '../fixture/serve.mjs';
import { parseSize, planMedia, rewriteConfig } from '../../skills/convert-site/scripts/media-plan.mjs';
import { signV4 } from '../../skills/convert-site/scripts/lib/stores/r2.mjs';

const SCRIPTS = resolve(import.meta.dirname, '../../skills/convert-site/scripts');
const PLAN = join(SCRIPTS, 'media-plan.mjs');
const UPLOAD = join(SCRIPTS, 'media-upload.mjs');

// Async on purpose: the stub servers live in this process and must keep answering.
function run(script, args, env = {}) {
  return new Promise((done) => {
    const childEnv = { ...process.env, ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
    execFile(process.execPath, [script, ...args], { env: childEnv }, (err, stdout, stderr) => {
      done({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

const NO_CREDS = {
  BLOB_READ_WRITE_TOKEN: undefined,
  R2_ACCOUNT_ID: undefined,
  R2_ACCESS_KEY_ID: undefined,
  R2_SECRET_ACCESS_KEY: undefined,
  R2_BUCKET: undefined,
};

const UPLOADS = '/wp-content/uploads/2026/01/';
const FIXTURE_MEDIA = [
  ...['hero', 'roof-detail', 'team'].flatMap((n) => [`${n}.jpg`, `${n}-300x200.jpg`, `${n}-1024x683.jpg`]),
  ...['siding-sample', 'storm-clouds'].flatMap((n) => [`${n}.webp`, `${n}-300x200.webp`, `${n}-1024x683.webp`]),
  'brochure.pdf',
  'logo.svg',
].map((f) => UPLOADS + f);

let fixture;
let work;
let fixtureMediaJson;

before(async () => {
  fixture = await startFixture();
  work = mkdtempSync(join(tmpdir(), 'media-test-'));
  const entries = [];
  for (const path of FIXTURE_MEDIA) {
    const res = await fetch(fixture.origin + path, { method: 'HEAD' });
    entries.push({
      url: fixture.origin + path,
      path,
      source: ['html'],
      referencedBy: ['/'],
      status: res.status,
      contentType: res.headers.get('content-type'),
      bytes: Number(res.headers.get('content-length')),
    });
  }
  fixtureMediaJson = join(work, 'media.json');
  writeFileSync(fixtureMediaJson, JSON.stringify(entries));
});

after(async () => {
  await fixture.close();
  rmSync(work, { recursive: true, force: true });
});

test('parseSize accepts MB, KB and plain byte forms', () => {
  assert.equal(parseSize('300MB'), 300 * 1024 * 1024);
  assert.equal(parseSize('25MB'), 25 * 1024 * 1024);
  assert.equal(parseSize('1KB'), 1024);
  assert.equal(parseSize('1024'), 1024);
  assert.throws(() => parseSize('lots'));
});

test('fixture media (tiny) is planned into the repo', async () => {
  const out = join(work, 'plan-repo.json');
  const res = await run(PLAN, ['--media', fixtureMediaJson, '--host', 'vercel', '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  const plan = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(plan.mode, 'repo');
  assert.equal(plan.store, undefined);
  assert.equal(plan.totals.count, FIXTURE_MEDIA.length);
  const entries = JSON.parse(readFileSync(fixtureMediaJson, 'utf8'));
  assert.ok(entries.every((e) => e.status === 200 && e.bytes > 0), 'every fixture media URL answered HEAD');
  assert.equal(plan.totals.bytes, entries.reduce((sum, e) => sum + e.bytes, 0));
  assert.equal(plan.totals.largest, 13713);
  assert.deepEqual(plan.reasons, []);
  assert.equal(plan.prefix, '/wp-content/uploads/');
  assert.deepEqual(plan.thresholds, { maxTotal: 300 * 1024 * 1024, maxFile: 25 * 1024 * 1024, maxCount: 10000 });
});

test('over the total limit, the store follows the host and the reason names the limit', async () => {
  for (const [host, store] of [['vercel', 'blob'], ['cloudflare', 'r2']]) {
    const out = join(work, `plan-${host}.json`);
    const res = await run(PLAN, ['--media', fixtureMediaJson, '--host', host, '--max-total', '1KB', '--out', out]);
    assert.equal(res.code, 0, res.stderr);
    const plan = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(plan.mode, 'store');
    assert.equal(plan.store, store);
    assert.equal(plan.reasons.length, 1);
    assert.match(plan.reasons[0], /total/i);
    assert.match(plan.reasons[0], /--max-total/);
  }
});

test('file-size and count limits each give their own reason; non-200 entries do not count', () => {
  const entries = [
    { path: '/wp-content/uploads/a.jpg', status: 200, bytes: 2048 },
    { path: '/wp-content/uploads/b.jpg', status: 200, bytes: 10 },
    { path: '/wp-content/uploads/gone.jpg', status: 404, bytes: 999999 },
  ];
  const plan = planMedia(entries, { host: 'vercel', maxTotal: 1e9, maxFile: 1024, maxCount: 2 });
  assert.equal(plan.mode, 'store');
  assert.equal(plan.totals.count, 2);
  assert.equal(plan.totals.bytes, 2058);
  assert.equal(plan.totals.largest, 2048);
  assert.equal(plan.reasons.length, 2);
  assert.match(plan.reasons.join('\n'), /--max-file/);
  assert.match(plan.reasons.join('\n'), /--max-count/);
  assert.match(plan.reasons.join('\n'), /a\.jpg/);
});

test('--mode live-temporary is written with the no-credentials reason', async () => {
  const out = join(work, 'plan-live.json');
  const res = await run(PLAN, [
    '--media', fixtureMediaJson, '--host', 'cloudflare', '--max-total', '1KB', '--mode', 'live-temporary', '--out', out,
  ]);
  assert.equal(res.code, 0, res.stderr);
  const plan = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(plan.mode, 'live-temporary');
  assert.equal(plan.store, 'r2');
  assert.ok(plan.reasons.includes('no store credentials'));
});

test('media-plan with a bad size or host exits 2; --help exits 0', async () => {
  const bad = await run(PLAN, ['--media', fixtureMediaJson, '--host', 'vercel', '--max-total', 'huge', '--out', join(work, 'x.json')]);
  assert.equal(bad.code, 2);
  const host = await run(PLAN, ['--media', fixtureMediaJson, '--host', 'netlify', '--out', join(work, 'x.json')]);
  assert.equal(host.code, 2);
  const help = await run(PLAN, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage/);
});

test('rewriteConfig: Vercel rewrite, Cloudflare block, and live-temporary at the live origin', () => {
  const live = rewriteConfig('live-temporary', 'https://live.example.com', '/wp-content/uploads/');
  assert.equal(live.source, '/wp-content/uploads/:path*');
  assert.ok(live.destination.startsWith('https://live.example.com'));
  assert.equal(live.destination, 'https://live.example.com/wp-content/uploads/:path*');

  const blob = rewriteConfig('store', 'https://abc.public.blob.vercel-storage.com/', '/wp-content/uploads/', { store: 'blob' });
  assert.deepEqual(blob, {
    source: '/wp-content/uploads/:path*',
    destination: 'https://abc.public.blob.vercel-storage.com/wp-content/uploads/:path*',
  });

  const r2 = rewriteConfig('store', 'https://media.example.com', '/wp-content/uploads/', { store: 'r2' });
  assert.equal(typeof r2, 'string');
  assert.match(r2, /custom domain/i);
  assert.match(r2, /media\.example\.com/);
  assert.match(r2, /\/wp-content\/uploads\//);

  const liveCf = rewriteConfig('live-temporary', 'https://live.example.com', '/wp-content/uploads/', { store: 'r2' });
  assert.equal(typeof liveCf, 'string');
  assert.match(liveCf, /live\.example\.com/);

  assert.equal(rewriteConfig('repo', '', '/wp-content/uploads/'), null);
});

test('media-upload --store blob with no token exits 2 naming BLOB_READ_WRITE_TOKEN', async () => {
  const res = await run(UPLOAD, ['--store', 'blob', '--dir', work, '--manifest', join(work, 'm.json'), '--prefix', '/wp-content/uploads/'], NO_CREDS);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /BLOB_READ_WRITE_TOKEN/);
  assert.equal(res.stderr.trim().split('\n').length, 1);
});

test('media-upload --store r2 with missing credentials exits 2 naming the missing variables', async () => {
  const res = await run(
    UPLOAD,
    ['--store', 'r2', '--dir', work, '--manifest', join(work, 'm.json'), '--prefix', '/wp-content/uploads/'],
    { ...NO_CREDS, R2_ACCOUNT_ID: 'acct', R2_BUCKET: 'bucket' },
  );
  assert.equal(res.code, 2);
  assert.match(res.stderr, /R2_ACCESS_KEY_ID/);
  assert.match(res.stderr, /R2_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(res.stderr, /R2_BUCKET/);
  assert.equal(res.stderr.trim().split('\n').length, 1);
});

function makeCache(name) {
  const dir = join(work, name);
  const files = { 'a.jpg': 'aaaa', 'b.webp': 'bbbbbbbb', 'sub/c.pdf': 'cccccccccccc' };
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, 'wp-content/uploads/2026/01', rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  // Outside the prefix: never uploaded.
  mkdirSync(join(dir, 'wp-content/themes'), { recursive: true });
  writeFileSync(join(dir, 'wp-content/themes/style.css'), 'body{}');
  return dir;
}

// A stand-in for the object store: records PUTs, serves HEADs of what it stored.
async function startStoreStub({ lie = false } = {}) {
  const puts = [];
  const stored = new Map();
  let origin;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (req.method === 'PUT') {
        const body = Buffer.concat(chunks);
        puts.push({ path, headers: req.headers, bytes: body.length });
        stored.set(path, body);
        res.writeHead(200, { 'content-type': 'application/json', etag: `"etag-${body.length}"` });
        res.end(JSON.stringify({ url: `${origin}/public${path}`, pathname: path.slice(1) }));
        return;
      }
      if (req.method === 'HEAD') {
        const body = stored.get(path.replace(/^\/public/, ''));
        if (!body) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-length': lie ? body.length + 1 : body.length, etag: `"etag-${body.length}"` });
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    puts,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

test('blob upload against a stub: 3 files, verified sizes, manifest written, second run uploads 0', async () => {
  const stub = await startStoreStub();
  try {
    const dir = makeCache('cache-blob');
    const manifest = join(work, 'manifest-blob.json');
    const token = 'vercel_blob_rw_SECRETVALUE123';
    const args = ['--store', 'blob', '--dir', dir, '--manifest', manifest, '--prefix', '/wp-content/uploads/', '--endpoint', stub.origin];
    const first = await run(UPLOAD, args, { ...NO_CREDS, BLOB_READ_WRITE_TOKEN: token });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(stub.puts.length, 3);
    assert.ok(!first.stdout.includes(token) && !first.stderr.includes(token), 'token never printed');

    const put = stub.puts.find((p) => p.path === '/wp-content/uploads/2026/01/a.jpg');
    assert.ok(put, 'object key is the site path');
    assert.equal(put.headers.authorization, `Bearer ${token}`);
    assert.equal(put.headers['x-api-version'], '7');
    assert.equal(put.headers['x-content-type'], 'image/jpeg');
    assert.equal(put.headers['x-add-random-suffix'], '0');
    assert.equal(put.headers['x-cache-control-max-age'], '31536000');

    const entries = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(entries.length, 3);
    const a = entries.find((e) => e.path === '/wp-content/uploads/2026/01/a.jpg');
    assert.equal(a.bytes, 4);
    assert.equal(a.url, `${stub.origin}/public/wp-content/uploads/2026/01/a.jpg`);
    assert.equal(a.etag, '"etag-4"');
    assert.ok(entries.some((e) => e.path === '/wp-content/uploads/2026/01/sub/c.pdf' && e.bytes === 12));
    assert.match(first.stdout, /uploaded 3/);

    const second = await run(UPLOAD, args, { ...NO_CREDS, BLOB_READ_WRITE_TOKEN: token });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(stub.puts.length, 3, 'second run uploads nothing');
    assert.match(second.stdout, /uploaded 0/);
    assert.match(second.stdout, /skipped 3/);
  } finally {
    await stub.close();
  }
});

test('a HEAD size mismatch fails with exit 1 and keeps the file out of the manifest', async () => {
  const stub = await startStoreStub({ lie: true });
  try {
    const dir = makeCache('cache-lie');
    const manifest = join(work, 'manifest-lie.json');
    const res = await run(
      UPLOAD,
      ['--store', 'blob', '--dir', dir, '--manifest', manifest, '--prefix', '/wp-content/uploads/', '--endpoint', stub.origin],
      { ...NO_CREDS, BLOB_READ_WRITE_TOKEN: 'tok' },
    );
    assert.equal(res.code, 1);
    assert.match(res.stderr, /size mismatch/i);
    const entries = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : [];
    assert.equal(entries.length, 0);
  } finally {
    await stub.close();
  }
});

test('signV4 matches the published S3 GET-object example', () => {
  const headers = signV4({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
    date: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
  });
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

test('r2 upload against a stub: signed PUTs to /<bucket>/<key>, verified by HEAD, resumable', async () => {
  const stub = await startStoreStub();
  try {
    const dir = makeCache('cache-r2');
    const manifest = join(work, 'manifest-r2.json');
    const secret = 'r2-secret-DO-NOT-PRINT';
    const env = { ...NO_CREDS, R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AKIDTEST', R2_SECRET_ACCESS_KEY: secret, R2_BUCKET: 'media' };
    const args = ['--store', 'r2', '--dir', dir, '--manifest', manifest, '--prefix', '/wp-content/uploads/', '--endpoint', stub.origin];
    const first = await run(UPLOAD, args, env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(stub.puts.length, 3);
    assert.ok(!first.stdout.includes(secret) && !first.stderr.includes(secret));
    const put = stub.puts.find((p) => p.path === '/media/wp-content/uploads/2026/01/b.webp');
    assert.ok(put, 'path-style /<bucket>/<key>');
    assert.match(
      put.headers.authorization,
      /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/auto\/s3\/aws4_request,SignedHeaders=[^,]*x-amz-date[^,]*,Signature=[0-9a-f]{64}$/,
    );
    assert.equal(put.headers['content-type'], 'image/webp');
    assert.match(put.headers['x-amz-content-sha256'], /^[0-9a-f]{64}$/);
    const entries = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(entries.length, 3);
    const second = await run(UPLOAD, args, env);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(stub.puts.length, 3);
  } finally {
    await stub.close();
  }
});
