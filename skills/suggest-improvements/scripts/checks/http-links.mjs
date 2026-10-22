// Links written as http:// (external links on any page; the canonical and og:url on an https
// site), one item per link across every page that carries it.
import { defineCheck } from '../lib/item.mjs';
import { acrossPages, okPages } from '../lib/pages.mjs';

export default defineCheck({
  id: 'http-links',
  title: 'Links that still use http://',
  category: 'links',
  why: 'Change the link to https:// where the target supports it; the http hop is a redirect at best and insecure at worst.',
  effort: 'S',
  risk: 'low',
  applyable: true,
  find(ctx) {
    const hits = [];
    for (const r of okPages(ctx)) {
      const links = (r.externalLinks ?? []).filter((u) => u.startsWith('http://')).map((u) => [u, 'link']);
      if ((r.url ?? '').startsWith('https://')) {
        if (r.canonical?.startsWith('http://')) links.push([r.canonical, 'canonical']);
        if (r.og?.url?.startsWith('http://')) links.push([r.og.url, 'og:url']);
      }
      for (const [url, kind] of links) hits.push({ key: `${kind} ${url}`, page: r.path, element: url, detail: `${kind} ${url}` });
    }
    return acrossPages(hits);
  },
});
