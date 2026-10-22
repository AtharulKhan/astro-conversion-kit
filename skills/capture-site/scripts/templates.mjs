#!/usr/bin/env node
// Template clustering: groups the captured pages that answer 200 into the templates the site
// is built from, so the build can make one layout per template and review one page of each.
// A page's signature is its body classes, minus the per-page ones, plus the tag sequence of
// the first 40 elements under <main> (or <body> when there is no main), svg, script, style and
// noscript subtrees skipped. Pages are grouped by exact signature, then groups merge when the
// Jaccard similarity of their tokens (the classes, plus the tag names as a multiset) is at least
// 0.8. On a WordPress site (per the fingerprint) a merged group is named after its body classes.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../../../scripts/lib/node-version.mjs';
import { byTag, find, isElement, parseHtml, walk } from '../../parity-gates/scripts/lib/html.mjs';

const USAGE = `Usage: node templates.mjs --capture <dir>

Cluster the captured pages (status 200) into templates and write <dir>/templates.json:
[{ name, signature, count, representative, paths[] }]. Pages group by markup (Jaccard of
body classes and tag names at least 0.8). On a WordPress site (per state.json's fingerprint)
a group is named from its body classes (home, page, single-post, archive, search, error404;
a second group with the same name is page-2), otherwise template-<n>. The representative is
the page with the median word count.

  --capture <dir>   the capture folder written by capture.mjs
  --help            show this help

Exit codes: 0 done, 2 usage error or no inventory.json in the capture.`;

export const ELEMENT_LIMIT = 40;
export const MERGE_AT = 0.8;
// home before page: the home page's body carries both.
const WP_NAMES = ['home', 'error404', 'search', 'single-post', 'archive', 'page'];
// Classes that name one page, post, term, author or listing page rather than a template.
const PER_PAGE = /^(page-id-|postid-|term-|parent-pageid-|category-|tag-|author-|paged-|elementor-page-)|-\d+$/;
// Subtrees that say nothing about the layout: skipped, the element included.
const SKIPPED = new Set(['svg', 'script', 'style', 'noscript']);
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;

function tagWindow(html) {
  const document = parseHtml(html);
  const root = find(document, byTag('main')) ?? find(document, byTag('body')) ?? document;
  const tags = [];
  walk(root, (node) => {
    if (tags.length >= ELEMENT_LIMIT) return false;
    if (node === root || !isElement(node)) return undefined;
    if (SKIPPED.has(node.tagName)) return false;
    tags.push(node.tagName);
    return undefined;
  });
  return tags;
}

// Tokens for Jaccard: each kept body class once, each tag name once per occurrence (a multiset,
// so the order of the markup does not matter, only what it is made of).
function tokensOf(classes, tags) {
  const tokens = new Set(classes.map((c) => `class:${c}`));
  const seen = {};
  for (const tag of tags) {
    seen[tag] = (seen[tag] ?? 0) + 1;
    tokens.add(`tag:${tag}#${seen[tag]}`);
  }
  return tokens;
}

function signatureOf(page, wordpress) {
  const classes = [...new Set(page.bodyClasses ?? [])].filter((c) => !PER_PAGE.test(c)).sort();
  const tags = tagWindow(page.html);
  return {
    text: `${classes.join(' ')} | ${tags.join(' ')}`,
    tokens: tokensOf(classes, tags),
    wpName: wordpress ? (WP_NAMES.find((n) => classes.includes(n)) ?? null) : null,
  };
}

export function jaccard(a, b) {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 1 : shared / union;
}

function median(pages) {
  const sorted = [...pages].sort((a, b) => (a.wordCount ?? 0) - (b.wordCount ?? 0) || (a.path < b.path ? -1 : 1));
  return sorted[Math.floor((sorted.length - 1) / 2)].path;
}

// The WordPress name most of a group's pages carry (ties go to the earlier name in WP_NAMES).
function groupName(members) {
  const votes = {};
  for (const m of members) if (m.signature.wpName) votes[m.signature.wpName] = (votes[m.signature.wpName] ?? 0) + m.pages.length;
  return WP_NAMES.filter((n) => votes[n]).sort((a, b) => votes[b] - votes[a])[0] ?? null;
}

// pages: [{ path, wordCount, bodyClasses[], html }], platform: the fingerprint's platform.
// -> [{ name, signature, count, representative, paths[] }]
// Groups merge on markup alone; a WordPress body class only names the result.
export function clusterPages(pages, { platform = null } = {}) {
  const wordpress = platform === 'wordpress';
  const exact = new Map();
  for (const page of pages) {
    const signature = signatureOf(page, wordpress);
    const group = exact.get(signature.text) ?? { signature, pages: [] };
    group.pages.push(page);
    exact.set(signature.text, group);
  }

  // Largest exact group first: it seeds a merged group and is compared with every later one.
  const order = (a, b) => b.pages.length - a.pages.length || (a.signature.text < b.signature.text ? -1 : 1);
  const merged = [];
  for (const group of [...exact.values()].sort(order)) {
    const target = merged.find((m) => jaccard(m.members[0].signature.tokens, group.signature.tokens) >= MERGE_AT);
    if (target) target.members.push(group);
    else merged.push({ members: [group] });
  }

  const results = merged.map((m) => ({
    seed: m.members[0].signature.text,
    wpName: groupName(m.members),
    pages: m.members.flatMap((g) => g.pages),
  }));
  results.sort((a, b) => b.pages.length - a.pages.length || (a.seed < b.seed ? -1 : 1));
  const used = new Set();
  let unnamed = 0;
  return results.map((g) => {
    let name = g.wpName;
    if (name === null) {
      unnamed += 1;
      name = `template-${unnamed}`;
    }
    for (let n = 2; used.has(name); n += 1) name = `${g.wpName}-${n}`;
    if (!SAFE_NAME.test(name)) throw new Error(`unsafe template name ${name}`);
    used.add(name);
    const paths = g.pages.map((p) => p.path).sort();
    return { name, signature: g.seed, count: paths.length, representative: median(g.pages), paths };
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
  const stateFile = join(dir, 'state.json');
  const platform = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')).fingerprint?.platform ?? null) : null;
  const templates = clusterPages(pages, { platform });
  writeFileSync(join(dir, 'templates.json'), `${JSON.stringify(templates, null, 2)}\n`);
  const summary = templates.map((t) => `${t.name} ${t.count}`).join(', ');
  console.log(`${templates.length} templates from ${pages.length} pages: ${summary}. Wrote ${join(dir, 'templates.json')}.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
