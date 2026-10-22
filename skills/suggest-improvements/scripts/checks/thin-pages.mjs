// Indexable content pages under 150 words. Pages that are short by design are left out: the
// home page, archives, pages with a form, and thank-you, confirmation, privacy and terms pages.
import { defineCheck } from '../lib/item.mjs';
import { indexablePages, routeOf, templateOf } from '../lib/pages.mjs';

const MIN_WORDS = 150;
const NOT_CONTENT = new Set(['archive', 'feed', 'file']);
const SHORT_BY_DESIGN = /thank-you|thanks|confirmation|privacy|terms/i;

export default defineCheck({
  id: 'thin-pages',
  title: `Indexable pages under ${MIN_WORDS} words`,
  category: 'content',
  why: 'Check whether this page should say more; if it should, add what a visitor came for, or merge it into a stronger page.',
  effort: 'M',
  risk: 'none',
  applyable: false,
  find: (ctx) =>
    indexablePages(ctx)
      .filter((r) => r.path !== '/' && !SHORT_BY_DESIGN.test(r.path) && !(r.forms ?? []).length)
      .filter((r) => !NOT_CONTENT.has(routeOf(ctx, r.path)?.kind) && templateOf(ctx, r.path) !== 'archive')
      .filter((r) => typeof r.wordCount === 'number' && r.wordCount < MIN_WORDS)
      .map((r) => ({ path: r.path, evidence: `${r.wordCount} words of visible text` })),
});
