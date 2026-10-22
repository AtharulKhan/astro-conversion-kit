// An image over 300 KB, or shown at less than half its natural width. The natural width comes
// from a WordPress size suffix (-2048x1365) or the largest srcset entry for that file; Lighthouse's
// uses-responsive-images and uses-optimized-images add the images they flag.
import { defineCheck } from '../lib/item.mjs';
import { failingAudits, kb, okPages, sitePath } from '../lib/pages.mjs';

const MAX_BYTES = 300 * 1024;

function naturalWidth(img) {
  const suffix = img.src.match(/-(\d+)x(\d+)\.\w+(?:\?.*)?$/);
  if (suffix) return Number(suffix[1]);
  for (const candidate of (img.srcset ?? '').split(',')) {
    const [url, descriptor] = candidate.trim().split(/\s+/);
    if (url === img.src && /^\d+w$/.test(descriptor ?? '')) return Number.parseInt(descriptor, 10);
  }
  return null;
}

export default defineCheck({
  id: 'oversized-images',
  title: 'Images heavier or larger than they are shown',
  category: 'performance',
  why: 'Serve a resized, compressed copy at the size it is shown, with a srcset for larger screens.',
  effort: 'S',
  risk: 'low',
  applyable: true,
  find(ctx) {
    const origin = ctx.meta?.origin;
    const bytes = new Map(ctx.media.map((m) => [m.path, m.bytes]));
    const found = new Map();
    for (const r of okPages(ctx)) {
      for (const img of r.images ?? []) {
        const src = sitePath(img.src, origin);
        const key = `${r.path} ${src}`;
        if (found.has(key)) continue;
        const reasons = [];
        const size = bytes.get(src);
        if (size > MAX_BYTES) reasons.push(kb(size));
        const natural = naturalWidth(img);
        if (natural && img.width && img.width < natural * 0.5) reasons.push(`shown at ${img.width} px of ${natural} px natural width`);
        if (reasons.length) found.set(key, { path: r.path, element: `img[src="${src}"]`, evidence: `${src}: ${reasons.join('; ')}` });
      }
    }
    for (const { path, report } of ctx.lighthouse) {
      for (const audit of failingAudits(report, ['uses-responsive-images', 'uses-optimized-images'])) {
        for (const entry of audit.details?.items ?? []) {
          if (!entry.url) continue;
          const src = sitePath(entry.url, origin);
          const key = `${path} ${src}`;
          if (found.has(key)) continue;
          const saving = entry.wastedBytes ? `, could save ${kb(entry.wastedBytes)}` : '';
          found.set(key, { path, element: `img[src="${src}"]`, evidence: `Lighthouse ${audit.title}: ${src}${saving}` });
        }
      }
    }
    return [...found.values()];
  },
});
