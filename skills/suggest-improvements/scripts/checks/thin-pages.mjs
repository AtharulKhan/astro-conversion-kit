import { defineCheck } from '../lib/item.mjs';
import { indexablePages, routeOf, templateOf } from '../lib/pages.mjs';

const MIN_WORDS = 150;
const NOT_CONTENT = new Set(['archive', 'feed', 'file']);

export default defineCheck({
  id: 'thin-pages',
  title: `Indexable pages under ${MIN_WORDS} words`,
  category: 'content',
  why: 'Add the content a visitor came for, merge the page into a stronger one, or mark it noindex.',
  effort: 'M',
  risk: 'none',
  applyable: false,
  find: (ctx) =>
    indexablePages(ctx)
      .filter((r) => !NOT_CONTENT.has(routeOf(ctx, r.path)?.kind) && templateOf(ctx, r.path) !== 'archive')
      .filter((r) => typeof r.wordCount === 'number' && r.wordCount < MIN_WORDS)
      .map((r) => ({ path: r.path, evidence: `${r.wordCount} words of visible text` })),
});
