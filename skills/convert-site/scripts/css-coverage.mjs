#!/usr/bin/env node
// Records which parts of each stylesheet the site's pages actually use, with
// Chromium CSS coverage over every route at every width.
// Exit codes: 0 written, 1 a route failed to load, 2 usage or environment error,
// 3 stopped after 3 consecutive blocked responses.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { assertNodeVersion } from '../../../scripts/lib/node-version.mjs';

const HELP = `Usage: node css-coverage.mjs --base <origin> --routes <list|inventory.json> --out coverage.json
                           [--widths 390,768,1440] [--delay 2500]

Loads every route at every width in Chromium with CSS coverage on, waits for the
load event and a short settle, hovers and focuses the first a, button and input,
then stops coverage. Results are merged per stylesheet and written as
  { "<stylesheet url>": { text, usedRanges: [[start, end], ...] },
    "inline:<n>": { text, usedRanges, pages: [path, ...] } }
usedRanges are character offsets into text, sorted with overlaps merged. Inline
<style> blocks with the same text share one inline:<n> key and list the pages
they appear on.

  --base     origin to load, e.g. https://www.example.com
  --routes   a comma list of paths, or capture/inventory.json ([{ path, ... }];
             records with a status other than 200 are skipped)
  --widths   comma list of viewport widths (default 390,768,1440)
  --out      coverage file to write
  --delay    milliseconds between page loads (default 2500); doubled on 429/503

Exit codes: 0 written, 1 a route failed to load (the rest are still written),
2 usage or environment error, 3 stopped after 3 consecutive blocked responses
(403/429/503/network; what was collected so far is written).`;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const VIEWPORT_HEIGHT = 900;
const SETTLE_MS = 300;
const BLOCKED = new Set([403, 429, 503]);
const BACKOFF = new Set([429, 503]);
const MAX_CONSECUTIVE_BLOCKS = 3;
const INTERACTIVE = ['a', 'button', 'input'];

class UsageError extends Error {}

// Sorts [start, end] ranges and merges the ones that overlap or touch.
export function mergeRanges(ranges) {
  const sorted = ranges.map(([start, end]) => [start, end]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

export function readRoutes(value) {
  if (!value.endsWith('.json')) return value.split(',').map((path) => path.trim()).filter(Boolean);
  let records;
  try {
    records = JSON.parse(readFileSync(value, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read ${value}: ${error.message}`);
  }
  if (!Array.isArray(records)) throw new UsageError(`${value} is not a JSON array`);
  return records
    .filter((record) => record && typeof record.path === 'string' && (record.status === undefined || record.status === 200))
    .map((record) => record.path);
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
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.help) return { help: true };
  for (const name of ['base', 'routes', 'out']) if (!values[name]) throw new UsageError(`--${name} is required`);
  let base;
  try {
    base = new URL(values.base).origin;
  } catch {
    throw new UsageError(`--base is not a URL: ${values.base}`);
  }
  const widths = values.widths.split(',').map((w) => {
    const width = Number(w.trim());
    if (!Number.isInteger(width) || width < 100 || width > 4000) throw new UsageError(`--widths has a bad width: ${w}`);
    return width;
  });
  const delay = Number(values.delay);
  if (!Number.isFinite(delay) || delay < 0) throw new UsageError(`--delay must be a number of milliseconds: ${values.delay}`);
  const routes = readRoutes(values.routes);
  if (!routes.length) throw new UsageError('--routes names no paths');
  return { base, routes, widths, out: resolve(values.out), delay };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Hover and focus the first of each interactive element so their state rules count.
async function interact(page) {
  for (const selector of INTERACTIVE) {
    const element = page.locator(selector).first();
    if (!(await element.count())) continue;
    await element.hover({ timeout: 1000 }).catch(() => {});
    await element.focus({ timeout: 1000 }).catch(() => {});
  }
}

// One route at one width: returns { status, entries } or { status: 0, error }.
async function coverRoute(page, url) {
  await page.coverage.startCSSCoverage({ resetOnNavigation: false });
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  } catch (error) {
    await page.coverage.stopCSSCoverage().catch(() => {});
    return { status: 0, error };
  }
  await sleep(SETTLE_MS);
  await interact(page);
  const entries = await page.coverage.stopCSSCoverage();
  return { status: response ? response.status() : 0, entries, pageUrl: page.url() };
}

// Folds one page's coverage entries into the merged result.
function addEntries(result, inlineKeys, entries, pageUrl, path) {
  for (const { url, text, ranges } of entries) {
    const used = ranges.map(({ start, end }) => [start, end]);
    const inline = !url || url === pageUrl;
    let key = url;
    if (inline) {
      if (!inlineKeys.has(text)) inlineKeys.set(text, `inline:${inlineKeys.size + 1}`);
      key = inlineKeys.get(text);
    }
    const entry = (result[key] ??= inline ? { text, usedRanges: [], pages: [] } : { text, usedRanges: [] });
    entry.usedRanges = mergeRanges([...entry.usedRanges, ...used]);
    if (inline && !entry.pages.includes(path)) entry.pages.push(path);
  }
}

async function cover({ base, routes, widths, out, delay }) {
  const result = {};
  const inlineKeys = new Map();
  let failed = 0;
  let stopped = false;
  let blocks = 0;
  let pace = delay;
  let first = true;
  const browser = await chromium.launch();
  try {
    widths: for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: VIEWPORT_HEIGHT }, userAgent: USER_AGENT });
      for (const path of routes) {
        const url = new URL(path, base).href;
        for (;;) {
          if (!first) await sleep(pace);
          first = false;
          const page = await context.newPage();
          const outcome = await coverRoute(page, url);
          await page.close().catch(() => {});
          if (outcome.status === 0 || BLOCKED.has(outcome.status)) {
            blocks += 1;
            console.error(`blocked: ${url} at ${width} (${outcome.error ? outcome.error.message.split('\n')[0] : outcome.status})`);
            if (blocks >= MAX_CONSECUTIVE_BLOCKS) {
              stopped = true;
              break widths;
            }
            if (outcome.status === 0 || BACKOFF.has(outcome.status)) pace = Math.max(pace, 1000) * 2;
            continue;
          }
          blocks = 0;
          pace = delay;
          if (outcome.status >= 400) {
            failed += 1;
            console.error(`failed: ${url} at ${width}: HTTP ${outcome.status}`);
          } else {
            addEntries(result, inlineKeys, outcome.entries, outcome.pageUrl, path);
            console.log(`covered ${path} at ${width}`);
          }
          break;
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(`wrote ${out}: ${Object.keys(result).length} stylesheets`);
  if (stopped) {
    console.error(`stopped after ${MAX_CONSECUTIVE_BLOCKS} consecutive blocked responses; partial coverage saved in ${out}`);
    return 3;
  }
  return failed ? 1 : 0;
}

async function main() {
  assertNodeVersion();
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`css-coverage: ${error.message}\nRun with --help for usage.`);
    process.exit(2);
  }
  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }
  try {
    process.exit(await cover(options));
  } catch (error) {
    console.error(`css-coverage: environment error: ${error.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
