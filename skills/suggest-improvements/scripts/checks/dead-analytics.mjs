// A measurement vendor (analytics, tag manager, pixel, session recording, chat with tracking)
// whose snippet loads but carries no id: it costs a request and records nothing. Embeds the
// extractor also names (YouTube, Vimeo, Maps, reCAPTCHA) have no id to find and are never
// reported. Reads baseline/scripts.json, or the inventory's scripts.
import { defineCheck } from '../lib/item.mjs';
import { listOf, plural } from '../lib/pages.mjs';

export const MEASUREMENT = new Set(['gtm', 'ga4', 'meta-pixel', 'hotjar', 'clarity', 'hubspot', 'intercom', 'crisp', 'tawk']);

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
      .filter(([vendor, v]) => MEASUREMENT.has(vendor) && !v.id && !(v.ids ?? []).length)
      .map(([vendor, v]) => ({
        path: v.pages?.[0] ?? '/',
        element: vendor,
        evidence: `${vendor} loads on ${plural(v.pages?.length ?? 0, 'page')} (${listOf(v.pages ?? [])}) with no measurement id`,
      })),
});
