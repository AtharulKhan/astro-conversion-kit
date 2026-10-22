// An orphan is an indexable page no crawled page links to (links.json). A page that is in no
// sitemap and hangs off a single link is reported too: one edit to that page orphans it.
import { defineCheck } from '../lib/item.mjs';
import { indexablePages, listOf, okPages, plural } from '../lib/pages.mjs';

export default defineCheck({
  id: 'orphan-pages',
  title: 'Pages that are hard to reach',
  category: 'seo',
  why: 'Link the page from the navigation or a related page, and list it in the sitemap, or retire it.',
  effort: 'S',
  risk: 'none',
  applyable: false,
  find(ctx) {
    const live = new Set(okPages(ctx).map((r) => r.path));
    const siteHasSitemap = ctx.inventory.some((r) => (r.foundBy ?? []).includes('sitemap'));
    const found = [];
    for (const r of indexablePages(ctx)) {
      if (r.path === '/') continue;
      const inbound = (ctx.links?.internal?.[r.path] ?? []).filter((s) => s !== r.path && live.has(s));
      const by = (r.foundBy ?? []).join(', ') || 'unknown';
      if (inbound.length === 0) {
        found.push({ path: r.path, evidence: `no crawled page links here; found by ${by}`, risk: 'none' });
      } else if (siteHasSitemap && !(r.foundBy ?? []).includes('sitemap') && inbound.length === 1) {
        found.push({
          path: r.path,
          evidence: `not in any sitemap and linked from ${plural(inbound.length, 'page')}: ${listOf(inbound)}; found by ${by}`,
          why: 'Add the page to the sitemap and link it from a second place; one edit to the linking page would orphan it.',
        });
      }
    }
    return found;
  },
});
