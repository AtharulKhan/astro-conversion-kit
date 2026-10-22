#!/usr/bin/env node
// Brand assets: the logo, the favicon, the apple-touch-icon and every web font, saved byte for
// byte into <capture>/assets/ so the build can use the originals.
// Sources: <link rel=icon|apple-touch-icon> and the first <img> inside <header> or .logo on the
// home page snapshot, and every @font-face src in the stylesheets under <capture>/css/.
// Requests are paced like the crawl; files already saved are kept, so a stopped run resumes.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as csstree from 'css-tree';
import { assertNodeVersion } from '../../../scripts/lib/node-version.mjs';
import { attr, children, findAll, isElement, parseHtml } from '../../parity-gates/scripts/lib/html.mjs';
import { BLOCK_LIMIT, DEFAULT_DELAY_MS, DEFAULT_UA, fetchPaced, http } from './lib/http.mjs';

const USAGE = `Usage: node assets.mjs --capture <dir> [--delay <ms>] [--ua "<string>"]

Save the site's logo, favicon, apple-touch-icon and web fonts into <dir>/assets/
(logo.*, favicon.*, apple-touch-icon.*, fonts/*). The logo is the first <img> inside
<header> or .logo on the home page; the icons come from its <link rel=icon> and
<link rel=apple-touch-icon>; the fonts are every @font-face src in <dir>/css/ (written by the
media step; without it, fonts are reported as not captured).

  --capture <dir>   the capture folder written by capture.mjs
  --delay <ms>      wait between requests (default ${DEFAULT_DELAY_MS})
  --ua "<string>"   user agent (default: a desktop Chrome)
  --help            show this help

Exit codes: 0 done, 1 a file could not be downloaded, 2 usage error or no inventory.json,
3 stopped because the site is blocking requests (wait, then run the same command again).`;

const TYPE_EXTENSIONS = {
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/avif': '.avif',
};
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original'];

class Blocked extends Error {}

