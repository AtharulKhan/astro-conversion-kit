import { defineCheck } from '../lib/item.mjs';
import { indexablePages } from '../lib/pages.mjs';

const MAX = 60;

export default defineCheck({
  id: 'long-titles',
  title: `Titles longer than ${MAX} characters`,
  category: 'seo',
  why: `Search results cut titles at about ${MAX} characters; put the important words first or shorten it.`,
  effort: 'S',
  risk: 'low',
  applyable: false,
  find: (ctx) =>
    indexablePages(ctx)
      .filter((r) => (r.title ?? '').trim().length > MAX)
      .map((r) => ({ path: r.path, element: 'title', evidence: `${r.title.trim().length} characters: "${r.title.trim()}"` })),
});
