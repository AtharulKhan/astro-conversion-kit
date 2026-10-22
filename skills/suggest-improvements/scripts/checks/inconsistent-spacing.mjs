// The same selector with a different margin, padding or gap on different templates at the same
// width, from visual-review's styles.json (the live values).
import { defineCheck } from '../lib/item.mjs';
import { templateOf } from '../lib/pages.mjs';

const SPACING = /^(margin|padding)(-|$)|(^|-)gap$/;

export default defineCheck({
  id: 'inconsistent-spacing',
  title: 'Spacing that differs between templates',
  category: 'design',
  why: 'Pick one value for the element and use it on every template, ideally from a spacing token.',
  effort: 'M',
  risk: 'medium',
  applyable: false,
  notCovered: (ctx) => (ctx.styles.length ? null : 'no review/styles.json (run visual-review styles.mjs, pass --review)'),
  find(ctx) {
    const groups = new Map();
    for (const row of ctx.styles) {
      if (!SPACING.test(row.property ?? '') || row.live == null || row.live === '') continue;
      const key = `${row.selector}\u0000${row.property}\u0000${row.width}`;
      const group = groups.get(key) ?? { row, byTemplate: new Map() };
      const template = templateOf(ctx, row.path) ?? row.route;
      if (!group.byTemplate.has(template)) group.byTemplate.set(template, { value: String(row.live), path: row.path });
      groups.set(key, group);
    }
    const found = [];
    for (const { row, byTemplate } of groups.values()) {
      const values = new Set([...byTemplate.values()].map((v) => v.value));
      if (byTemplate.size < 2 || values.size < 2) continue;
      const list = [...byTemplate].map(([template, v]) => `${template} ${v.value}`).join(', ');
      found.push({ path: [...byTemplate.values()][0].path, element: `${row.selector} ${row.property}`, evidence: `at ${row.width} px: ${list}` });
    }
    return found;
  },
});
