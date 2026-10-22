// Turns the checks' results into suggestions.md (grouped by category, one line per item plus an
// indented evidence line) and the JSON written by --json.
import { CATEGORIES } from './item.mjs';

const LABELS = {
  seo: 'SEO', content: 'Content', links: 'Links', accessibility: 'Accessibility',
  performance: 'Performance', security: 'Security', analytics: 'Analytics', design: 'Design',
};

// [{ gate, checked, failed, failures[] }] -> one header line, or null.
export function gatesLine(gates) {
  if (!Array.isArray(gates) || !gates.length) return null;
  const failing = gates.filter((g) => (g.failed ?? 0) > 0);
  if (!failing.length) return `Gates: all ${gates.length} passing`;
  return `Gates: ${failing.length} of ${gates.length} failing (${failing.map((g) => `${g.gate}: ${g.failed}`).join(', ')})`;
}

// checks: [{ check, items, notCovered }] in run order.
export function buildResult({ checks, ctx, generatedAt }) {
  const order = (c) => CATEGORIES.indexOf(c.check.category);
  const sorted = [...checks].sort((a, b) => order(a) - order(b) || (a.check.id < b.check.id ? -1 : 1));
  const items = sorted.flatMap((c) => [...c.items].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
  const byCategory = {};
  for (const c of sorted) if (c.items.length) byCategory[c.check.category] = (byCategory[c.check.category] ?? 0) + c.items.length;
  return {
    origin: ctx.meta?.origin ?? null,
    capturedAt: ctx.meta?.capturedAt ?? ctx.meta?.finishedAt ?? null,
    generatedAt,
    counts: { total: items.length, byCategory },
    gates: gatesLine(ctx.gates),
    checks: sorted.map((c) => ({ id: c.check.id, title: c.check.title, category: c.check.category, why: c.check.why, count: c.items.length, notCovered: c.notCovered, partial: c.partial ?? null })),
    items,
  };
}

function itemLine(item, checkWhy) {
  const element = item.element ? ` \`${item.element}\`` : '';
  const tags = [`\`${item.id}\``, `effort ${item.effort}`, `risk ${item.risk}`];
  if (item.applyable) tags.push('applyable');
  const why = item.why === checkWhy ? '' : `: ${item.why}`;
  return `- \`${item.path}\`${element}${why} (${tags.join(', ')})\n  - Evidence: ${item.evidence}`;
}

export function renderMarkdown(result) {
  const skipped = result.checks.filter((c) => c.notCovered).length;
  const ran = result.checks.length - skipped;
  const lines = ['# Suggested improvements', ''];
  if (result.origin) lines.push(`Site: ${result.origin}${result.capturedAt ? `, captured ${result.capturedAt}` : ''}. Generated ${result.generatedAt}.`, '');
  const counts = Object.entries(result.counts.byCategory).map(([c, n]) => `${LABELS[c]} ${n}`).join(', ');
  lines.push(`${result.counts.total} suggestions from ${ran} checks run, ${skipped} not covered${counts ? `: ${counts}` : ''}.`);
  if (result.gates) lines.push(result.gates);
  lines.push('');
  lines.push('This report changes nothing. The converted site reproduces every item below on purpose, because the default build equals live; each one is a decision for the site owner.');
  const gaps = result.checks.filter((c) => c.notCovered || c.partial);
  if (gaps.length) {
    lines.push('', 'Not covered (a check, or part of one, had no input or failed; not covered is not a pass):');
    for (const c of gaps) lines.push(c.notCovered ? `- \`${c.id}\`: ${c.notCovered}` : `- \`${c.id}\` (partly): ${c.partial}`);
  }

  for (const category of CATEGORIES) {
    const checks = result.checks.filter((c) => c.category === category && c.count > 0);
    if (!checks.length) continue;
    lines.push('', `## ${LABELS[category]} (${result.counts.byCategory[category]})`);
    for (const c of checks) {
      lines.push('', `### ${c.title} (${c.count})`, '', c.why, '');
      for (const item of result.items.filter((i) => i.id === c.id)) lines.push(itemLine(item, c.why));
    }
  }

  const applyable = [...new Set(result.items.filter((i) => i.applyable).map((i) => i.id))];
  lines.push('', '## How to apply', '');
  lines.push('Nothing here has been applied. Pick the checks to act on, then apply them one check at a time through the `convert-site` skill with `--apply <id>` (for example `convert-site --apply redirect-chains`). Each apply records a proposal in `proposals.json`, makes the change on its own commit on the conversion branch, re-runs the parity gates and the visual contact sheet, and ships only with `PROPOSALS=on` until a person approves it.');
  if (applyable.length) {
    lines.push('', 'Checks in this report that can be applied mechanically:', '');
    for (const id of applyable) lines.push(`- \`--apply ${id}\``);
  }
  lines.push('', 'The other checks need a person to decide or write something (alt text, copy, which page to keep); apply them by hand, as a proposal, the same way.');
  return `${lines.join('\n')}\n`;
}
