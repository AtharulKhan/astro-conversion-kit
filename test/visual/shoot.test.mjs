import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startFixture } from '../fixture/serve.mjs';
import { run, readPng, TMP } from './helpers.mjs';
import { freezePage, loadLazyContent, closeCookieBanner } from '../../skills/visual-review/scripts/lib/browser.mjs';
import { heightMismatch } from '../../skills/visual-review/scripts/shoot.mjs';

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
  assert.deepEqual(Object.keys(entry).sort(), ['bannerClosed', 'file', 'heightMismatch', 'heightPx', 'route', 'scrollHeight', 'width']);
  assert.equal(entry.file, 'home/390.png');
  assert.equal(entry.heightPx, readPng(join(OUT, 'home', '390.png')).height);
  assert.equal(entry.bannerClosed, false);
  assert.equal(entry.scrollHeight, entry.heightPx);
  assert.equal(entry.heightMismatch, false);
});

test('heightMismatch flags a PNG more than 2 px off the scaled page height', () => {
  assert.equal(heightMismatch(1000, 1000, 1), false);
  assert.equal(heightMismatch(1002, 1000, 1), false);
  assert.equal(heightMismatch(1003, 1000, 1), true);
  assert.equal(heightMismatch(500, 1001, 0.5), false);
  assert.equal(heightMismatch(16384, 20000, 1), true);
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

// A page that adds another 2000 px every time it is scrolled never has a bottom.
const GROWING_PAGE = `<div style="height:2000px"></div><script>
  addEventListener('scroll', () => {
    const more = document.createElement('div');
    more.style.height = '2000px';
    document.body.append(more);
  });
</script>`;

test('the lazy scroll stops at the viewport cap on a page that keeps growing', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(GROWING_PAGE);
  const messages = [];
  const result = await loadLazyContent(page, { limits: { maxViewports: 5, maxMs: 30000 }, log: (m) => messages.push(m) });
  assert.equal(result.capped, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /stopped at 5 viewports/);
  assert.equal(await page.evaluate(() => scrollY), 0);
  await page.close();
});

test('the lazy scroll stops at the time cap', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(GROWING_PAGE);
  const started = Date.now();
  const result = await loadLazyContent(page, { limits: { maxViewports: 100000, maxMs: 600 }, log: () => {} });
  assert.equal(result.capped, true);
  assert.ok(Date.now() - started < 5000);
  await page.close();
});

test('the fixture home page does not hit the lazy scroll cap', async () => {
  const page = await browser.newPage();
  await page.goto(`${fixture.origin}/`);
  const messages = [];
  assert.equal((await loadLazyContent(page, { log: (m) => messages.push(m) })).capped, false);
  assert.deepEqual(messages, []);
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

test('--full shoots every path of every template into path-slug folders', async () => {
  const dir = join(TMP, 'visual-shoot-full');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const templates = join(dir, 'templates.json');
  writeFileSync(templates, JSON.stringify([
    { name: 'page', representative: '/about/', paths: ['/about/', '/contact/'] },
    { name: 'service', representative: '/services/roofing/', paths: ['/services/roofing/'] },
  ]));
  const out = join(dir, 'out');
  const result = await run('shoot.mjs', ['--base', fixture.origin, '--routes', templates, '--full', '--widths', '390', '--out', out, '--delay', '0', '--wait', '0']);
  assert.equal(result.code, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.map((m) => m.file), ['about/390.png', 'contact/390.png', 'services__roofing/390.png']);
  assert.ok(!existsSync(join(out, 'page')));
});

test('a route that fails is recorded with an error, the rest are shot, and the exit is 1', async () => {
  const out = join(TMP, 'visual-shoot-404');
  rmSync(out, { recursive: true, force: true });
  const result = await run('shoot.mjs', ['--base', fixture.origin, '--routes', '/deleted-post/,/about/', '--widths', '390', '--out', out, '--delay', '0', '--wait', '0']);
  assert.equal(result.code, 1);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.length, 2);
  assert.equal(manifest[0].route, 'deleted-post');
  assert.equal(manifest[0].file, null);
  assert.equal(manifest[0].error, 'HTTP 404');
  assert.equal(manifest[1].file, 'about/390.png');
  assert.ok(existsSync(join(out, 'about', '390.png')));
});

test('unsafe template names and duplicate folders exit 2', async () => {
  const dir = join(TMP, 'visual-shoot-names');
  mkdirSync(dir, { recursive: true });
  for (const name of ['../escape', 'a/b', '.hidden', '']) {
    const templates = join(dir, 'templates.json');
    writeFileSync(templates, JSON.stringify([{ name, representative: '/', paths: ['/'] }]));
    const result = await run('shoot.mjs', ['--base', fixture.origin, '--routes', templates, '--out', join(dir, 'out')]);
    assert.equal(result.code, 2, `name ${JSON.stringify(name)}`);
  }
  const duplicate = await run('shoot.mjs', ['--base', fixture.origin, '--routes', '/about/,/about', '--out', join(dir, 'out')]);
  assert.equal(duplicate.code, 2);
  assert.match(duplicate.stderr, /folder about/);
});

test('bad usage exits 2', async () => {
  assert.equal((await run('shoot.mjs', ['--base', fixture.origin])).code, 2);
  assert.equal((await run('shoot.mjs', ['--base', fixture.origin, '--routes', '/', '--out', OUT, '--scale', '2'])).code, 2);
  assert.equal((await run('shoot.mjs', ['--base', fixture.origin, '--routes', '/', '--out', OUT, '--widths', '390.5'])).code, 2);
  const help = await run('shoot.mjs', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--scale/);
});
