// http:// images, scripts, styles and iframes on https pages, one item per resource across
// every page that loads it.
import { defineCheck } from '../lib/item.mjs';
import { acrossPages, okPages } from '../lib/pages.mjs';

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
  find(ctx) {
    const hits = [];
    for (const r of okPages(ctx)) {
      if (!(r.url ?? r.finalUrl ?? '').startsWith('https://')) continue;
      for (const url of resources(r).filter((u) => u.startsWith('http://'))) {
        hits.push({ key: url, page: r.path, element: url, detail: `loaded over http: ${url}` });
      }
    }
    return acrossPages(hits);
  },
});
