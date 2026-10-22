// Links written as http:// (external links on any page; the canonical and og:url on an https site).
import { defineCheck } from '../lib/item.mjs';
import { listOf, okPages, plural } from '../lib/pages.mjs';

export default defineCheck({
  id: 'http-links',
  title: 'Links that still use http://',
  category: 'links',
  why: 'Change the link to https:// where the target supports it; the http hop is a redirect at best and insecure at worst.',
  effort: 'S',
  risk: 'low',
  applyable: true,
  find(ctx) {
    const found = [];
    for (const r of okPages(ctx)) {
      const links = (r.externalLinks ?? []).filter((u) => u.startsWith('http://'));
      if ((r.url ?? '').startsWith('https://')) {
        for (const u of [r.canonical, r.og?.url]) if (typeof u === 'string' && u.startsWith('http://')) links.push(u);
      }
      const unique = [...new Set(links)];
      if (unique.length) found.push({ path: r.path, element: unique[0], evidence: `${plural(unique.length, 'link')}: ${listOf(unique)}` });
    }
    return found;
  },
});
