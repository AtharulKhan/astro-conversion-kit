// Internal links (links.json) and sitemap entries that lead to a page answering 4xx or 5xx,
// plus any links.json `broken` list a capture provides ([{ to|path, status, from[] }]).
import { defineCheck } from '../lib/item.mjs';
import { listOf, okPages, plural } from '../lib/pages.mjs';

export default defineCheck({
  id: 'broken-links',
  title: 'Links and sitemap entries that lead to an error',
  category: 'links',
  why: 'Point the link at a live page, or redirect the dead URL to its closest replacement.',
  effort: 'S',
  risk: 'low',
  applyable: false,
  find(ctx) {
    const status = new Map(ctx.baseline.routes.map((r) => [r.path, r.status]));
    for (const r of ctx.inventory) status.set(r.path, r.status);
    const live = new Set(okPages(ctx).map((r) => r.path));
    const found = new Map();
    const note = (path, text) => found.set(path, [...(found.get(path) ?? []), text]);

    for (const [target, sources] of Object.entries(ctx.links?.internal ?? {})) {
      const code = status.get(target);
      const from = sources.filter((s) => live.has(s));
      if (code >= 400 && from.length) note(target, `answers ${code}; linked from ${plural(from.length, 'page')}: ${listOf(from)}`);
    }
    for (const b of Array.isArray(ctx.links?.broken) ? ctx.links.broken : []) {
      const target = b.to ?? b.path ?? b.url;
      if (!target || found.has(target)) continue;
      const from = b.from ?? b.sources ?? [];
      note(target, `answers ${b.status ?? 'an error'}${from.length ? `; linked from ${listOf(from)}` : ''}`);
    }
    for (const r of ctx.inventory) {
      if (r.status >= 400 && (r.foundBy ?? []).includes('sitemap')) note(r.path, `answers ${r.status}; listed in the sitemap`);
    }
    return [...found].map(([path, notes]) => ({ path, evidence: notes.join('; ') }));
  },
});
