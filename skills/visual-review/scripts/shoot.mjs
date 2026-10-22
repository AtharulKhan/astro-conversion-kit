#!/usr/bin/env node
// Full-page Chromium screenshots of a set of routes at a set of widths.
// Exit 0 all shot, 1 a route failed to load, 2 usage or environment error,
// 3 stopped after repeated blocks (the manifest holds what was shot).
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../../../scripts/lib/node-version.mjs';
import { capture, launchBrowser, newShotContext, pngHeight } from './lib/browser.mjs';

const HELP = `Usage: node shoot.mjs --base <origin> --routes <templates.json|/,/a/b/> --out <dir>
                      [--widths 390,768,1440] [--delay 2500] [--wait 1500] [--full] [--scale 1]

Takes a full-page Chromium screenshot of every route at every width and writes
  <out>/<route>/<width>.png and <out>/manifest.json
  ([{ route, width, file, heightPx, bannerClosed }]).

  --base     origin to shoot, e.g. https://www.example.com
  --routes   a templates.json ([{ name, representative, paths[] }]: the folder is
             the template name and the representative path is shot) or a comma
             list of paths (folder is the path slug: / -> home, /a/b/ -> a__b)
  --widths   comma list of viewport widths in CSS pixels (default 390,768,1440)
  --out      output directory
  --delay    milliseconds between page loads (default 2500)
  --wait     milliseconds to settle before each capture (default 1500)
  --full     with a templates.json, shoot every path of every template
             (folders are path slugs) instead of only the representative
  --scale    device scale factor from 0.1 to 1 (default 1); 0.5 gives
             half-size images for previews

Motion is frozen (prefers-reduced-motion plus injected CSS), scroll-reveal
content is forced visible, lazy images are loaded by scrolling to the bottom and
back, web fonts are awaited, and a cookie banner whose button says accept,
agree, got it or ok is closed (reported as bannerClosed).

Exit codes: 0 all shot, 1 a route failed to load, 2 usage error,
3 stopped after 3 consecutive blocked responses (403/429/503/network).`;

const BLOCKED = new Set([403, 429, 503]);
const MAX_CONSECUTIVE_BLOCKS = 3;

class UsageError extends Error {}

export function slugFor(path) {
  const trimmed = path.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  if (!trimmed) return 'home';
  return trimmed.split('/').map((part) => part.replace(/[^A-Za-z0-9_.-]/g, '-')).join('__');
}

function readRoutes(value, full) {
  if (value.endsWith('.json') || (existsSync(value) && statSync(value).isFile())) {
    let templates;
    try {
      templates = JSON.parse(readFileSync(value, 'utf8'));
    } catch (error) {
      throw new UsageError(`cannot read --routes ${value}: ${error.message}`);
    }
    if (!Array.isArray(templates)) throw new UsageError('--routes JSON must be an array of { name, representative, paths }');
    if (full) return templates.flatMap((t) => (t.paths ?? [t.representative]).map((path) => ({ route: slugFor(path), path })));
    return templates.map((t) => {
      if (!t.name || !t.representative) throw new UsageError('every template needs a name and a representative');
      return { route: String(t.name), path: t.representative };
    });
  }
  return value.split(',').map((p) => p.trim()).filter(Boolean).map((path) => ({ route: slugFor(path), path }));
}

function number(value, name, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`--${name} must be a number from ${min} to ${max}`);
  return n;
}

function parse(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        base: { type: 'string' },
        routes: { type: 'string' },
        widths: { type: 'string', default: '390,768,1440' },
        out: { type: 'string' },
        delay: { type: 'string', default: '2500' },
        wait: { type: 'string', default: '1500' },
        full: { type: 'boolean', default: false },
        scale: { type: 'string', default: '1' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.help) return { help: true };
  if (!values.base || !values.routes || !values.out) throw new UsageError('--base, --routes and --out are required');
  let base;
  try {
    base = new URL(values.base).origin;
  } catch {
    throw new UsageError(`--base is not a URL: ${values.base}`);
  }
  const widths = values.widths.split(',').map((w) => number(w.trim(), 'widths', { min: 100, max: 4000 }));
  const routes = readRoutes(values.routes, values.full);
  if (!routes.length) throw new UsageError('--routes names no paths');
  return {
    base,
    routes,
    widths,
    out: resolve(values.out),
    delay: number(values.delay, 'delay', { min: 0, max: 600000 }),
    wait: number(values.wait, 'wait', { min: 0, max: 600000 }),
    scale: number(values.scale, 'scale', { min: 0.1, max: 1 }),
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function shoot({ base, routes, widths, out, delay, wait, scale }) {
  const manifest = [];
  const failures = [];
  let stopped = false;
  let pace = delay;
  let first = true;
  const browser = await launchBrowser();
  try {
    widths: for (const width of widths) {
      const context = await newShotContext(browser, { width, scale });
      const page = await context.newPage();
      for (const { route, path } of routes) {
        const url = new URL(path, base).href;
        let blocks = 0;
        for (;;) {
          if (!first) await sleep(pace);
          first = false;
          let result;
          try {
            result = await capture(page, url, { wait });
          } catch (error) {
            result = { status: 0, error };
          }
          if (result.status === 0 || BLOCKED.has(result.status)) {
            blocks += 1;
            console.error(`blocked: ${url} at ${width} (${result.error ? result.error.message.split('\n')[0] : result.status})`);
            if (blocks >= MAX_CONSECUTIVE_BLOCKS) {
              stopped = true;
              break widths;
            }
            pace = Math.max(pace, 1000) * 2;
            continue;
          }
          if (result.status >= 400) {
            failures.push(`${url} at ${width}: HTTP ${result.status}`);
            break;
          }
          const file = `${route}/${width}.png`;
          mkdirSync(join(out, route), { recursive: true });
          writeFileSync(join(out, file), result.buffer);
          const entry = { route, width, file, heightPx: pngHeight(result.buffer), bannerClosed: result.bannerClosed };
          manifest.push(entry);
          console.log(`${file} ${entry.heightPx}px${entry.bannerClosed ? ' (cookie banner closed)' : ''}`);
          break;
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (stopped) {
    console.error(`stopped after ${MAX_CONSECUTIVE_BLOCKS} consecutive blocked responses; ${manifest.length} shots saved in ${join(out, 'manifest.json')}`);
    return 3;
  }
  for (const failure of failures) console.error(`failed: ${failure}`);
  return failures.length ? 1 : 0;
}

async function main() {
  assertNodeVersion();
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }
  try {
    process.exit(await shoot(options));
  } catch (error) {
    console.error(`environment error: ${error.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
