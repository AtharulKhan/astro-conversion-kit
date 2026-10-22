import { defineCheck } from '../lib/item.mjs';
import { listOf, okPages, plural } from '../lib/pages.mjs';

const srcsetUrls = (srcset) => (srcset ?? '').split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);

function resources(record) {
  const urls = [];
  for (const img of record.images ?? []) urls.push(img.src, ...srcsetUrls(img.srcset));
  for (const s of record.scripts ?? []) urls.push(s.src);
  for (const s of record.styles ?? []) urls.push(s.href);
  for (const f of record.iframes ?? []) urls.push(typeof f === 'string' ? f : f?.src);
  return urls.filter((u) => typeof u === 'string');
}

export default defineCheck({
  id: 'mixed-content',
  title: 'HTTPS pages loading HTTP resources',
  category: 'security',
  why: 'Load the resource over HTTPS; browsers block or warn on insecure resources on a secure page.',
  effort: 'S',
  risk: 'medium',
  applyable: true,
  find: (ctx) =>
    okPages(ctx)
      .filter((r) => (r.url ?? r.finalUrl ?? '').startsWith('https://'))
      .map((r) => ({ r, insecure: [...new Set(resources(r).filter((u) => u.startsWith('http://')))] }))
      .filter(({ insecure }) => insecure.length)
      .map(({ r, insecure }) => ({ path: r.path, element: insecure[0], evidence: `${plural(insecure.length, 'resource')} over http: ${listOf(insecure)}` })),
});
