import { defineCheck } from '../lib/item.mjs';
import { okPages } from '../lib/pages.mjs';

export default defineCheck({
  id: 'missing-h1',
  title: 'Pages without an h1',
  category: 'seo',
  why: 'Give the page one h1 that says what it is about.',
  effort: 'S',
  risk: 'low',
  applyable: false,
  find: (ctx) =>
    okPages(ctx)
      .filter((r) => (r.h1 ?? []).length === 0)
      .map((r) => ({ path: r.path, element: 'h1', evidence: 'no <h1> on the page' })),
});
