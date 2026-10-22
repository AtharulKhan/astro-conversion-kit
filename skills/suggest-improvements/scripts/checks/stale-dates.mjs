import { defineCheck } from '../lib/item.mjs';
import { okPages } from '../lib/pages.mjs';

const YEARS = 3;
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

export default defineCheck({
  id: 'stale-dates',
  title: `Pages not updated in ${YEARS} years`,
  category: 'content',
  why: 'Review the page: update what changed and its modified date, or retire it if it no longer applies.',
  effort: 'M',
  risk: 'none',
  applyable: false,
  find(ctx) {
    const now = ctx.now instanceof Date ? ctx.now : new Date(ctx.now ?? Date.now());
    const found = [];
    for (const r of okPages(ctx)) {
      const stamp = r.modified ?? r.published;
      const when = Date.parse(stamp ?? '');
      if (Number.isNaN(when)) continue;
      const years = (now.getTime() - when) / YEAR_MS;
      if (years <= YEARS) continue;
      const label = r.modified ? 'last modified' : 'published';
      found.push({ path: r.path, evidence: `${label} ${stamp.slice(0, 10)}, ${years.toFixed(1)} years ago` });
    }
    return found;
  },
});
