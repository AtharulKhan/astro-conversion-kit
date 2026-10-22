#!/usr/bin/env node
// Template clustering: groups the captured pages that answer 200 into the templates the site
// is built from, so the build can make one layout per template and review one page of each.
// A page's tokens are its body classes, minus the per-page ones, plus the tag names (as a
// multiset) of the first 40 elements under <main> (or <body> when there is no main), with svg,
// script, style and noscript subtrees skipped.
// Tier 1, WordPress (per the fingerprint): the template name from the body classes (home, page,
// single-post, archive, search, error404) plus any page-/post-template class is the key; a page
// splits off only when its Jaccard to the group's main page is below 0.5 (page-2, page-3, ...).
// Tier 2, everything else: exact signatures merge at Jaccard >= 0.6, body classes counted twice.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../../../scripts/lib/node-version.mjs';
import { byTag, find, isElement, parseHtml, walk } from '../../parity-gates/scripts/lib/html.mjs';

const USAGE = `Usage: node templates.mjs --capture <dir>

Cluster the captured pages (status 200) into templates and write <dir>/templates.json:
[{ name, signature, count, representative, paths[] }]. On a WordPress site (per state.json's
fingerprint) pages group by their template body class (home, page, single-post, archive,
search, error404, plus any page-/post-template class); a page whose markup is clearly
different (Jaccard below 0.5) splits off as page-2, page-3, ... Other sites group by markup
(Jaccard at least 0.6, body classes weighted double) as template-<n>. The representative is
the page with the median word count.

  --capture <dir>   the capture folder written by capture.mjs
  --help            show this help

Exit codes: 0 done, 2 usage error or no inventory.json in the capture.`;

export const ELEMENT_LIMIT = 40;
// Tier 1 (WordPress): a page leaves its named group only below this similarity to the group's main page.
export const SPLIT_BELOW = 0.5;
// Tier 2 (anything else): groups merge at or above this similarity.
export const MERGE_AT = 0.6;
// Tier 1 picks a group's main page among at most this many pages, to stay fast on large sites.
const MAIN_CANDIDATES = 200;
// home before page: the home page's body carries both.
const WP_NAMES = ['home', 'error404', 'search', 'single-post', 'archive', 'page'];
// Classes that name one page, post, term, author or listing page rather than a template.
const PER_PAGE = /^(page-id-|postid-|term-|parent-pageid-|category-|tag-|author-|paged-|elementor-page-)|-\d+$/;
const LAYOUT_CLASS = /^(page|post)-template(-|$)/;
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

// Non-positional tokens: each kept body class `classWeight` times, each tag name once per
// occurrence (a multiset: what the markup is made of, not its order).
function tokensOf(classes, tags, classWeight) {
  const tokens = new Set();
  for (const c of classes) for (let k = 1; k <= classWeight; k += 1) tokens.add(`class:${c}#${k}`);
  const seen = {};
  for (const tag of tags) {
    seen[tag] = (seen[tag] ?? 0) + 1;
    tokens.add(`tag:${tag}#${seen[tag]}`);
  }
  return tokens;
}

function signatureOf(page, order) {
  const classes = [...new Set(page.bodyClasses ?? [])].filter((c) => !PER_PAGE.test(c)).sort();
  const tags = tagWindow(page.html);
  return {
    page,
    order,
    text: `${classes.join(' ')} | ${tags.join(' ')}`,
    tokens: tokensOf(classes, tags, 1),
    weighted: tokensOf(classes, tags, 2),
    wpName: WP_NAMES.find((n) => classes.includes(n)) ?? null,
    layout: classes.filter((c) => LAYOUT_CLASS.test(c)).join(' '),
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

// The page most like the others (highest total similarity; ties go to the earliest).
function mainOf(members) {
  const candidates = members.slice(0, MAIN_CANDIDATES);
  let best = candidates[0];
  let bestScore = -1;
  for (const a of candidates) {
    let score = 0;
    for (const b of candidates) if (a !== b) score += jaccard(a.tokens, b.tokens);
    if (score > bestScore) {
      best = a;
      bestScore = score;
    }
  }
  return best;
}

// Tier 1: one group per WordPress name and page/post template class; within it, pages below
// SPLIT_BELOW to the group's main page split off, and the split-offs are grouped the same way.
function tierOne(signatures) {
  const keyed = new Map();
  for (const s of signatures) {
    const key = `${s.wpName}|${s.layout}`;
    keyed.set(key, [...(keyed.get(key) ?? []), s]);
  }
  const groups = [];
  for (const members of keyed.values()) {
    let remaining = members;
    while (remaining.length > 0) {
      const main = mainOf(remaining);
      const near = remaining.filter((s) => s === main || jaccard(main.tokens, s.tokens) >= SPLIT_BELOW);
      groups.push({ wpName: main.wpName, main, members: near });
      remaining = remaining.filter((s) => !near.includes(s));
    }
  }
  return groups;
}

// Tier 2: exact signatures, then merge into the first group whose seed is at least MERGE_AT
// alike, comparing class-weighted tokens so layout classes outweigh content tags.
function tierTwo(signatures) {
  const exact = new Map();
  for (const s of signatures) exact.set(s.text, [...(exact.get(s.text) ?? []), s]);
  const bySize = [...exact.values()].sort((a, b) => b.length - a.length || a[0].order - b[0].order);
  const groups = [];
  for (const members of bySize) {
    const target = groups.find((g) => jaccard(g.main.weighted, members[0].weighted) >= MERGE_AT);
    if (target) target.members.push(...members);
    else groups.push({ wpName: null, main: members[0], members: [...members] });
  }
  return groups;
}

// Bare name for the largest group carrying it, then -2, -3 by first appearance;
// groups with no name are template-1, template-2, ... by size.
function nameGroups(groups) {
  const first = (g) => Math.min(...g.members.map((s) => s.order));
  const bySize = (a, b) => b.members.length - a.members.length || first(a) - first(b);
  const names = new Map();
  for (const wpName of new Set(groups.filter((g) => g.wpName).map((g) => g.wpName))) {
    const same = groups.filter((g) => g.wpName === wpName);
    const bare = [...same].sort(bySize)[0];
    names.set(bare, wpName);
    same.filter((g) => g !== bare).sort((a, b) => first(a) - first(b)).forEach((g, i) => names.set(g, `${wpName}-${i + 2}`));
  }
  groups.filter((g) => !g.wpName).sort(bySize).forEach((g, i) => names.set(g, `template-${i + 1}`));
  return names;
}

// pages: [{ path, wordCount, bodyClasses[], html }] in order of appearance; platform: the
// fingerprint's platform. -> [{ name, signature, count, representative, paths[] }]
export function clusterPages(pages, { platform = null } = {}) {
  const signatures = pages.map((page, i) => signatureOf(page, i));
  if (platform !== 'wordpress') for (const s of signatures) s.wpName = null;
  const groups = [...tierOne(signatures.filter((s) => s.wpName)), ...tierTwo(signatures.filter((s) => !s.wpName))];
  const names = nameGroups(groups);
  return groups
    .map((g) => {
      const name = names.get(g);
      if (!SAFE_NAME.test(name)) throw new Error(`unsafe template name ${name}`);
      const members = g.members.map((s) => s.page);
      const paths = members.map((p) => p.path).sort();
      return { name, signature: g.main.text, count: paths.length, representative: median(members), paths };
    })
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
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
