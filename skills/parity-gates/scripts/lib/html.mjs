// Small parse5 helpers shared by the gates. No side effects on import.
import { parse } from 'parse5';

export function parseHtml(html) {
  return parse(String(html ?? ''));
}

export function isElement(node) {
  return Boolean(node && node.tagName);
}

export function attr(node, name) {
  const found = node?.attrs?.find((a) => a.name === name);
  return found ? found.value : null;
}

export function children(node) {
  if (!node) return [];
  if (node.tagName === 'template' && node.content) return node.content.childNodes ?? [];
  return node.childNodes ?? [];
}

// Depth-first, document order. Return false from visit to skip a node's children.
export function walk(node, visit) {
  if (visit(node) === false) return;
  for (const child of children(node)) walk(child, visit);
}

export function findAll(root, predicate) {
  const found = [];
  walk(root, (node) => {
    if (isElement(node) && predicate(node)) found.push(node);
  });
  return found;
}

export function find(root, predicate) {
  let found = null;
  walk(root, (node) => {
    if (found) return false;
    if (isElement(node) && predicate(node)) {
      found = node;
      return false;
    }
    return undefined;
  });
  return found;
}

export function byTag(name) {
  return (node) => node.tagName === name;
}
