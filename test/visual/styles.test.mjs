import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';
import { compareSamples, firstFamily, parseRoutes } from '../../skills/visual-review/scripts/styles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SCRIPT = join(ROOT, 'skills', 'visual-review', 'scripts', 'styles.mjs');
const SITE = join(ROOT, 'test', 'fixture', 'site');
const STYLESHEET = '/wp-content/themes/fixture/style.css';
const TMP = join(ROOT, 'test', 'tmp', 'styles');
const TYPES = { '.html': 'text/html; charset=UTF-8', '.css': 'text/css; charset=UTF-8' };
// Pages the copy does not have, so they 404 there while the fixture serves them.
const REMOVED_FROM_COPY = new Set(['/contact/']);

// A second copy of the fixture pages whose stylesheet also sets h1 to 40px.
function startCopy() {
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    const { pathname } = new URL(req.url, origin);
    let file = resolve(SITE, `.${decodeURIComponent(pathname)}`);
    if (pathname.endsWith('/')) file = join(file, 'index.html');
    if (REMOVED_FROM_COPY.has(pathname)) file = join(SITE, 'missing');
    let isFile = false;
    try {
      isFile = file.startsWith(SITE + sep) && statSync(file).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    let body = readFileSync(file);
    if (TYPES[extname(file)]) {
      let text = body.toString('utf8').replaceAll('{{ORIGIN}}', origin);
      if (pathname === STYLESHEET) text += '\nh1 { font-size: 40px; }\n';
      body = Buffer.from(text);
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      done({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((closed) => { server.closeAllConnections(); server.close(() => closed()); }),
      });
    });
  });
}

function run(args) {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: 120000 }, (error, stdout, stderr) => {
      done({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

let fixture;
let copy;
before(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  fixture = await startFixture();
  copy = await startCopy();
});
after(async () => {
  await fixture.close();
  await copy.close();
  rmSync(TMP, { recursive: true, force: true });
});

test('--help prints usage and exits 0', async () => {
  const { code, stdout } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage: node styles\.mjs/);
});

test('missing arguments exit 2', async () => {
  const { code, stderr } = await run(['--live', 'http://127.0.0.1:1']);
  assert.equal(code, 2);
  assert.match(stderr, /--new/);
});

test('the fixture against itself passes every row (routes from templates.json)', async () => {
  const templates = join(TMP, 'templates.json');
  writeFileSync(templates, JSON.stringify([
    { name: 'home', representative: '/' },
    { name: 'page', representative: '/contact/' },
  ]));
  const out = join(TMP, 'same.json');
  const { code, stdout, stderr } = await run([
    '--live', fixture.origin, '--new', fixture.origin, '--routes', templates,
    '--widths', '390,1440', '--out', out, '--delay', '0',
  ]);
  assert.equal(code, 0, stdout + stderr);
  const rows = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(rows.length > 100, `${rows.length} rows`);
  assert.deepEqual([...new Set(rows.map((r) => r.route))], ['/', '/contact/']);
  assert.deepEqual([...new Set(rows.map((r) => r.width))], [390, 1440]);
  for (const key of ['route', 'width', 'selector', 'property', 'live', 'new', 'pass']) {
    assert.ok(key in rows[0], key);
  }
  assert.equal(rows.filter((r) => !r.pass).length, 0);
  const family = rows.find((r) => r.route === '/contact/' && r.selector === 'h1' && r.property === 'font-family');
  assert.equal(family.live, 'Fixture Serif');
  const button = rows.find((r) => r.route === '/contact/' && r.selector === 'button' && r.property === 'padding-top');
  assert.ok(button, 'the contact button is sampled');
});

test('a copy whose CSS sets h1 to 40px fails the h1 font-size row', async () => {
  const out = join(TMP, 'h1.json');
  const { code, stdout } = await run([
    '--live', fixture.origin, '--new', copy.origin, '--routes', '/about/',
    '--widths', '1440', '--out', out, '--delay', '0',
  ]);
  assert.equal(code, 1);
  assert.match(stdout, /FAIL/);
  const rows = JSON.parse(readFileSync(out, 'utf8'));
  const size = rows.find((r) => r.selector === 'h1' && r.property === 'font-size');
  assert.equal(size.pass, false);
  assert.equal(size.live, '32px');
  assert.equal(size.new, '40px');
  const failing = rows.filter((r) => !r.pass);
  assert.ok(failing.every((r) => r.selector === 'h1'), JSON.stringify(failing));
  assert.ok(rows.filter((r) => r.selector === 'p').every((r) => r.pass));
});

test('--routes / is a route, not a folder to read', async () => {
  assert.deepEqual(parseRoutes('/'), ['/']);
  assert.deepEqual(parseRoutes('/,/about/'), ['/', '/about/']);
  const out = join(TMP, 'root.json');
  const { code, stdout, stderr } = await run([
    '--live', fixture.origin, '--new', fixture.origin, '--routes', '/',
    '--widths', '390', '--out', out, '--delay', '0',
  ]);
  assert.equal(code, 0, stdout + stderr);
  const rows = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(rows.length > 0 && rows.every((r) => r.route === '/' && r.pass));
});

test('a route missing on the new site fails one status row', async () => {
  const out = join(TMP, 'status.json');
  const { code } = await run([
    '--live', fixture.origin, '--new', copy.origin, '--routes', '/contact/',
    '--widths', '390', '--out', out, '--delay', '0',
  ]);
  assert.equal(code, 1);
  const rows = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(rows, [
    { route: '/contact/', width: 390, selector: 'document', property: 'status', live: 200, new: 404, pass: false },
  ]);
});

test('firstFamily takes the first family and strips quotes', () => {
  assert.equal(firstFamily('"Fixture Serif", Georgia, serif'), 'Fixture Serif');
  assert.equal(firstFamily("'Open Sans',sans-serif"), 'Open Sans');
  assert.equal(firstFamily('Arial'), 'Arial');
});

test('compareSamples: a selector on one side only fails a present row; letter-spacing normal equals 0px', () => {
  const style = {
    'font-family': 'Arial', 'font-size': '16px', 'font-weight': '400', 'line-height': 'normal',
    'letter-spacing': 'normal', color: 'rgb(0, 0, 0)', 'background-color': 'rgba(0, 0, 0, 0)',
    'text-transform': 'none', 'margin-top': '0px', 'margin-bottom': '0px', 'padding-top': '0px',
    'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px',
  };
  const live = { status: 200, styles: { p: style, footer: style } };
  const next = { status: 200, styles: { p: { ...style, 'letter-spacing': '0px', 'font-size': '16.8px' }, footer: null } };
  const rows = compareSamples('/', 390, live, next);
  assert.deepEqual(rows.filter((r) => !r.pass), [
    { route: '/', width: 390, selector: 'footer', property: 'present', live: true, new: false, pass: false },
  ]);
  assert.equal(rows.find((r) => r.property === 'letter-spacing').live, '0px');
});
