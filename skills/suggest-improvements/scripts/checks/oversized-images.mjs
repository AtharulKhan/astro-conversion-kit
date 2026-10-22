// An image file over 300 KB (needs media.json), or shown at less than half its natural width
// with no srcset candidate within 1.5× the shown width for the browser to pick instead. The
// natural width comes from a WordPress size suffix (-2048x1365) or the srcset entry for the src
// itself. Lighthouse's uses-responsive-images and uses-optimized-images add the images they flag.
// One item per image across every page that shows it.
import { defineCheck } from '../lib/item.mjs';
import { acrossPages, failingAudits, kb, okPages, sitePath } from '../lib/pages.mjs';

const MAX_BYTES = 300 * 1024;

function candidates(img) {
  return (img.srcset ?? '')
    .split(',')
    .map((c) => c.trim().split(/\s+/))
    .filter(([url, d]) => url && /^\d+w$/.test(d ?? ''))
    .map(([url, d]) => ({ url, w: Number.parseInt(d, 10) }));
}

function naturalWidth(img) {
  const suffix = img.src.match(/-(\d+)x(\d+)\.\w+(?:\?.*)?$/);
  if (suffix) return Number(suffix[1]);
  return candidates(img).find((c) => c.url === img.src)?.w ?? null;
}

function tooWide(img) {
  const natural = naturalWidth(img);
  if (!natural || !img.width || img.width >= natural * 0.5) return null;
  if (candidates(img).some((c) => c.w <= img.width * 1.5)) return null;
  return `shown at ${img.width} px of ${natural} px natural width`;
}

export default defineCheck({
  id: 'oversized-images',
  title: 'Images heavier or larger than they are shown',
  category: 'performance',
  why: 'Serve a resized, compressed copy at the size it is shown, with a srcset for larger screens.',
  effort: 'S',
  risk: 'low',
  applyable: true,
  partial: (ctx) => (ctx.media ? null : 'no media.json in the capture (run media.mjs), so file sizes were not checked'),
  find(ctx) {
    const origin = ctx.meta?.origin;
    const bytes = new Map((ctx.media ?? []).map((m) => [m.path, m.bytes]));
    const hits = [];
    for (const r of okPages(ctx)) {
      for (const img of r.images ?? []) {
        const src = sitePath(img.src, origin);
        const reasons = [];
        if (bytes.get(src) > MAX_BYTES) reasons.push(kb(bytes.get(src)));
        const wide = tooWide(img);
        if (wide) reasons.push(wide);
        if (reasons.length) hits.push({ key: src, page: r.path, element: `img[src="${src}"]`, detail: `${src}: ${reasons.join('; ')}` });
      }
    }
    for (const { path, report } of ctx.lighthouse) {
      for (const audit of failingAudits(report, ['uses-responsive-images', 'uses-optimized-images'])) {
        for (const entry of audit.details?.items ?? []) {
          if (!entry.url) continue;
          const src = sitePath(entry.url, origin);
          const saving = entry.wastedBytes ? `, could save ${kb(entry.wastedBytes)}` : '';
          hits.push({ key: src, page: path, element: `img[src="${src}"]`, detail: `Lighthouse ${audit.title}: ${src}${saving}` });
        }
      }
    }
    return acrossPages(hits);
  },
});
