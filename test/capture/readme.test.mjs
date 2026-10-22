import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';

const exec = promisify(execFile);
const script = (name) => fileURLToPath(new URL(`../../skills/capture-site/scripts/${name}`, import.meta.url));
const SITE = fileURLToPath(new URL('../fixture/site/', import.meta.url));
const THEME_CSS = join(SITE, 'wp-content/themes/fixture/style.css');

async function run(name, args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script(name), ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

// The files the media step writes, as small hand-made samples, for captures made without it.
function writeMediaSamples(dir, origin) {
  const upload = (name) => `${origin}/wp-content/uploads/2026/01/${name}`;
  const media = [
    { url: upload('hero.jpg'), path: '/wp-content/uploads/2026/01/hero.jpg', source: ['srcset', 'og'], referencedBy: ['/'], status: 200, contentType: 'image/jpeg', bytes: 120000 },
    { url: upload('team.jpg'), path: '/wp-content/uploads/2026/01/team.jpg', source: ['srcset'], referencedBy: ['/about/'], status: 200, contentType: 'image/jpeg', bytes: 90000 },
    { url: upload('logo.svg'), path: '/wp-content/uploads/2026/01/logo.svg', source: ['html'], referencedBy: ['/', '/about/'], status: 200, contentType: 'image/svg+xml', bytes: 1200 },
  ];
  writeFileSync(join(dir, 'media.json'), `${JSON.stringify(media, null, 2)}\n`);
  mkdirSync(join(dir, 'css'), { recursive: true });
  cpSync(THEME_CSS, join(dir, 'css', '1.css'));
  const manifest = [{ file: '1.css', href: `${origin}/wp-content/themes/fixture/style.css?ver=1.4.2`, pages: ['/', '/about/'] }];
  writeFileSync(join(dir, 'css', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, 'wayback-unverified.txt'), '');
}

let fixture;
let dir;
let bare;
let assets;
let bareAssets;
let readme;
let bareReadme;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'readme-test-'));
  bare = mkdtempSync(join(tmpdir(), 'readme-bare-test-'));
  fixture = await startFixture();
  const crawl = await run('capture.mjs', [fixture.origin, '--out', dir, '--delay', '0', '--no-rest', '--seed', '/private-page/']);
  assert.equal(crawl.code, 0, crawl.stderr);
  cpSync(dir, bare, { recursive: true });
  writeMediaSamples(dir, fixture.origin);

  for (const d of [dir, bare]) {
    const t = await run('templates.mjs', ['--capture', d]);
    assert.equal(t.code, 0, t.stderr);
  }
  assets = await run('assets.mjs', ['--capture', dir, '--delay', '0']);
  bareAssets = await run('assets.mjs', ['--capture', bare, '--delay', '0']);
  for (const d of [dir, bare]) {
    const r = await run('readme.mjs', ['--capture', d]);
    assert.equal(r.code, 0, r.stderr);
  }
  readme = readFileSync(join(dir, 'README.md'), 'utf8');
  bareReadme = readFileSync(join(bare, 'README.md'), 'utf8');
});
after(async () => {
  await fixture.close();
  for (const d of [dir, bare]) rmSync(d, { recursive: true, force: true });
});

const sameBytes = (saved, original) => assert.ok(readFileSync(saved).equals(readFileSync(original)), saved);

test('assets.mjs saves the logo, the favicon and both fonts byte for byte', () => {
  assert.equal(assets.code, 0, assets.stderr);
  sameBytes(join(dir, 'assets', 'logo.svg'), join(SITE, 'wp-content/uploads/2026/01/logo.svg'));
  sameBytes(join(dir, 'assets', 'favicon.svg'), join(SITE, 'wp-content/uploads/2026/01/logo.svg'));
  for (const font of ['fixture-sans.woff2', 'fixture-serif.woff2']) {
    sameBytes(join(dir, 'assets', 'fonts', font), join(SITE, 'wp-content/themes/fixture/fonts', font));
  }
  assert.match(assets.stdout, /apple-touch-icon: none/);
});

test('assets.mjs without captured CSS still saves the logo and says fonts were not captured', () => {
  assert.equal(bareAssets.code, 0, bareAssets.stderr);
  assert.ok(existsSync(join(bare, 'assets', 'logo.svg')));
  assert.ok(!existsSync(join(bare, 'assets', 'fonts')));
  assert.match(bareAssets.stdout, /fonts: not captured/);
});

test('the README covers templates, vendors, indexing and the Wayback check', () => {
  assert.match(readme, /^# Capture of http:\/\/127\.0\.0\.1:\d+/m);
  assert.match(readme, /Platform: wordpress 6\.6\.2/);
  assert.match(readme, /Theme: fixture/);
  assert.match(readme, /^## Templates$/m);
  assert.match(readme, /\| page \| 7 \| /);
  assert.match(readme, /\| archive \| 2 \| /);
  assert.match(readme, /G-FIXTURE1/);
  assert.match(readme, /GTM-FIXTURE/);
  assert.match(readme, /noindex: 1/);
  assert.match(readme, /\/private-page\//);
  assert.match(readme, /\| seed \| 1 \|/, 'foundBy counts');
  // Eleven linked pages plus the seeded noindex page, each with its own ?p= shortlink.
  assert.match(readme, /\| shortlink \| 12 \| 12 unverified \|/, 'redirects by source');
  assert.match(readme, /Media files: 3, 206\.3 KB/);
  assert.match(readme, /Largest: \/wp-content\/uploads\/2026\/01\/hero\.jpg \(117\.2 KB\)/);
  assert.match(readme, /\/contact\/.*name, email, message, website/);
  assert.match(readme, /\/feed\//);
  assert.match(readme, /Iframes: none/);
  assert.match(readme, /Wayback unverified: 0/);
  assert.match(readme, /## Notes\n*$/);
});

test('the README says plainly what was not captured', () => {
  assert.match(bareReadme, /Media: not captured/);
  assert.match(bareReadme, /Wayback unverified: not captured/);
  assert.match(bareReadme, /^## Templates$/m);
});
