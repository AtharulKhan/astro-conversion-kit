// Small lookups the checks share over the parsed capture and baseline.

// Every captured HTML page that answered 200.
export const okPages = (ctx) => ctx.inventory.filter((r) => r.status === 200);

export const isNoindex = (record) => /noindex/i.test(record.robots ?? '');

// 200 pages a search engine is allowed to index.
export const indexablePages = (ctx) => okPages(ctx).filter((r) => !isNoindex(r));

export function routeOf(ctx, path) {
  return ctx.baseline.routes.find((r) => r.path === path) ?? null;
}

export function templateOf(ctx, path) {
  const route = routeOf(ctx, path);
  if (route?.template) return route.template;
  return ctx.templates.find((t) => (t.paths ?? []).includes(path))?.name ?? null;
}

// A same-site path for an absolute URL or a path; another origin's URL comes back whole.
export function sitePath(src, origin) {
  if (!src) return src;
  try {
    const url = new URL(src, origin ?? 'http://localhost');
    if (origin && url.origin !== new URL(origin).origin) return url.href;
    return `${url.pathname}${url.search}`;
  } catch {
    return src;
  }
}

// The page path a capture slug or template name stands for (shoot.mjs folders and
// Lighthouse files are named that way).
export function pathForName(ctx, name) {
  const template = ctx.templates.find((t) => t.name === name);
  if (template?.representative) return template.representative;
  const record = ctx.inventory.find((r) => r.snapshot === `pages/${name}.html`);
  return record?.path ?? name;
}

export const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

// "a, b, c and 4 more"
export function listOf(values, max = 3) {
  const shown = values.slice(0, max).join(', ');
  return values.length > max ? `${shown} and ${values.length - max} more` : shown;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// One finding per key (a script URL, an image, a link) instead of one per page: hits are
// [{ key, page, element?, detail }]; the first hit for a key sets its element and detail, and
// the item's path is the first page it was seen on and pages lists them all.
export function acrossPages(hits) {
  const groups = new Map();
  for (const hit of hits) {
    const group = groups.get(hit.key) ?? { element: hit.element, detail: hit.detail, pages: [] };
    if (!group.pages.includes(hit.page)) group.pages.push(hit.page);
    groups.set(hit.key, group);
  }
  return [...groups.values()].map((g) => ({
    path: g.pages[0],
    element: g.element,
    pages: g.pages,
    evidence: `${g.detail}; on ${plural(g.pages.length, 'page')}: ${listOf(g.pages)}`,
  }));
}

// The absolute URL of a src as written on a page, or the src itself when it cannot be resolved.
export function absoluteUrl(src, base) {
  try {
    return new URL(src, base).href;
  } catch {
    return src;
  }
}

// Lighthouse audits in one report that did not pass (a numeric score below 1).
export function failingAudits(report, ids) {
  const audits = report?.audits ?? {};
  return ids.map((id) => audits[id]).filter((a) => a && typeof a.score === 'number' && a.score < 1);
}
