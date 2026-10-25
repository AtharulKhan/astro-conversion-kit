// Narrow source proofs for non-page-copy findings. Unknown, changed or truncated
// evidence blocks. No network calls and no execution of captured JavaScript.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Script } from 'node:vm';
import { parse } from 'parse5';

export function capturedFile(root, name) {
  if (!root || !name || typeof name !== 'string') return null;
  const base = resolve(root);
  const file = resolve(base, name);
  if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) return null;
  if (!realpathSync(file).startsWith(realpathSync(base) + sep)) return null;
  return readFileSync(file);
}

function complete(check) {
  const count = Number(/^(\d+)\b/.exec(check.detail)?.[1]);
  return count > 0 && count === check.evidence.length;
}
const walk = function* (node) { yield node; for (const child of node.childNodes ?? []) yield* walk(child); };
const row = (text, ok, note) => ({ text, ok, paths: [], reason: ok ? null : note, note: ok ? note : undefined });

function commentRow(text, env, base) {
  const match = /^(public\/.+\.js):(\d+) — (.+)$/.exec(text);
  if (!match) return row(text, false, 'not a JavaScript source comment row');
  const bytes = capturedFile(env.dir, match[1]);
  const original = base.assetBytes?.('/' + match[1].slice('public/'.length));
  if (!bytes || !original || !bytes.equals(original)) return row(text, false, 'source bytes differ from the captured script');
  const source = bytes.toString('utf8');
  const lines = source.split(/\r?\n/);
  // ES5 scripts only: no multiline strings/templates that could make a line
  // beginning // visitor-facing string data rather than a comment.
  const code = lines.filter((line) => !/^\s*\/\//.test(line)).join('\n');
  if (code.includes('`') || /\\\r?\n/.test(source)) return row(text, false, 'multiline string context is not covered');
  try { new Script(source); } catch { return row(text, false, 'script syntax could not be verified without execution'); }
  const line = lines[Number(match[2]) - 1] ?? '';
  const ok = /^\s*\/\//.test(line) && line.includes(match[3]);
  return row(text, ok, ok ? 'non-executable comment in a byte-identical captured vendor script' : 'the reported token is not in a full-line comment');
}

function embedRow(text, env, base) {
  const match = /^(.+\.html):(\d+) — (\.vercel\.app)$/.exec(text);
  if (!match) return row(text, false, 'only exact captured iframe host references are covered');
  const rel = match[1].replaceAll('\\', '/');
  const dist = resolve(env.dist);
  const file = resolve(env.dir, rel);
  if (!file.startsWith(dist + sep)) return row(text, false, 'reported file is outside the build');
  const html = capturedFile(dist, file.slice(dist.length + 1))?.toString('utf8');
  const path = '/' + file.slice(dist.length + 1).replaceAll('\\', '/').replace(/index\.html$/, '');
  const original = base.html?.(path);
  if (!html || !original) return row(text, false, 'page has no captured source snapshot');
  const originalSources = new Set([...walk(parse(original))].filter((n) => n.tagName === 'iframe').flatMap((n) => n.attrs.filter((a) => a.name === 'src').map((a) => a.value)));
  const allowed = [...walk(parse(html, { sourceCodeLocationInfo: true }))].filter((n) => n.tagName === 'iframe').flatMap((n) => {
    const src = n.attrs.find((a) => a.name === 'src')?.value;
    const loc = n.sourceCodeLocation?.attrs?.src;
    if (!src || !loc || !originalSources.has(src)) return [];
    try { if (!new URL(src).hostname.endsWith('.vercel.app')) return []; } catch { return []; }
    return [loc];
  });
  const lineNumber = Number(match[2]);
  const lines = html.split('\n');
  const start = lines.slice(0, lineNumber - 1).reduce((n, line) => n + line.length + 1, 0);
  const line = lines[lineNumber - 1] ?? '';
  const hits = [...line.matchAll(/\.vercel\.app/g)];
  const ok = hits.length > 0 && hits.every((hit) => allowed.some((loc) => start + hit.index >= loc.startOffset && start + hit.index < loc.endOffset));
  return row(text, ok, ok ? 'exact iframe src retained from this page\'s captured markup' : 'a host occurrence is outside an unchanged captured iframe src');
}

function feedRow(text, env, base) {
  const match = /^the redirect (\/\S+\/) -> (\/\S+\/index\.xml) uses the never form against a always policy$/.exec(text);
  if (!match || match[2] !== match[1] + 'index.xml') return row(text, false, 'not a directory-to-feed-file rewrite');
  const built = capturedFile(env.dist, match[2].slice(1));
  const original = base.feedBytes?.(match[1]);
  const rules = capturedFile(env.dist, '_redirects')?.toString('utf8').split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#')).map((line) => line.trim().split(/\s+/)) ?? [];
  const matches = rules.filter((r) => r[0] === match[1]);
  const index = rules.findIndex((r) => r[0] === match[1]);
  const safeOrder = index >= 0 && rules.slice(0, index).every((r) => !/[*:]/.test(r[0]));
  const configured = matches.length === 1 && matches[0].length === 3 && matches[0][1] === match[2] && matches[0][2] === '200' && safeOrder;
  const ok = Boolean(configured && built && original && built.equals(original));
  return row(text, ok, ok ? '200 rewrite serves the byte-identical captured XML feed, not an HTML redirect' : 'missing exact 200 rewrite or captured/build feed bytes differ');
}

export function artifactEvidence(check, env, base, decision) {
  if (!decision) return undefined;
  const values = check.evidence.map((e) => String(e.value));
  let rows;
  if (check.id === 'placeholders.copy' && values.every((v) => /^public\/.+\.js:\d+ — /.test(v))) {
    rows = values.map((v) => commentRow(v, env, base));
  } else if (check.id === 'placeholders.dev-host') rows = values.map((v) => embedRow(v, env, base));
  else if (check.id === 'framework.trailing-slash') {
    if (check.detail.split('; ').join('\n') !== values.join('\n')) return { ok: false, rows: [row(check.detail, false, 'feed evidence is incomplete')] };
    rows = values.map((v) => feedRow(v, env, base));
  } else return undefined;
  if (check.id !== 'framework.trailing-slash' && !complete(check)) rows.push(row(check.detail, false, 'artifact evidence is incomplete or truncated'));
  return { ok: rows.length > 0 && rows.every((r) => r.ok), rule: 'artifact', decision, rows: rows.map((r) => ({ ...r, decision })) };
}
