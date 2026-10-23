import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFixture } from '../fixture/serve.mjs';
import { compileSource, fillDestination } from '../../skills/convert-site/scripts/lib/review-routes.mjs';
import * as resolver from '../../skills/parity-gates/scripts/lib/vercel-resolver.mjs';

const SERVE = resolve(import.meta.dirname, '../../skills/convert-site/scripts/review-serve.mjs');
const FIXTURE_IMAGE = resolve(import.meta.dirname, '../fixture/site/wp-content/uploads/2026/01/hero.jpg');

let fixture;
let upstream;
let upstreamSeen;
let site;

function freePort() {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

// Runs review-serve in the foreground until it prints its origin; returns the child and the origin.
function serve(args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SERVE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const m = /serving \S+ at (http:\/\/localhost:\d+)/.exec(out);
      if (m) done({ child, origin: m[1] });
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => fail(new Error(`review-serve exited ${code} before serving\n${out}\n${err}`)));
  });
}

function stop(child) {
  return new Promise((done) => {
    if (child.exitCode !== null) return done();
    child.removeAllListeners('exit');
    child.once('exit', () => done());
    child.kill('SIGTERM');
  });
}

before(async () => {
  fixture = await startFixture();
  upstreamSeen = [];
  upstream = createServer((req, res) => {
    upstreamSeen.push({ method: req.method, url: req.url, cookie: req.headers.cookie });
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=60', 'Set-Cookie': 'track=1' });
    res.end(req.method === 'HEAD' ? undefined : 'export default 1;\n');
  });
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

  site = mkdtempSync(join(tmpdir(), 'review-serve-'));
  const dist = join(site, 'dist');
  mkdirSync(join(dist, 'about'), { recursive: true });
  mkdirSync(join(dist, '_astro'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Home</title><img src="/wp-content/uploads/2026/01/hero.jpg">');
  writeFileSync(join(dist, 'about', 'index.html'), '<!doctype html><title>About</title>');
  writeFileSync(join(dist, '404.html'), '<!doctype html><title>Not found</title>');
  writeFileSync(join(dist, '_astro', 'site.css'), 'body{margin:0}');
  writeFileSync(join(dist, 'local-target.html'), '<!doctype html><title>Local target</title>');
  writeFileSync(
    join(site, 'vercel.json'),
    JSON.stringify({
      redirects: [
        { source: '/old-about/', destination: '/about/', statusCode: 301 },
        { source: '/moved/:slug/', destination: '/about/', permanent: false },
        { source: '/away/', destination: 'https://www.example.com/elsewhere/', permanent: true },
      ],
      rewrites: [
        { source: '/wp-content/uploads/:path*', destination: `${fixture.origin}/wp-content/uploads/:path*` },
        { source: '/_static/importmap.js', destination: `${upstreamOrigin}/_static/importmap.js` },
        { source: '/inside/', destination: '/local-target.html' },
      ],
    }),
  );
});

after(async () => {
  await fixture?.close();
  await new Promise((done) => (upstream ? upstream.close(done) : done()));
  if (site) rmSync(site, { recursive: true, force: true });
});

test('--help prints usage and exits 0', () => {
  const res = spawnSync(process.execPath, [SERVE, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /--port/);
  assert.match(res.stdout, /--background/);
  assert.match(res.stdout, /--stop/);
});

test('the route matcher compiles the same sources the parity gates resolve', () => {
  for (const source of ['/wp-content/uploads/:path*', '/blog/:slug/', '/a/:b?', '/(.*)', '/x/:id(\\d+)/', '/plain/']) {
    assert.deepEqual(compileSource(source), resolver.compileSource(source), source);
  }
  assert.equal(fillDestination('https://live.example.com/wp-content/uploads/:path*', { path: '2026/01/a.jpg' }),
    'https://live.example.com/wp-content/uploads/2026/01/a.jpg');
});

test('serves dist/, applies vercel.json redirects and rewrites, proxies other origins', async () => {
  const port = await freePort();
  const { child, origin } = await serve(['--dir', site, '--port', String(port)]);
  try {
    assert.equal(origin, `http://localhost:${port}`);

    const home = await fetch(`${origin}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /^text\/html/);
    assert.match(await home.text(), /<title>Home<\/title>/);

    const about = await fetch(`${origin}/about/`);
    assert.equal(about.status, 200);
    assert.match(await about.text(), /<title>About<\/title>/);

    const css = await fetch(`${origin}/_astro/site.css`);
    assert.match(css.headers.get('content-type'), /^text\/css/);
    assert.equal(await css.text(), 'body{margin:0}');

    const missing = await fetch(`${origin}/no-such-page/`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /<title>Not found<\/title>/);

    const traversal = await fetch(`${origin}/..%2f..%2fetc%2fpasswd`);
    assert.equal(traversal.status, 404);

    // Proxied to the fixture: the bytes are the live file's.
    const image = await fetch(`${origin}/wp-content/uploads/2026/01/hero.jpg`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.ok(Buffer.from(await image.arrayBuffer()).equals(readFileSync(FIXTURE_IMAGE)));
    const head = await fetch(`${origin}/wp-content/uploads/2026/01/hero.jpg`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    const gone = await fetch(`${origin}/wp-content/uploads/2026/01/not-there.jpg`);
    assert.equal(gone.status, 404);
    const post = await fetch(`${origin}/wp-content/uploads/2026/01/hero.jpg`, { method: 'POST', body: 'x' });
    assert.equal(post.status, 405);

    // Upstream cache-control passes through; cookies go neither way; the query is kept.
    const script = await fetch(`${origin}/_static/importmap.js?ver=3`, { headers: { cookie: 'session=secret' } });
    assert.equal(script.status, 200);
    assert.equal(script.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(script.headers.get('set-cookie'), null);
    assert.equal(await script.text(), 'export default 1;\n');
    const seen = upstreamSeen.at(-1);
    assert.equal(seen.url, '/_static/importmap.js?ver=3');
    assert.equal(seen.cookie, undefined);

    // A local rewrite destination is served from dist/.
    const inside = await fetch(`${origin}/inside/`);
    assert.equal(inside.status, 200);
    assert.match(await inside.text(), /<title>Local target<\/title>/);

    // Redirects keep their status codes.
    for (const [path, status, location] of [
      ['/old-about/', 301, '/about/'],
      ['/moved/x/', 307, '/about/'],
      ['/away/', 308, 'https://www.example.com/elsewhere/'],
    ]) {
      const res = await fetch(`${origin}${path}`, { redirect: 'manual' });
      assert.equal(res.status, status, path);
      assert.equal(res.headers.get('location'), location, path);
    }
  } finally {
    await stop(child);
  }
});

test('a port held by another process exits 2 naming the pid instead of binding another interface', async () => {
  const holder = createNetServer();
  await new Promise((done) => holder.listen(0, '127.0.0.1', done));
  const { port } = holder.address();
  try {
    const res = await new Promise((done) => {
      const child = spawn(process.execPath, [SERVE, '--dir', site, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('exit', (code) => done({ code, stdout, stderr }));
    });
    assert.equal(res.code, 2, res.stdout + res.stderr);
    assert.match(res.stderr, new RegExp(`port ${port} is in use by another process \\(pid (\\d+|unknown)[^)]*\\); pass --port`));
    const pid = /\(pid (\d+)/.exec(res.stderr)?.[1];
    if (pid) assert.equal(Number(pid), process.pid);
  } finally {
    await new Promise((done) => holder.close(done));
  }
});

test('--background detaches with a pid file and --stop ends it', async () => {
  const port = await freePort();
  const pidFile = join(site, '.conversion', 'review-serve.pid');
  const started = spawnSync(process.execPath, [SERVE, '--dir', site, '--port', String(port), '--background'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.match(started.stdout, new RegExp(`http://localhost:${port}`));
  assert.ok(existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(pid > 0);
  const home = await fetch(`http://localhost:${port}/`);
  assert.equal(home.status, 200);
  await home.text();

  const stopped = spawnSync(process.execPath, [SERVE, '--dir', site, '--stop'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.ok(!existsSync(pidFile));
  let alive = true;
  for (let i = 0; i < 50 && alive; i += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'the background server exited');
  const again = spawnSync(process.execPath, [SERVE, '--dir', site, '--stop'], { encoding: 'utf8' });
  assert.equal(again.status, 0);
  assert.match(again.stdout, /not running/);
});
