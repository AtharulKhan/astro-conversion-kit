#!/usr/bin/env node
// Template clustering: groups the captured pages that answer 200 into the templates the site
// is built from, so the build can make one layout per template and review one page of each.
// A page's signature is its body classes, minus the per-page ones, plus the tag sequence of
// the first 40 elements under <main> (or <body> when there is no main). Pages are grouped by
// exact signature, then groups merge when their signatures' Jaccard similarity is at least 0.8.
// Groups named after the same WordPress template (and the same page or post template class)
// become one.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../../../scripts/lib/node-version.mjs';
import { byTag, find, isElement, parseHtml, walk } from '../../parity-gates/scripts/lib/html.mjs';

const USAGE = `Usage: node templates.mjs --capture <dir>

Cluster the captured pages (status 200) into templates and write <dir>/templates.json:
[{ name, signature, count, representative, paths[] }]. The name comes from the WordPress
body classes (home, page, single-post, archive, search, error404) or is template-<n>; the
representative is the page with the median word count.

  --capture <dir>   the capture folder written by capture.mjs
  --help            show this help

Exit codes: 0 done, 2 usage error or no inventory.json in the capture.`;

export const ELEMENT_LIMIT = 40;
export const MERGE_AT = 0.8;
// home before page: the home page's body carries both.
const WP_NAMES = ['home', 'error404', 'search', 'single-post', 'archive', 'page'];
const PER_PAGE = /^(page-id-|postid-|term-)/;
const LAYOUT_CLASS = /^(page|post)-template(-|$)/;
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;

function tagSequence(html) {
  const document = parseHtml(html);
  const root = find(document, byTag('main')) ?? find(document, byTag('body')) ?? document;
  const tags = [];
  walk(root, (node) => {
    if (tags.length >= ELEMENT_LIMIT) return false;
    if (node !== root && isElement(node)) tags.push(node.tagName);
    return undefined;
  });
  return tags;
}

function signatureOf(page) {
  const classes = [...new Set(page.bodyClasses ?? [])].filter((c) => !PER_PAGE.test(c)).sort();
  const tags = tagSequence(page.html);
  return {
    classes,
    tags,
    text: `${classes.join(' ')} | ${tags.join(' ')}`,
    tokens: new Set([...classes.map((c) => `class:${c}`), ...tags.map((t, i) => `${i}:${t}`)]),
    wpName: WP_NAMES.find((n) => classes.includes(n)) ?? null,
    layout: classes.filter((c) => LAYOUT_CLASS.test(c)).join(' '),
  };
}

function jaccard(a, b) {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 1 : shared / union;
}

// Pages carrying different WordPress templates never merge, however alike their markup.
const compatible = (a, b) => a.wpName === b.wpName && (a.wpName === null || a.layout === b.layout);

function median(pages) {
  const sorted = [...pages].sort((a, b) => (a.wordCount ?? 0) - (b.wordCount ?? 0) || (a.path < b.path ? -1 : 1));
  return sorted[Math.floor((sorted.length - 1) / 2)].path;
}

// pages: [{ path, wordCount, bodyClasses[], html }] -> [{ name, signature, count, representative, paths[] }]
export function clusterPages(pages) {
  const exact = new Map();
  for (const page of pages) {
    const signature = signatureOf(page);
    const group = exact.get(signature.text) ?? { signature, pages: [] };
    group.pages.push(page);
    exact.set(signature.text, group);
  }

  // Largest exact group first, so each merged group is described by its most common signature.
  const groups = [];
  const bySize = [...exact.values()].sort((a, b) => b.pages.length - a.pages.length || (a.signature.text < b.signature.text ? -1 : 1));
  for (const group of bySize) {
    const target = groups.find(
      (g) =>
        compatible(g.signature, group.signature) &&
        (g.signature.wpName !== null || jaccard(g.signature.tokens, group.signature.tokens) >= MERGE_AT),
    );
    if (target) target.pages.push(...group.pages);
    else groups.push({ signature: group.signature, pages: [...group.pages] });
  }

  groups.sort((a, b) => b.pages.length - a.pages.length || (a.signature.text < b.signature.text ? -1 : 1));
  const used = new Set();
  let unnamed = 0;
  return groups.map((g) => {
    let name = g.signature.wpName;
    if (name === null) {
      unnamed += 1;
      name = `template-${unnamed}`;
    }
    for (let n = 2; used.has(name); n += 1) name = `${g.signature.wpName}-${n}`;
    if (!SAFE_NAME.test(name)) throw new Error(`unsafe template name ${name}`);
    used.add(name);
    const paths = g.pages.map((p) => p.path).sort();
    return { name, signature: g.signature.text, count: paths.length, representative: median(g.pages), paths };
  });
}

function parseArgs(argv) {
  const args = { capture: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--capture' && argv[i + 1] && !argv[i + 1].startsWith('--')) args.capture = argv[(i += 1)];
    else return { error: `unknown or incomplete option ${argv[i]}` };
  }
  if (!args.help && !args.capture) return { error: '--capture <dir> is required' };
  return args;
}

function main() {
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
  const pages = inventory
    .filter((r) => r.status === 200 && r.snapshot && existsSync(join(dir, r.snapshot)))
    .map((r) => ({ path: r.path, wordCount: r.wordCount, bodyClasses: r.bodyClasses, html: readFileSync(join(dir, r.snapshot), 'utf8') }));
  const templates = clusterPages(pages);
  writeFileSync(join(dir, 'templates.json'), `${JSON.stringify(templates, null, 2)}\n`);
  const summary = templates.map((t) => `${t.name} ${t.count}`).join(', ');
  console.log(`${templates.length} templates from ${pages.length} pages: ${summary}. Wrote ${join(dir, 'templates.json')}.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
