// A known analytics or tag vendor whose snippet loads but carries no measurement id: it costs
// a request and records nothing. Reads baseline/scripts.json, or the inventory's scripts.
import { defineCheck } from '../lib/item.mjs';
import { listOf, plural } from '../lib/pages.mjs';

function vendors(ctx) {
  if (Object.keys(ctx.baseline.scripts ?? {}).length) return ctx.baseline.scripts;
  const out = {};
  for (const r of ctx.inventory) {
    for (const s of r.scripts ?? []) {
      const v = (out[s.vendor] ??= { id: null, ids: [], pages: [] });
      if (s.id && !v.ids.includes(s.id)) v.ids.push(s.id);
      v.id ??= s.id ?? null;
      if (!v.pages.includes(r.path)) v.pages.push(r.path);
    }
  }
  return out;
}

export default defineCheck({
  id: 'dead-analytics',
  title: 'Analytics tags with no measurement id',
  category: 'analytics',
  why: 'Remove the tag, or give it the id it should report to.',
  effort: 'S',
  risk: 'low',
  applyable: true,
  find: (ctx) =>
    Object.entries(vendors(ctx))
      .filter(([vendor, v]) => vendor !== 'other' && !v.id && !(v.ids ?? []).length)
      .map(([vendor, v]) => ({
        path: v.pages?.[0] ?? '/',
        element: vendor,
        evidence: `${vendor} loads on ${plural(v.pages?.length ?? 0, 'page')} (${listOf(v.pages ?? [])}) with no measurement id`,
      })),
});