const relTokens = (node) => (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
const classTokens = (node) => (attr(node, 'class') ?? '').split(/\s+/).filter(Boolean);

function resolveUrl(href, base) {
  if (!href || /^data:/i.test(href.trim())) return null;
  try {
    const url = new URL(href.trim(), base);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function imageSrc(img) {
  const src = attr(img, 'src');
  if (src && !/^data:/i.test(src.trim())) return src;
  return LAZY_SRC.map((name) => attr(img, name)).find(Boolean) ?? null;
}

// The first <img> (document order) inside a <header> or an element with class "logo".
function logoImage(document) {
  let found = null;
  const visit = (node, inside) => {
    if (found) return;
    const here = inside || node.tagName === 'header' || (isElement(node) && classTokens(node).includes('logo'));
    if (here && node.tagName === 'img' && imageSrc(node)) {
      found = node;
      return;
    }
    for (const child of children(node)) visit(child, here);
  };
  visit(document, false);
  return found;
}

function iconHref(document, rels) {
  const link = findAll(document, (n) => n.tagName === 'link' && relTokens(n).some((r) => rels.includes(r)))[0];
  return link ? attr(link, 'href') : null;
}

function homeRecord(dir, inventory) {
  const pages = inventory.filter((r) => r.status === 200 && r.snapshot && existsSync(join(dir, r.snapshot)));
  return pages.find((r) => r.path === '/') ?? pages[0] ?? null;
}

// Every @font-face src url in the captured stylesheets, resolved against where each came from.
function fontUrls(dir, origin) {
  const cssDir = join(dir, 'css');
  const manifestFile = join(cssDir, 'manifest.json');
  if (!existsSync(manifestFile)) return null;
  const urls = [];
  for (const entry of JSON.parse(readFileSync(manifestFile, 'utf8'))) {
    const file = [join(cssDir, entry.file), join(dir, entry.file)].find((f) => existsSync(f));
    if (!file) continue;
    const base = entry.href ?? new URL(entry.pages?.[0] ?? '/', origin).href;
    const ast = csstree.parse(readFileSync(file, 'utf8'), { parseValue: true, onParseError: () => {} });
    csstree.walk(ast, {
      visit: 'Atrule',
      enter(rule) {
        if (rule.name.toLowerCase() !== 'font-face' || !rule.block) return;
        csstree.walk(rule.block, {
          visit: 'Declaration',
          enter(decl) {
            if (decl.property.toLowerCase() !== 'src') return;
            csstree.walk(decl.value, {
              visit: 'Url',
              enter(node) {
                const url = resolveUrl(node.value, base);
                if (url && !urls.includes(url)) urls.push(url);
              },
            });
          },
        });
      },
    });
  }
  return urls;
}

function extensionFor(url, contentType) {
  const fromPath = extname(new URL(url).pathname).toLowerCase();
  if (fromPath) return fromPath;
  return TYPE_EXTENSIONS[(contentType ?? '').split(';')[0].trim().toLowerCase()] ?? '';
}

function parseArgs(argv) {
  const args = { capture: null, delayMs: DEFAULT_DELAY_MS, ua: DEFAULT_UA, help: false };
  const value = (i) => (i < argv.length && !argv[i].startsWith('--') ? argv[i] : null);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--capture' && value(i + 1)) args.capture = argv[(i += 1)];
    else if (arg === '--ua' && value(i + 1)) args.ua = argv[(i += 1)];
    else if (arg === '--delay' && value(i + 1)) {
      args.delayMs = Number(argv[(i += 1)]);
      if (!Number.isInteger(args.delayMs) || args.delayMs < 0) return { error: '--delay needs a whole number' };
    } else return { error: `unknown or incomplete option ${arg}` };
  }
  if (!args.help && !args.capture) return { error: '--capture <dir> is required' };
  return args;
}

async function main() {
  assertNodeVersion();
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const dir = resolve(args.capture);
  const inventoryFile = join(dir, 'inventory.json');
  if (!existsSync(inventoryFile)) {
    console.error(`No inventory.json in ${dir}. Run capture.mjs first.`);
    process.exit(2);
  }
  const inventory = JSON.parse(readFileSync(inventoryFile, 'utf8'));
  const metaFile = join(dir, 'meta.json');
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
  const home = homeRecord(dir, inventory);
  const origin = meta.canonicalOrigin ?? meta.origin ?? (home ? new URL(home.url).origin : null);
  const out = join(dir, 'assets');
  const lines = [];
  let failed = 0;
  http.resetBlocked();

  // Saves url as <out>/<stem><ext> (or keeps an earlier download). Returns the saved name.
  const fontNames = new Map(); // file name -> url, so two fonts with one name do not overwrite
  const save = async (url, stem, { keepName = false } = {}) => {
    let name = null;
    if (keepName) {
      const original = basename(new URL(url).pathname) || 'font';
      name = original;
      for (let n = 2; fontNames.has(name) && fontNames.get(name) !== url; n += 1) {
        name = original.replace(/(\.[^.]*)?$/, (ext) => `-${n}${ext}`);
      }
      fontNames.set(name, url);
    }
    const known = keepName ? join(out, stem, name) : null;
    if (known && existsSync(known)) return `${stem}/${name}`;
    const res = await fetchPaced(url, { delayMs: args.delayMs, ua: args.ua, redirect: 'follow' });
    if (http.blocked >= BLOCK_LIMIT) throw new Blocked();
    if (res.status !== 200) {
      failed += 1;
      return { error: `${url} returned ${res.status || res.error}` };
    }
    const file = known ?? join(out, `${stem}${extensionFor(url, res.headers['content-type'])}`);
    mkdirSync(resolve(file, '..'), { recursive: true });
    writeFileSync(file, Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body));
    return file.slice(out.length + 1);
  };
  const report = (label, result) => lines.push(typeof result === 'string' ? `${label}: assets/${result}` : `${label}: ${result.error}`);

  try {
    if (!home) {
      lines.push('logo, favicon, apple-touch-icon: not captured (no page snapshot answered 200)');
    } else {
      const document = parseHtml(readFileSync(join(dir, home.snapshot), 'utf8'));
      const img = logoImage(document);
      const targets = [
        ['logo', img ? resolveUrl(imageSrc(img), home.url) : null, 'no <img> inside <header> or .logo'],
        ['favicon', resolveUrl(iconHref(document, ['icon']), home.url), 'none on the site'],
        ['apple-touch-icon', resolveUrl(iconHref(document, ['apple-touch-icon', 'apple-touch-icon-precomposed']), home.url), 'none on the site'],
      ];
      for (const [stem, url, missing] of targets) {
        if (url) report(stem, await save(url, stem));
        else lines.push(`${stem}: ${missing}`);
      }
    }

    const fonts = origin ? fontUrls(dir, origin) : null;
    if (fonts === null) {
      lines.push('fonts: not captured (no css/manifest.json in the capture; run the media step first)');
    } else if (fonts.length === 0) {
      lines.push('fonts: none (no @font-face src in the captured CSS)');
    } else {
      for (const url of fonts) report('font', await save(url, 'fonts', { keepName: true }));
    }
  } catch (err) {
    if (!(err instanceof Blocked)) throw err;
    console.log(lines.join('\n'));
    console.error('Stopped: the site is blocking requests. Wait a while, then run the same command again.');
    process.exit(3);
  }

  console.log(lines.join('\n'));
  if (failed > 0) process.exit(1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
