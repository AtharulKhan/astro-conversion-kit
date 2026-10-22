// One vendor reporting to two ids on a page, or the same vendor script loaded twice.
import { defineCheck } from '../lib/item.mjs';
import { okPages } from '../lib/pages.mjs';

export default defineCheck({
  id: 'duplicate-analytics',
  title: 'Analytics loaded twice on a page',
  category: 'analytics',
  why: 'Keep one tag per vendor and id; a second copy double-counts every page view.',
  effort: 'S',
  risk: 'medium',
  applyable: true,
  find(ctx) {
    const found = [];
    for (const r of okPages(ctx)) {
      const byVendor = new Map();
      for (const s of r.scripts ?? []) {
        if (!s.vendor || s.vendor === 'other') continue;
        const v = byVendor.get(s.vendor) ?? { ids: new Set(), srcs: new Map() };
        if (s.id) v.ids.add(s.id);
        if (s.src) v.srcs.set(s.src, (v.srcs.get(s.src) ?? 0) + 1);
        byVendor.set(s.vendor, v);
      }
      for (const [vendor, v] of byVendor) {
        const notes = [];
        if (v.ids.size > 1) notes.push(`${vendor} reports to ${[...v.ids].join(' and ')}`);
        for (const [src, n] of v.srcs) if (n > 1) notes.push(`${src} loaded ${n} times`);
        if (notes.length) found.push({ path: r.path, element: vendor, evidence: notes.join('; ') });
      }
    }
    return found;
  },
});
