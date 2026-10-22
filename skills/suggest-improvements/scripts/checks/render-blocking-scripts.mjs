// External scripts in the captured <head> with neither async nor defer (and not a module), plus
// the scripts Lighthouse's render-blocking-resources audit names. One item per script, keyed by
// its absolute URL, across every page that loads it.
import { parse } from 'parse5';
import { defineCheck } from '../lib/item.mjs';
import { absoluteUrl, acrossPages, failingAudits, okPages, sitePath } from '../lib/pages.mjs';

const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value ?? null;
const hasAttr = (node, name) => Boolean(node.attrs?.some((a) => a.name === name));
const NON_JS = /^(application\/(ld\+)?json|text\/template|text\/html|module)$/i;

function headScripts(html) {
  const document = parse(html);
  const htmlNode = document.childNodes.find((n) => n.tagName === 'html');
  const head = htmlNode?.childNodes.find((n) => n.tagName === 'head');
  const found = [];
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.tagName === 'script') {
        const src = attr(child, 'src');
        const type = attr(child, 'type') ?? '';
        if (src && !hasAttr(child, 'async') && !hasAttr(child, 'defer') && !NON_JS.test(type)) found.push(src);
      } else walk(child);
    }
  };
  if (head) walk(head);
  return found;
}

export default defineCheck({
  id: 'render-blocking-scripts',
  title: 'Scripts that block the first paint',
  category: 'performance',
  why: 'Add defer (or async for independent scripts), or move the script to the end of the body.',
  effort: 'S',
  risk: 'medium',
  applyable: true,
  find(ctx) {
    const origin = ctx.meta?.origin;
    const hits = [];
    for (const r of okPages(ctx)) {
      const html = ctx.readSnapshot(r.snapshot);
      if (!html) continue;
      const base = r.finalUrl ?? r.url ?? (origin ? new URL(r.path, origin).href : undefined);
      for (const src of headScripts(html)) {
        const url = absoluteUrl(src, base);
        hits.push({ key: url, page: r.path, element: `script[src="${src}"]`, detail: `${sitePath(url, origin)} in <head> without async or defer` });
      }
    }
    for (const { path, report } of ctx.lighthouse) {
      for (const audit of failingAudits(report, ['render-blocking-resources'])) {
        for (const entry of audit.details?.items ?? []) {
          if (!/\.m?js(\?|$)/.test(entry.url ?? '')) continue;
          const ms = entry.wastedMs ? ` (about ${Math.round(entry.wastedMs)} ms)` : '';
          hits.push({ key: entry.url, page: path, element: `script[src="${entry.url}"]`, detail: `Lighthouse ${audit.title}: ${sitePath(entry.url, origin)}${ms}` });
        }
      }
    }
    return acrossPages(hits);
  },
});
