import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startFixture } from '../fixture/serve.mjs';
import { run, readPng, TMP } from './helpers.mjs';
import { freezePage, loadLazyContent, closeCookieBanner } from '../../skills/visual-review/scripts/lib/browser.mjs';

const OUT = join(TMP, 'visual-shoot');
let fixture;
let browser;
let shot;

before(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
  rmSync(OUT, { recursive: true, force: true });
  shot = await run('shoot.mjs', ['--base', fixture.origin, '--routes', '/,/services/roofing/', '--widths', '390,1440', '--out', OUT, '--delay', '0', '--wait', '0']);
});
after(async () => {
  await browser.close();
  fixture.close();
});

// The bounding box of the first element matching selector, in page coordinates.
async function boxOf(path, width, selector) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(fixture.origin + path);
  const box = await page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
  });
  await page.close();
  return box;
}

function darkPixelsIn(png, box) {
  let dark = 0;
  for (let y = Math.floor(box.y); y < Math.min(png.height, box.y + box.height); y += 1) {
    for (let x = Math.floor(box.x); x < Math.min(png.width, box.x + box.width); x += 1) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] < 128 && png.data[i + 1] < 128 && png.data[i + 2] < 128) dark += 1;
    }
  }
  return dark;
}

test('shoot exits 0 and writes one full-page PNG per route and width', () => {
  assert.equal(shot.code, 0, shot.stderr);
  for (const width of [390, 1440]) {
    for (const route of ['home', 'services__roofing']) {
      const png = readPng(join(OUT, route, `${width}.png`));
      assert.equal(png.width, width);
      assert.ok(png.height >= 900, `${route}/${width} at least one viewport tall`);
    }
    assert.ok(readPng(join(OUT, 'home', `${width}.png`)).height > 900, `home/${width} is taller than the viewport`);
  }
});

test('manifest.json lists every shot with its height', () => {
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.length, 4);
  const entry = manifest.find((m) => m.route === 'home' && m.width === 390);
  assert.deepEqual(Object.keys(entry).sort(), ['bannerClosed', 'file', 'heightPx', 'route', 'width']);
  assert.equal(entry.file, 'home/390.png');
  assert.equal(entry.heightPx, readPng(join(OUT, 'home', '390.png')).height);
  assert.equal(entry.bannerClosed, false);
});

test('the .reveal section is visible in the screenshot at both widths', async () => {
  for (const width of [390, 1440]) {
    const box = await boxOf('/', width, '.reveal h2');
    const png = readPng(join(OUT, 'home', `${width}.png`));
    assert.ok(darkPixelsIn(png, box) > 50, `reveal heading drawn at ${width}`);
  }
});

test('freeze.css makes .reveal visible even when no script ever adds .in', async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/`);
  const opacity = () => page.$eval('.reveal', (el) => getComputedStyle(el).opacity);
  assert.equal(await opacity(), '0');
  await freezePage(page);
  assert.equal(await opacity(), '1');
  await context.close();
});

test('the lazy data-src image only loads after scrolling to the bottom and back', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 600 } });
  await page.goto(`${fixture.origin}/`);
  const crew = () => page.$eval('img[alt="Our crew"]', (img) => ({ src: img.currentSrc, w: img.naturalWidth, y: scrollY }));
  assert.equal((await crew()).w, 1, 'placeholder until scrolled into view');
  await loadLazyContent(page);
  const loaded = await crew();
  assert.match(loaded.src, /team-/);
  assert.ok(loaded.w > 1);
  assert.equal(loaded.y, 0, 'back at the top');
  await page.close();
});

test('a cookie banner is closed and reported', async () => {
  const page = await browser.newPage();
  await page.setContent('<a href="/book">Book now</a><div id="cookie-notice" style="position:fixed;bottom:0"><p>We use cookies.</p><button onclick="this.parentNode.remove()">Accept all</button></div>');
  assert.equal(await closeCookieBanner(page), true);
  assert.equal(await page.$('#cookie-notice'), null);
  assert.equal(await closeCookieBanner(page), false, 'nothing left to close');
  await page.close();
});

test('--routes accepts a templates.json and names folders after templates', async () => {
  const dir = join(TMP, 'visual-shoot-templates');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const templates = join(dir, 'templates.json');
  writeFileSync(templates, JSON.stringify([{ name: 'page', representative: '/about/', paths: ['/about/', '/contact/'] }]));
  const result = await run('shoot.mjs', ['--base', fixture.origin, '--routes', templates, '--widths', '768', '--out', join(dir, 'out'), '--delay', '0', '--wait', '0', '--scale', '0.5']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readPng(join(dir, 'out', 'page', '768.png')).width, 384, 'scale 0.5 halves the pixels');
  assert.ok(!existsSync(join(dir, 'out', 'contact')));
});

test('bad usage exits 2', async () => {
  assert.equal((await run('shoot.mjs', ['--base', fixture.origin])).code, 2);
  assert.equal((await run('shoot.mjs', ['--base', fixture.origin, '--routes', '/', '--out', OUT, '--scale', '2'])).code, 2);
  const help = await run('shoot.mjs', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--scale/);
});
