// The visible text of a page, normalised so two renderings of the same content compare equal,
// and a word-level diff for failure output. No side effects on import.
import { attr, byTag, find, parseHtml, walk } from './html.mjs';

const NEVER_TEXT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe']);
const CHROME = new Set(['header', 'nav', 'footer', 'aside']);
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i;

function isHidden(node) {
  if (attr(node, 'hidden') !== null) return true;
  if (attr(node, 'aria-hidden') === 'true') return true;
  const style = attr(node, 'style');
  return style !== null && HIDDEN_STYLE.test(style);
}

function contentRoot(document, main) {
  const body = find(document, byTag('body')) ?? document;
  if (!main) return body;
  return (
    find(document, byTag('main')) ??
    find(document, (n) => attr(n, 'role') === 'main') ??
    find(document, (n) => attr(n, 'id') === 'content') ??
    body
  );
}

export function normaliseText(text) {
  return String(text)
    .replace(/ /g, ' ')
    .replace(/­/g, '')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function visibleText(html, { main = true } = {}) {
  const root = contentRoot(parseHtml(html), main);
  const parts = [];
  walk(root, (node) => {
    if (node.nodeName === '#text') {
      parts.push(node.value);
      return undefined;
    }
    if (!node.tagName) return undefined;
    if (NEVER_TEXT.has(node.tagName)) return false;
    if (main && (CHROME.has(node.tagName) || isHidden(node))) return false;
    return undefined;
  });
  return normaliseText(parts.join(' '));
}

const words = (s) => String(s ?? '').split(/\s+/).filter(Boolean);

function push(ops, op, word) {
  const last = ops[ops.length - 1];
  if (last && last.op === op) last.words.push(word);
  else ops.push({ op, words: [word] });
}

// Longest-common-subsequence diff over words. Common prefix and suffix are trimmed first
// so typical page diffs stay small.
export function wordDiff(a, b) {
  const x = words(a);
  const y = words(b);
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start += 1;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX -= 1;
    endY -= 1;
  }
  const ops = [];
  for (let i = 0; i < start; i += 1) push(ops, 'equal', x[i]);

  const xs = x.slice(start, endX);
  const ys = y.slice(start, endY);
  const n = xs.length;
  const m = ys.length;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        xs[i] === ys[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) {
      push(ops, 'equal', xs[i]);
      i += 1;
      j += 1;
    } else if (j >= m || (i < n && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      push(ops, 'delete', xs[i]);
      i += 1;
    } else {
      push(ops, 'insert', ys[j]);
      j += 1;
    }
  }

  for (let k = endX; k < x.length; k += 1) push(ops, 'equal', x[k]);
  return ops.map(({ op, words: w }) => ({ op, text: w.join(' ') }));
}
