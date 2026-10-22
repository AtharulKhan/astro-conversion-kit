import { defineCheck } from '../lib/item.mjs';
import { okPages } from '../lib/pages.mjs';

export default defineCheck({
  id: 'multiple-h1',
  title: 'Pages with more than one h1',
  category: 'seo',
  why: 'Keep one h1 for the page topic and make the others h2.',
  effort: 'S',
  risk: 'low',
  applyable: false,
  find: (ctx) =>
    okPages(ctx)
      .filter((r) => (r.h1 ?? []).length > 1)
      .map((r) => ({ path: r.path, element: 'h1', evidence: `${r.h1.length} h1s: ${r.h1.map((h) => `"${h}"`).join(', ')}` })),
});
