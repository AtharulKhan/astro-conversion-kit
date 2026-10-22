// Indexable pages sharing a <title>: one item per title, on the first page that uses it.
import { defineCheck } from '../lib/item.mjs';
import { indexablePages, listOf, plural } from '../lib/pages.mjs';

export default defineCheck({
  id: 'duplicate-titles',
  title: 'Indexable pages sharing a title',
  category: 'seo',
  why: 'Give each indexable page its own title so search results can tell them apart.',
  effort: 'S',
  risk: 'low',
  applyable: false,
  find(ctx) {
    const byTitle = new Map();
    for (const r of indexablePages(ctx)) {
      const title = (r.title ?? '').trim();
      if (!title) continue;
      byTitle.set(title, [...(byTitle.get(title) ?? []), r.path]);
    }
    return [...byTitle]
      .filter(([, paths]) => paths.length > 1)
      .map(([title, paths]) => ({
        path: paths[0],
        element: 'title',
        evidence: `"${title}" on ${plural(paths.length, 'page')}: ${listOf(paths)}`,
      }));
  },
});
