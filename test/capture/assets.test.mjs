import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startStub } from './helpers.mjs';

const exec = promisify(execFile);
const ASSETS = fileURLToPath(new URL('../../skills/capture-site/scripts/assets.mjs', import.meta.url));

async function run(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [ASSETS, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

// A capture folder with one home page and one stylesheet, written by hand.
function tinyCapture(origin, html, css) {
  const dir = mkdtempSync(join(tmpdir(), 'assets-test-'));
  mkdirSync(join(dir, 'pages'));
  mkdirSync(join(dir, 'css'));
  writeFileSync(join(dir, 'pages/home.html'), html);
  writeFileSync(join(dir, 'css/1.css'), css);
  writeFileSync(join(dir, 'css/manifest.json'), JSON.stringify([{ file: '1.css', href: `${origin}/style.css`, pages: ['/'] }]));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ origin, canonicalOrigin: origin }));
  writeFileSync(join(dir, 'inventory.json'), JSON.stringify([{ url: `${origin}/`, path: '/', status: 200, snapshot: 'pages/home.html' }]));
  return dir;
}

const FONT_CSS = "@font-face{font-family:A;src:url(/fonts/big.woff2) format('woff2')}@font-face{font-family:B;src:url(/fonts/small.woff2)}";

test('assets.mjs streams fonts to disk and records one over --max-file-bytes as "too-large"', async () => {
  const site = await startStub({
    '/logo.svg': { headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' },
    '/fonts/big.woff2': { headers: { 'Content-Type': 'font/woff2' }, body: Buffer.alloc(4000, 2) },
    '/fonts/small.woff2': { headers: { 'Content-Type': 'font/woff2' }, body: Buffer.alloc(10, 3) },
  });
  const dir = tinyCapture(site.origin, '<html><body><header><img src="/logo.svg"></header></body></html>', FONT_CSS);
  try {
    const result = await run(['--capture', dir, '--delay', '0', '--max-file-bytes', '1000']);
    assert.equal(result.code, 0, result.stderr);
    const index = JSON.parse(readFileSync(join(dir, 'assets/index.json'), 'utf8'));
    const big = index.find((e) => e.url === `${site.origin}/fonts/big.woff2`);
    const small = index.find((e) => e.url === `${site.origin}/fonts/small.woff2`);
    assert.equal(big.status, 'too-large');
    assert.equal(big.file, null);
    assert.equal(small.file, 'assets/fonts/small.woff2');
    assert.deepEqual(readFileSync(join(dir, 'assets/fonts/small.woff2')), Buffer.alloc(10, 3));
    assert.deepEqual(readdirSync(join(dir, 'assets/fonts')), ['small.woff2'], 'no partial file is left');
    assert.equal(readFileSync(join(dir, 'assets/logo.svg'), 'utf8'), '<svg/>');
    assert.match(result.stderr, /too-large/);
    assert.match((await run(['--help'])).stdout, /--max-file-bytes/);
    assert.equal((await run(['--capture', dir, '--max-file-bytes', '0'])).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await site.close();
  }
});

test('assets.mjs does not request a logo on another port of 127.0.0.1', async () => {
  const other = await startStub({ '/logo.png': { headers: { 'Content-Type': 'image/png' }, body: 'png' } });
  const site = await startStub({});
  const dir = tinyCapture(site.origin, `<html><body><header><img src="${other.origin}/logo.png"></header></body></html>`, '');
  try {
    const result = await run(['--capture', dir, '--delay', '0']);
    assert.equal(result.code, 0, result.stderr);
    const index = JSON.parse(readFileSync(join(dir, 'assets/index.json'), 'utf8'));
    const logo = index.find((e) => e.kind === 'logo');
    assert.equal(logo.status, 'blocked-address');
    assert.equal(existsSync(join(dir, 'assets/logo.png')), false);
    assert.deepEqual(other.requests, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await other.close();
    await site.close();
  }
});

test('assets.mjs skips css manifest entries that were not saved (file: null) and reads a sheet against its final URL', async () => {
  const site = await startStub({
    '/logo.svg': { headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' },
    '/new/fonts/moved.woff2': { headers: { 'Content-Type': 'font/woff2' }, body: Buffer.alloc(10, 4) },
  });
  const dir = tinyCapture(site.origin, '<html><body><header><img src="/logo.svg"></header></body></html>', '@font-face{font-family:M;src:url(fonts/moved.woff2)}');
  writeFileSync(join(dir, 'css/manifest.json'), JSON.stringify([
    { file: null, href: `${site.origin}/gone.css`, pages: ['/'], status: 404 },
    { file: '1.css', href: `${site.origin}/old.css`, finalUrl: `${site.origin}/new/main.css`, pages: ['/'] },
  ]));
  try {
    const result = await run(['--capture', dir, '--delay', '0']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(readFileSync(join(dir, 'assets/fonts/moved.woff2')), Buffer.alloc(10, 4));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await site.close();
  }
});

// Runs assets.mjs on a one-page capture of `header` and returns the logo's index entry and bytes.
async function pickLogo(site, body) {
  const dir = tinyCapture(site.origin, `<html><body>${body}</body></html>`, '');
  try {
    const result = await run(['--capture', dir, '--delay', '0']);
    assert.equal(result.code, 0, result.stderr);
    const logo = JSON.parse(readFileSync(join(dir, 'assets/index.json'), 'utf8')).find((e) => e.kind === 'logo');
    return { ...logo, bytes: logo.file ? readFileSync(join(dir, logo.file), 'utf8') : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('assets.mjs prefers an image named logo, then an inline logo <svg>, then the home link image, over the first <img>', async () => {
  const svg = { headers: { 'Content-Type': 'image/svg+xml' } };
  const site = await startStub({
    '/theme/avatar-placeholder.svg': { ...svg, body: '<svg>avatar</svg>' },
    '/theme/sxsw-logo.svg': { ...svg, body: '<svg>logo</svg>' },
    '/theme/brand.svg': { ...svg, body: '<svg>brand</svg>' },
    '/theme/mark.svg': { ...svg, body: '<svg>mark</svg>' },
  });
  const avatar = '<div class="account"><img src="/theme/avatar-placeholder.svg" alt=""></div>';
  try {
    const named = await pickLogo(site, `<header>${avatar}<a href="/"><img src="/theme/sxsw-logo.svg" alt="SXSW"></a></header>`);
    assert.equal(named.url, `${site.origin}/theme/sxsw-logo.svg`);
    assert.equal(named.bytes, '<svg>logo</svg>');

    const byAlt = await pickLogo(site, `<header>${avatar}<img src="/theme/brand.svg" alt="Brand logo"></header>`);
    assert.equal(byAlt.url, `${site.origin}/theme/brand.svg`);

    const scoped = await pickLogo(site, `${avatar}<div id="site-logo-wrap"><img src="/theme/mark.svg" class="custom-logo"></div>`);
    assert.equal(scoped.url, `${site.origin}/theme/mark.svg`, 'a [id*=logo] element is searched too');

    const inline = await pickLogo(site, `<header>${avatar}<a href="/"><svg viewBox="0 0 10 10" aria-label="Site logo"><path d="M0 0h10v10z"/></svg></a></header>`);
    assert.equal(inline.url, null);
    assert.equal(inline.file, 'assets/logo.svg');
    assert.equal(inline.status, 200);
    assert.match(inline.note, /inline <svg>/);
    assert.equal(inline.bytes, '<svg viewBox="0 0 10 10" aria-label="Site logo" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"></path></svg>\n');

    const titled = await pickLogo(site, `<header>${avatar}<svg class="mark"><title>Logo</title><circle r="1"/></svg></header>`);
    assert.equal(titled.file, 'assets/logo.svg');
    assert.match(titled.bytes, /<title>Logo<\/title>/);

    const home = await pickLogo(site, `<header>${avatar}<a href="${site.origin}/"><img src="/theme/brand.svg"></a></header>`);
    assert.equal(home.url, `${site.origin}/theme/brand.svg`, 'the image in the home link');

    const first = await pickLogo(site, `<header>${avatar}<img src="/theme/brand.svg"></header>`);
    assert.equal(first.url, `${site.origin}/theme/avatar-placeholder.svg`, 'with no other clue, the first <img> as before');
  } finally {
    await site.close();
  }
});
