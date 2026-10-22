// A full-page screenshot wider than its viewport: the document scrolls sideways. The width is
// read from the PNG header in review/new/ (scale from heightPx / scrollHeight), or from a
// scrollWidth the manifest entry carries.
import { defineCheck } from '../lib/item.mjs';
import { pathForName } from '../lib/pages.mjs';

const TOLERANCE_PX = 2;
const pngWidth = (buffer) => (buffer && buffer.length >= 24 ? buffer.readUInt32BE(16) : null);

export default defineCheck({
  id: 'mobile-overflow',
  title: 'Pages wider than the screen',
  category: 'design',
  why: 'Find the element wider than the viewport (a fixed width, a long word or an unscaled embed) and let it shrink.',
  effort: 'M',
  risk: 'low',
  applyable: false,
  notCovered: (ctx) => (ctx.manifest.length ? null : 'no review/new/manifest.json (run visual-review shoot.mjs, pass --review)'),
  find(ctx) {
    const found = [];
    for (const entry of ctx.manifest) {
      if (!entry.file || !entry.width) continue;
      let documentWidth = typeof entry.scrollWidth === 'number' ? entry.scrollWidth : null;
      if (documentWidth === null) {
        const px = pngWidth(ctx.readReviewPng(entry.file));
        if (px === null) continue;
        const scale = entry.heightPx && entry.scrollHeight ? entry.heightPx / entry.scrollHeight : 1;
        documentWidth = Math.round(px / scale);
      }
      if (documentWidth <= entry.width + TOLERANCE_PX) continue;
      found.push({
        path: pathForName(ctx, entry.route),
        element: `${entry.width}px`,
        evidence: `${entry.file}: the page is ${documentWidth} px wide at a ${entry.width} px viewport`,
      });
    }
    return found;
  },
});
