// Security headers, from Lighthouse's best-practice audits (has-hsts, csp-xss,
// clickjacking-mitigation, origin-isolation) and from response headers when a capture record
// carries them (record.headers, lower-case names).
import { defineCheck } from '../lib/item.mjs';
import { failingAudits, okPages } from '../lib/pages.mjs';

const AUDITS = ['has-hsts', 'csp-xss', 'clickjacking-mitigation', 'origin-isolation'];

function headerGaps(record) {
  const h = record.headers;
  if (!h || typeof h !== 'object') return [];
  const gaps = [];
  if ((record.url ?? '').startsWith('https://') && !h['strict-transport-security']) gaps.push('strict-transport-security');
  if (!h['content-security-policy']) gaps.push('content-security-policy');
  if (!h['x-content-type-options']) gaps.push('x-content-type-options');
  if (!h['referrer-policy']) gaps.push('referrer-policy');
  if (!h['x-frame-options'] && !/frame-ancestors/.test(h['content-security-policy'] ?? '')) gaps.push('x-frame-options or frame-ancestors');
  return gaps;
}

export default defineCheck({
  id: 'missing-security-headers',
  title: 'Missing security headers',
  category: 'security',
  why: 'Send the headers from the host (_headers or vercel.json); a CSP needs testing against every third-party script first.',
  effort: 'S',
  risk: 'medium',
  applyable: true,
  notCovered: (ctx) =>
    ctx.lighthouse.length || ctx.inventory.some((r) => r.headers) ? null : 'no Lighthouse reports and no captured response headers',
  find(ctx) {
    const found = new Map();
    const add = (path, note) => found.set(path, [...(found.get(path) ?? []), note]);
    for (const r of okPages(ctx)) {
      const gaps = headerGaps(r);
      if (gaps.length) add(r.path, `no ${gaps.join(', ')}`);
    }
    for (const { path, report } of ctx.lighthouse) {
      const failing = failingAudits(report, AUDITS);
      if (failing.length) add(path, `Lighthouse: ${failing.map((a) => a.title ?? a.id).join('; ')}`);
    }
    return [...found].map(([path, notes]) => ({ path, evidence: notes.join('; ') }));
  },
});
