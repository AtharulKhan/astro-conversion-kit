import { defineCheck } from '../lib/item.mjs';

export default defineCheck({
  id: 'redirect-chains',
  title: 'Redirects that take more than one hop',
  category: 'links',
  why: 'Send the old URL straight to its final page in one redirect; every extra hop costs a round trip and some link value.',
  effort: 'S',
  risk: 'low',
  applyable: true,
  find: (ctx) =>
    ctx.redirects
      .filter((r) => (r.hops ?? []).length > 0 && r.to)
      .map((r) => ({
        path: r.from,
        evidence: `${[r.from, ...r.hops, r.to].join(' → ')} (${r.hops.length + 1} hops, final ${r.status})`,
      })),
});
