// Template and placeholder text left on a published page.
import { defineCheck } from '../lib/item.mjs';
import { listOf, okPages } from '../lib/pages.mjs';

const PATTERNS = [
  /lorem ipsum/i,
  /\bhello world!/i,
  /\bsample page\b/i,
  /just another wordpress site/i,
  /\b(TODO|TBD|FIXME|XXX)\b/,
  /\{\{\s*[\w.-]+\s*\}\}/,
  /\[(insert|your|add) [^\]]{1,40}\]/i,
];

function snippet(text, index, length) {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + length + 20);
  return `"${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}"`;
}

export default defineCheck({
  id: 'placeholder-text',
  title: 'Placeholder text on published pages',
  category: 'content',
  why: 'Replace the placeholder with the real copy, or remove it.',
  effort: 'S',
  risk: 'none',
  applyable: false,
  find(ctx) {
    const found = [];
    for (const r of okPages(ctx)) {
      const hits = [];
      for (const [field, text] of [['title', r.title ?? ''], ['text', r.text ?? '']]) {
        for (const pattern of PATTERNS) {
          const match = text.match(pattern);
          if (match) hits.push(`${field} ${snippet(text, match.index, match[0].length)}`);
        }
      }
      if (hits.length) found.push({ path: r.path, evidence: listOf(hits) });
    }
    return found;
  },
});
