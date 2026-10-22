import { defineCheck } from '../lib/item.mjs';
import { kb, plural } from '../lib/pages.mjs';

const LEGACY = new Set(['image/jpeg', 'image/png']);

export default defineCheck({
  id: 'no-webp',
  title: 'JPEG and PNG images with no modern format',
  category: 'performance',
  why: 'Serve a WebP or AVIF copy (a <picture> or the image pipeline) and keep the original as the fallback.',
  effort: 'S',
  risk: 'low',
  applyable: true,
  notCovered: (ctx) => (ctx.media ? null : 'no media.json in the capture (run media.mjs)'),
  find: (ctx) =>
    ctx.media
      .filter((m) => LEGACY.has(m.contentType) && (m.status ?? 200) === 200 && (m.referencedBy ?? []).length > 0)
      .map((m) => ({
        path: m.path,
        evidence: `${m.contentType}, ${kb(m.bytes ?? 0)}, used on ${plural(m.referencedBy.length, 'page')}`,
      })),
});
