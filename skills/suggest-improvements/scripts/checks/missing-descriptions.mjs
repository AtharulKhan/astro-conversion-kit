import { defineCheck } from '../lib/item.mjs';
import { indexablePages } from '../lib/pages.mjs';

export default defineCheck({
  id: 'missing-descriptions',
  title: 'Indexable pages without a meta description',
  category: 'seo',
  why: 'Write a description of 70 to 160 characters; otherwise search engines pick a snippet themselves.',
  effort: 'S',
  risk: 'none',
  applyable: false,
  find: (ctx) =>
    indexablePages(ctx)
      .filter((r) => !(r.description ?? '').trim())
      .map((r) => ({ path: r.path, element: 'meta[name="description"]', evidence: 'no meta description, or an empty one' })),
});
