// The head fields of one captured page, in baseline/seo.json's shape: { title, description,
// canonical, robots, h1: [text], og: { image, ... } }. Used for the captured 404 page, which is
// not a route, so the baseline holds no seo row for it.
import { parse } from 'parse5';

const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value ?? null;

function textOf(node) {
  if (node.nodeName === '#text') return node.value;
  return (node.childNodes ?? []).map(textOf).join('');
}

export function pageHead(html) {
  const head = { title: null, description: null, canonical: null, robots: null, h1: [], og: {} };
  const walk = (node) => {
    const tag = node.tagName;
    if (tag === 'title' && head.title === null) head.title = textOf(node).trim();
    else if (tag === 'meta') {
      const name = (attr(node, 'name') ?? '').toLowerCase();
      const property = (attr(node, 'property') ?? '').toLowerCase();
      if (name === 'description' && head.description === null) head.description = attr(node, 'content');
      if (name === 'robots' && head.robots === null) head.robots = attr(node, 'content');
      if (property.startsWith('og:')) head.og[property.slice(3)] ??= attr(node, 'content');
    } else if (tag === 'link' && (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical')) {
      head.canonical ??= attr(node, 'href');
    } else if (tag === 'h1') head.h1.push(textOf(node).replace(/\s+/g, ' ').trim());
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(parse(html));
  return head;
}
