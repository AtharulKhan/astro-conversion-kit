// The item shape every check returns, and the wrapper that fills each item from its check's
// defaults: { id, path, element?, evidence, why, effort: S|M|L, risk: none|low|medium|high,
// applyable, pages? }; pages lists every page an item grouped across pages applies to. A check lists what it found with find(ctx); run(ctx) returns finished items.
export const CATEGORIES = ['seo', 'content', 'links', 'accessibility', 'performance', 'security', 'analytics', 'design'];
export const EFFORTS = ['S', 'M', 'L'];
export const RISKS = ['none', 'low', 'medium', 'high'];
const KEYS = ['id', 'path', 'element', 'evidence', 'why', 'effort', 'risk', 'applyable', 'pages'];

export function defineCheck(spec) {
  const { find, ...rest } = spec;
  return {
    ...rest,
    run(ctx) {
      return find(ctx).map((found) => {
        const item = { id: spec.id, path: found.path };
        if (found.element != null) item.element = String(found.element);
        item.evidence = found.evidence;
        item.why = found.why ?? spec.why;
        item.effort = found.effort ?? spec.effort;
        item.risk = found.risk ?? spec.risk;
        item.applyable = found.applyable ?? spec.applyable;
        if (found.pages) item.pages = [...found.pages];
        return item;
      });
    },
  };
}

// Problems with one item, as strings; an empty list means it has the shape.
export function itemProblems(item) {
  const problems = [];
  for (const key of Object.keys(item)) if (!KEYS.includes(key)) problems.push(`unknown key ${key}`);
  for (const key of ['id', 'path', 'evidence', 'why']) {
    if (typeof item[key] !== 'string' || item[key] === '') problems.push(`${key} must be a non-empty string`);
  }
  if ('element' in item && typeof item.element !== 'string') problems.push('element must be a string');
  if (!EFFORTS.includes(item.effort)) problems.push(`effort must be one of ${EFFORTS.join(', ')}`);
  if (!RISKS.includes(item.risk)) problems.push(`risk must be one of ${RISKS.join(', ')}`);
  if (typeof item.applyable !== 'boolean') problems.push('applyable must be a boolean');
  if ('pages' in item && !(Array.isArray(item.pages) && item.pages.length && item.pages.every((p) => typeof p === 'string'))) {
    problems.push('pages must be a non-empty list of paths');
  }
  return problems;
}
