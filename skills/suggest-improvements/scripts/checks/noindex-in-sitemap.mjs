import { defineCheck } from '../lib/item.mjs';
import { isNoindex } from '../lib/pages.mjs';

export default defineCheck({
  id: 'noindex-in-sitemap',
  title: 'Noindex pages listed in the sitemap',
  category: 'seo',
  why: 'Take the page out of the sitemap, or drop the noindex if it should be found; the two contradict each other.',
  effort: 'S',
  risk: 'low',
  applyable: true,
  find: (ctx) =>
    ctx.inventory
      .filter((r) => isNoindex(r) && (r.foundBy ?? []).includes('sitemap'))
      .map((r) => ({ path: r.path, element: 'meta[name="robots"]', evidence: `robots "${r.robots}" and listed in the sitemap` })),
});
