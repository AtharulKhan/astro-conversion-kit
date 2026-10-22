// An <img> with no alt attribute at all, one item per image across every page that shows it.
// alt="" is a deliberate "decorative" and is left alone.
import { defineCheck } from '../lib/item.mjs';
import { acrossPages, okPages, sitePath } from '../lib/pages.mjs';

export default defineCheck({
  id: 'missing-alt',
  title: 'Images without alt text',
  category: 'accessibility',
  why: 'Describe the image in its alt attribute, or set alt="" if it is decoration; screen readers read the file name otherwise.',
  effort: 'S',
  risk: 'none',
  applyable: false,
  find(ctx) {
    const hits = [];
    for (const r of okPages(ctx)) {
      for (const img of r.images ?? []) {
        if (img.alt !== null && img.alt !== undefined) continue;
        const src = sitePath(img.src, ctx.meta?.origin);
        const size = img.width && img.height ? ` (${img.width}×${img.height})` : '';
        hits.push({ key: src, page: r.path, element: `img[src="${src}"]`, detail: `<img> with no alt attribute: ${src}${size}` });
      }
    }
    return acrossPages(hits);
  },
});
