// An <img> with no alt attribute at all. alt="" is a deliberate "decorative" and is left alone.
import { defineCheck } from '../lib/item.mjs';
import { okPages, sitePath } from '../lib/pages.mjs';

export default defineCheck({
  id: 'missing-alt',
  title: 'Images without alt text',
  category: 'accessibility',
  why: 'Describe the image in its alt attribute, or set alt="" if it is decoration; screen readers read the file name otherwise.',
  effort: 'S',
  risk: 'none',
  applyable: false,
  find(ctx) {
    const found = [];
    for (const r of okPages(ctx)) {
      const seen = new Set();
      for (const img of r.images ?? []) {
        if (img.alt !== null && img.alt !== undefined) continue;
        const src = sitePath(img.src, ctx.meta?.origin);
        if (seen.has(src)) continue;
        seen.add(src);
        const size = img.width && img.height ? ` (${img.width}×${img.height})` : '';
        found.push({ path: r.path, element: `img[src="${src}"]`, evidence: `<img> with no alt attribute: ${src}${size}` });
      }
    }
    return found;
  },
});
