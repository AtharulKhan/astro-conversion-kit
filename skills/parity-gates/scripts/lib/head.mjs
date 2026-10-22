// Head and heading fields of a parsed page, shared by the capture and the seo gate so both read
// a page the same way. No side effects on import.
import { attr, byTag, find, findAll, walk } from './html.mjs';
import { normaliseText } from './visible-text.mjs';

// The normalised text of a node, ignoring script and style.
export function textOf(node) {
  const parts = [];
  walk(node, (n) => {
    if (n.nodeName === '#text') parts.push(n.value);
    return n.tagName === 'script' || n.tagName === 'style' ? false : undefined;
  });
  return normaliseText(parts.join(' '));
}

export function relTokens(node) {
  return (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

// Parsed JSON-LD blocks in document order; a block that does not parse is left out.
export function jsonLdBlocks(document) {
  const blocks = [];
  for (const node of findAll(document, (n) => n.tagName === 'script' && (attr(n, 'type') ?? '').toLowerCase() === 'application/ld+json')) {
    const raw = node.childNodes.map((c) => c.value ?? '').join('').trim();
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // A broken block is left out; the snapshot still has it.
    }
  }
  return blocks;
}

// Top-level nodes of every block, flattening arrays and @graph.
export function jsonLdNodes(blocks) {
  const nodes = [];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      nodes.push(value);
      if (value['@graph']) visit(value['@graph']);
    }
  };
  visit(blocks);
  return nodes;
}

// The unique @types of those nodes, in document order.
export function jsonLdTypes(blocks) {
  return [...new Set(jsonLdNodes(blocks).flatMap((n) => [].concat(n['@type'] ?? [])))];
}

// <meta> content by key: og:* in og, twitter:* in twitter, every key (lower-cased) in named.
// The first occurrence of a key wins.
export function metaMaps(document) {
  const og = {};
  const twitter = {};
  const named = {};
  for (const meta of findAll(document, byTag('meta'))) {
    const key = (attr(meta, 'property') ?? attr(meta, 'name') ?? '').trim();
    const content = attr(meta, 'content');
    if (!key || content === null) continue;
    const lower = key.toLowerCase();
    if (lower.startsWith('og:')) og[lower.slice(3)] ??= content;
    else if (lower.startsWith('twitter:')) twitter[lower.slice(8)] ??= content;
    named[lower] ??= content;
  }
  return { og, twitter, named };
}

// Text of every <tag> heading, empty ones left out.
export function headings(document, tag) {
  return findAll(document, byTag(tag)).map(textOf).filter(Boolean);
}

export function titleOf(document) {
  const node = find(document, byTag('title'));
  return node ? textOf(node) : null;
}
