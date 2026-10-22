// Chromium helpers for stable full-page screenshots: frozen motion, lazy content
// loaded, fonts ready, cookie banner out of the way.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const FREEZE_CSS = join(dirname(fileURLToPath(import.meta.url)), 'freeze.css');
const VIEWPORT_HEIGHT = 900;
const IMAGE_TIMEOUT_MS = 10000;

export const launchBrowser = () => chromium.launch();

// One context per width: device scale, reduced motion and the shared user agent.
export function newShotContext(browser, { width, scale = 1 }) {
  return browser.newContext({
    viewport: { width, height: VIEWPORT_HEIGHT },
    deviceScaleFactor: scale,
    reducedMotion: 'reduce',
    userAgent: USER_AGENT,
  });
}

// Stops animations and transitions and forces scroll-reveal content visible.
// Injected with evaluate rather than addStyleTag, which never settles on a page
// whose own scripts are disabled.
export async function freezePage(page) {
  await page.evaluate((css) => {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head ?? document.documentElement).append(style);
  }, freezeCss());
}

let cachedFreezeCss;
const freezeCss = () => (cachedFreezeCss ??= readFileSync(FREEZE_CSS, 'utf8'));

// Scrolls to the bottom one viewport at a time so lazy loaders fire, returns to
// the top, then waits for every image to finish (or fail).
export async function loadLazyContent(page) {
  await page.evaluate(async (timeoutMs) => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    for (const img of document.querySelectorAll('img[loading="lazy"]')) img.loading = 'eager';
    const step = Math.max(200, window.innerHeight);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await pause(100);
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await pause(250);
    window.scrollTo(0, 0);
    const pending = [...document.images].filter((img) => !img.complete);
    await Promise.race([
      Promise.all(pending.map((img) => new Promise((done) => {
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      }))),
      pause(timeoutMs),
    ]);
  }, IMAGE_TIMEOUT_MS);
}

// Clicks a consent button (accept / agree / got it / ok) inside a fixed or sticky
// layer or a cookie / consent container. Returns true when one was clicked.
export async function closeCookieBanner(page) {
  const clicked = await page.evaluate(() => {
    const LABEL = /\b(accept|agree|got it|ok)\b/i;
    const CONTAINER = /cookie|consent|gdpr|privacy/i;
    const inBanner = (el) => {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const { position } = getComputedStyle(node);
        if (position === 'fixed' || position === 'sticky') return true;
        if (CONTAINER.test(`${node.id} ${node.className} ${node.getAttribute('aria-label') ?? ''}`)) return true;
      }
      return false;
    };
    const safeLink = (el) => el.tagName !== 'A' || !el.getAttribute('href') || /^(#|javascript:)/i.test(el.getAttribute('href'));
    const candidates = document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a');
    for (const el of candidates) {
      const text = (el.value || el.textContent || '').trim();
      if (text.length > 40 || !LABEL.test(text) || !safeLink(el)) continue;
      if (!el.getClientRects().length || !inBanner(el)) continue;
      el.click();
      return true;
    }
    return false;
  });
  if (clicked) await page.waitForTimeout(300);
  return clicked;
}

// Loads url and returns a full-page PNG plus what was done to get it.
export async function capture(page, url, { wait = 1500 } = {}) {
  const response = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  const status = response ? response.status() : 0;
  await freezePage(page);
  const bannerClosed = await closeCookieBanner(page);
  await loadLazyContent(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if (wait > 0) await page.waitForTimeout(wait);
  const buffer = await page.screenshot({ fullPage: true, animations: 'disabled' });
  return { status, buffer, bannerClosed };
}

// PNG height from the IHDR chunk, without decoding the image.
export const pngHeight = (buffer) => buffer.readUInt32BE(20);
