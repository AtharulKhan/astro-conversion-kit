import { defineCheck } from '../lib/item.mjs';
import { indexablePages, listOf } from '../lib/pages.mjs';

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
    return [...byTitle].flatMap(([title, paths]) =>
      paths.length < 2
        ? []
        : paths.map((path) => ({
            path,
            element: 'title',
            evidence: `"${title}" is also the title of ${listOf(paths.filter((p) => p !== path))}`,
          })),
    );
  },
});
