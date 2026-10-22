#!/usr/bin/env node
// Reconcile a failing pre-launch gate with the live site: a failing check is accepted only when
// every row it names reproduces what the baseline recorded for live and docs/plan.md holds the
// decision that kept it, plus the two narrow rules (the kit's form-id placeholder, and the
// predecessor checks that misread the trailing-slash rules). Everything else blocks.
// Pure: reads files only. Exit codes: 0 nothing blocks, 1 something blocks, 2 usage or input error.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';

const HELP = `Usage: node prelaunch-reconcile.mjs --findings <pre-launch bundle>/gate.json
                                  --baseline baseline --plan docs/plan.md [--json]

Reads the pre-launch bundle (gate.json, or findings.json with gate.json beside it) and sorts
every failing check into accepted or blocking.

A check is accepted only when every row it names (path and field: title, description, h1,
canonical, og:image, favicon, placeholder text) equals what baseline/seo.json, baseline/text/,
baseline/routes.json or baseline/media.json recorded for live, and a row of the Decisions table
in --plan names that path or the check id. Two narrow rules need no decision:
  placeholders.form-id            every hit is the kit's placeholder formspree.io/f/REPLACE
                                  (the form id is still on the needs-you list)
  predecessor.wildcard-redirects  every row is one of the kit's trailing-slash rules
  predecessor.redirect-chains     every row is a slash-only loop (/about -> /about)
Any other failing check blocks, a crashed one included, and so does a check whose evidence was
cut at pre-launch's listing cap (the unlisted rows cannot be compared).

  --findings <file>  gate.json or findings.json from pre-launch's --out bundle (required)
  --baseline <dir>   the baseline folder (required)
  --plan <file>      docs/plan.md with its Decisions table (required)
  --json             print { failing, accepted[], blocking[] } instead of lines
  --help             show this help

Exit codes: 0 nothing blocks, 1 a failing check blocks, 2 usage or input error.`;

// parity-gates' SLASH_RULES (build-redirects.mjs), as pre-launch prints them: "<source> -> <destination>".
// Copied, not imported, because this skill is copied on its own; a test keeps the two equal.
export const SLASH_RULE_PAIRS = new Set([
  '/:path((?!\\.well-known(?:/|$))(?:[^/]+/)*[^/.]+) -> /:path/',
  '/:path((?:[^/]+/)*[^/]+\\.\\w+)/ -> /:path',
  '/:path(.+)/ -> /:path',
]);

const FORM_PLACEHOLDER = /^formspree\.io\/f\/REPLACE$/i;

// A url path compared without its trailing slash, as pre-launch compares them.
export function normalizePath(input) {
  let path = String(input ?? '').split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // kept as written
  }
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

// The url path a build file serves: index.html is /, x/index.html is /x, x.html is /x.
function relPath(rel) {
  const r = rel.trim().replace(/^\/+/, '');
  if (r === 'index.html') return '/';
  if (r.endsWith('/index.html')) return normalizePath(r.slice(0, -'/index.html'.length));
  if (r.endsWith('.html')) return normalizePath(r.slice(0, -'.html'.length));
  return normalizePath(r);
}

function pathnameOf(value) {
  try {
    return new URL(value, 'http://x.invalid').pathname;
  } catch {
    return null;
  }
}
const sameUrl = (a, b) => typeof a === 'string' && typeof b === 'string' && (a === b || (pathnameOf(a) !== null && pathnameOf(a) === pathnameOf(b)));
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const empty = (v) => v === null || v === undefined || String(v).trim() === '';
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------------------------- the inputs

export function loadBaseline(dir) {
  const read = (name, fallback) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : fallback);
  if (!existsSync(join(dir, 'seo.json'))) throw new Error(`${join(dir, 'seo.json')} not found`);
  const seo = read('seo.json');
  const routes = read('routes.json', []);
  const media = read('media.json', []);
  const byNormal = new Map(Object.keys(seo).map((p) => [normalizePath(p), p]));
  const snapshots = new Map(routes.filter((r) => r.snapshot).map((r) => [r.path, r.snapshot]));
  const files = new Set([...routes.map((r) => r.path), ...media.map((m) => m.path)]);
  const mediaPaths = new Set(media.map((m) => m.path));
  return {
    // The baseline's own spelling of a build path, or null when live had no such page.
    page(path) {
      return byNormal.get(normalizePath(path)) ?? null;
    },
    seo: (page) => seo[page],
    text(page) {
      const snapshot = snapshots.get(page);
      if (!snapshot) return '';
      const file = join(dir, 'text', snapshot.replace(/^pages\//, '').replace(/\.html$/, '.txt'));
      return existsSync(file) ? readFileSync(file, 'utf8') : '';
    },
    has: (path) => files.has(path),
    anyFile: (pattern) => [...files].some((p) => pattern.test(p)),
    isMedia: (path) => mediaPaths.has(path),
    pagesWithOgImage: (image) => Object.keys(seo).filter((p) => sameUrl(seo[p].og?.image, image)),
  };
}

// [{ id, topic }] from the Decisions table rows (| dN | … |).
export function loadDecisions(planFile) {
  return readFileSync(planFile, 'utf8').split('\n')
    .map((line) => /^\|\s*(d\d+)\s*\|(.*)$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => ({ id: m[1], text: m[2] }));
}

function decisionNaming(decisions, names) {
  const tokens = names.filter(Boolean).map((name) => new RegExp(`(^|[\\s(\`'"])${escape(name)}(?=$|[\\s)\`'",;:.])`));
  return decisions.find((d) => tokens.some((t) => t.test(d.text)))?.id ?? null;
}

// The failing checks, as { id, detail, evidence[] }: gate.json's fail checks, or findings.json's
// blocker findings plus any fail check (a crash) only the gate.json beside it records.
export function loadFailing(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const fromGate = (gate) => gate.checks.filter((c) => c.status === 'fail').map(({ id, detail, evidence }) => ({ id, detail: detail ?? '', evidence: evidence ?? [] }));
  if (data && Array.isArray(data.checks)) return fromGate(data);
  if (!Array.isArray(data)) throw new Error(`${file} is neither pre-launch's gate.json nor its findings.json`);
  const byId = new Map();
  for (const f of data.filter((x) => x.severity === 'blocker')) {
    const entry = byId.get(f.id) ?? { id: f.id, detail: f.detail ?? '', evidence: [] };
    entry.evidence.push(...(f.evidence ?? []));
    byId.set(f.id, entry);
  }
  const sibling = join(dirname(file), 'gate.json');
  if (existsSync(sibling)) {
    for (const check of fromGate(JSON.parse(readFileSync(sibling, 'utf8')))) if (!byId.has(check.id)) byId.set(check.id, check);
  }
  return [...byId.values()];
}

// ------------------------------------------------------------------------------- the rows

// A row on a page: the baseline page it names, or a failing row when live had no such page.
function onPage(base, rel, field, text, compare) {
  const page = base.page(relPath(rel));
  if (page === null) return { text, field, paths: [relPath(rel)], ok: false, reason: `live has no page at ${relPath(rel)}` };
  const reason = compare(base.seo(page), page);
  return { text, field, paths: [page], ok: reason === null, reason };
}

function headRows(field, label) {
  return (base, value) => {
    let m = new RegExp(`^(\\S+) has no ${label}$`).exec(value);
    if (m) return [onPage(base, m[1], field, value, (seo) => (empty(seo[field]) ? null : `live recorded ${field} "${seo[field]}"`))];
    m = new RegExp(`^(.+) share the ${label} "(.*)"$`).exec(value);
    if (m) return m[1].split(', ').map((rel) => onPage(base, rel, field, value, (seo) => (same(seo[field], m[2]) ? null : `live recorded ${field} "${seo[field]}"`)));
    return null;
  };
}

const ROWS = {
  'output.titles': headRows('title', 'title'),
  'output.descriptions': headRows('description', 'meta description'),
  'output.h1': (base, value) => {
    const m = /^(\S+) has (\d+) h1 elements$/.exec(value);
    if (!m) return null;
    return [onPage(base, m[1], 'h1', value, (seo) => ((seo.h1 ?? []).length === Number(m[2]) ? null : `live recorded ${(seo.h1 ?? []).length}`))];
  },
  'output.canonical': (base, value) => {
    const check = (rel, test) => [onPage(base, rel, 'canonical', value, (seo) => (test(seo.canonical) ? null : `live recorded canonical ${seo.canonical ?? 'none'}`))];
    let m = /^(\S+) has no canonical link$/.exec(value);
    if (m) return check(m[1], (c) => empty(c));
    m = /^(\S+) has a relative canonical "(.*)"; /.exec(value) ?? /^(\S+) has a canonical that is not a url: "(.*)"$/.exec(value);
    if (m) return check(m[1], (c) => c === m[2]);
    m = /^(\S+) canonicalises to (\S+), not \S+$/.exec(value);
    if (m) return check(m[1], (c) => { try { return new URL(c).hostname === m[2]; } catch { return false; } });
    m = /^(\S+) serves \S+ but canonicalises to (\S+)$/.exec(value);
    if (m) return check(m[1], (c) => !empty(c) && normalizePath(pathnameOf(c)) === m[2]);
    m = /^(\S+) has \d+ canonical links; /.exec(value);
    if (m) return check(m[1], () => false);
    return null;
  },
  'output.og-image': (base, value, detail) => {
    if (detail.startsWith('none of the')) return [onPage(base, value, 'og:image', value, (seo) => (empty(seo.og?.image) ? null : `live recorded og:image ${seo.og.image}`))];
    let m = /^(\S+) does not exist in the build \(used by (.+)\)$/.exec(value);
    if (m) {
      if (base.isMedia(pathnameOf(m[1]))) return [{ text: value, field: 'og:image', paths: [], ok: false, reason: 'live served this image' }];
      return m[2].split(', ').map((rel) => onPage(base, rel, 'og:image', value, (seo) => (sameUrl(seo.og?.image, m[1]) ? null : `live recorded og:image ${seo.og?.image ?? 'none'}`)));
    }
    m = /^(\S+) is (an SVG|not a recognised image|a \S+ whose dimensions|\d+x\d+)/.exec(value);
    if (m) {
      const pages = base.pagesWithOgImage(m[1]);
      return [{ text: value, field: 'og:image', paths: pages, ok: pages.length > 0, reason: pages.length ? null : 'live used no such og:image' }];
    }
    return null;
  },
  'output.favicon-set': (base, value) => {
    const row = (paths, ok, reason) => [{ text: value, field: 'favicon', paths, ok, reason: ok ? null : reason }];
    let m = /^(\S+) is missing$/.exec(value);
    if (m) return row([`/${m[1]}`], !base.has(`/${m[1]}`), `live served /${m[1]}`);
    if (value.startsWith('neither favicon.svg nor')) return row(['/favicon.svg'], !base.anyFile(/^\/(favicon\.svg|(favicon|icon)-[\w.]*\.png)$/i), 'live served a scalable or sized icon');
    m = /^apple-touch-icon\.png is \d+x\d+/.exec(value);
    if (m) return row(['/apple-touch-icon.png'], base.has('/apple-touch-icon.png'), 'live had no apple-touch-icon.png');
    if (value === 'no page links to a web app manifest') return row([], !base.anyFile(/(\.webmanifest|manifest\.json)$/), 'live served a manifest');
    return null;
  },
};

// placeholders.copy: a page row is live when its baseline text, title or description shows the
// same string; a source row is live when a live page row matched the same string.
function placeholderRows(base, evidence) {
  const rows = evidence.map(({ value }) => {
    const m = /^(.+):(\d+) — (.+)$/.exec(value);
    if (!m) return { text: value, field: 'placeholder text', paths: [], ok: false, reason: 'row not understood' };
    const [, label, , match] = m;
    const rel = label.split('/').slice(1).join('/');
    if (label.endsWith('.html') && base.page(relPath(rel)) !== null) {
      return onPage(base, rel, 'placeholder text', value, (seo, page) => {
        const shown = [base.text(page), seo.title ?? '', seo.description ?? ''].join('\n').toLowerCase();
        return shown.includes(match.toLowerCase()) ? null : `live did not show "${match}"`;
      });
    }
    return { text: value, field: 'placeholder text', match, paths: [], ok: null };
  });
  for (const row of rows.filter((r) => r.ok === null)) {
    const pages = rows.filter((r) => r.ok === true && same(/ — (.+)$/.exec(r.text)?.[1], row.match));
    row.paths = pages.flatMap((r) => r.paths);
    row.ok = pages.length > 0;
    row.reason = row.ok ? null : `no live page shows "${row.match}"`;
    delete row.match;
  }
  return rows;
}

// --------------------------------------------------------------------------- the reconciliation

const listedCount = (detail) => Number((/^(\d+)\b/.exec(detail) ?? /^none of the (\d+)\b/.exec(detail) ?? [])[1] ?? 0);

function narrow(check) {
  const values = check.evidence.map((e) => String(e.value));
  if (values.length === 0) return null;
  if (check.id === 'placeholders.form-id') {
    const ok = values.every((v) => FORM_PLACEHOLDER.test(/ — (.+)$/.exec(v)?.[1] ?? ''));
    return { ok, rule: 'form-id', decision: 'form id (needs you)', rows: values.map((text) => ({ text, ok, reason: ok ? null : 'not the kit placeholder formspree.io/f/REPLACE' })) };
  }
  if (check.id === 'predecessor.wildcard-redirects') {
    const rows = values.map((text) => {
      const ok = SLASH_RULE_PAIRS.has(/^"(.+)" covers /.exec(text)?.[1]);
      return { text, ok, reason: ok ? null : 'not one of the kit trailing-slash rules' };
    });
    return { ok: rows.every((r) => r.ok), rule: 'slash', decision: null, rows };
  }
  if (check.id === 'predecessor.redirect-chains') {
    const rows = values.map((text) => {
      const m = /^(\S+) -> (.+) is a loop and serves nothing$/.exec(text);
      const ok = Boolean(m) && m[2].split(' -> ').every((hop) => hop === m[1]);
      return { text, ok, reason: ok ? null : 'not a slash-only redirect' };
    });
    return { ok: rows.every((r) => r.ok), rule: 'slash', decision: null, rows };
  }
  return undefined;
}

export function reconcile(failing, base, decisions) {
  const accepted = [];
  const blocking = [];
  for (const check of failing) {
    const special = narrow(check);
    if (special !== undefined) {
      if (special?.ok) accepted.push({ id: check.id, rule: special.rule, decision: special.decision, rows: special.rows });
      else blocking.push({ id: check.id, detail: check.detail, rows: special?.rows ?? [] });
      continue;
    }
    const parse = ROWS[check.id];
    let rows;
    if (check.id === 'placeholders.copy') rows = placeholderRows(base, check.evidence);
    else if (parse) {
      rows = check.evidence.flatMap(({ value }) => parse(base, String(value), check.detail)
        ?? [{ text: String(value), paths: [], ok: false, reason: 'row not understood' }]);
    }
    if (!rows || rows.length === 0) {
      blocking.push({ id: check.id, detail: check.detail, rows: [] });
      continue;
    }
    for (const row of rows.filter((r) => r.ok)) {
      row.decision = decisionNaming(decisions, [...row.paths, ...row.paths.map(normalizePath), check.id]);
      if (row.decision === null) {
        row.ok = false;
        row.reason = `no decision row in the plan names ${[...row.paths, check.id].join(' or ')}`;
      }
    }
    const count = listedCount(check.detail);
    if (count > check.evidence.length) {
      rows.push({ text: check.detail, paths: [], ok: false, reason: `only ${check.evidence.length} of ${count} rows listed; the rest cannot be compared with live` });
    }
    if (rows.every((r) => r.ok)) {
      accepted.push({ id: check.id, rule: 'live', decision: [...new Set(rows.map((r) => r.decision))].join(', '), rows });
    } else blocking.push({ id: check.id, detail: check.detail, rows });
  }
  return { failing: failing.length, accepted, blocking };
}

function lines(result) {
  const out = [`prelaunch-reconcile: ${result.failing} failing checks, ${result.accepted.length} accepted, ${result.blocking.length} blocking`];
  for (const a of result.accepted) {
    for (const r of a.rows) {
      if (a.rule === 'slash') out.push(`accepted  ${a.id}: ${r.text} — trailing-slash rule (known launch-skills limitation)`);
      else if (a.rule === 'form-id') out.push(`accepted  ${a.id}: ${r.text} — form id pending (needs you)`);
      else out.push(`accepted  ${a.id}: ${r.paths.join(', ') || r.text} ${r.field} — reproduced from live (${r.decision})`);
    }
  }
  for (const b of result.blocking) {
    const bad = b.rows.filter((r) => !r.ok);
    if (bad.length === 0) out.push(`blocking  ${b.id}: ${b.detail}`);
    for (const r of bad) out.push(`blocking  ${b.id}: ${r.text} — ${r.reason}`);
  }
  return out.join('\n');
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '--json') opts[arg.slice(2)] = true;
    else if (['--findings', '--baseline', '--plan'].includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else throw new Error(`unexpected argument "${arg}"`);
  }
  return opts;
}

function main() {
  assertNodeVersion();
  let opts;
  let result;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(HELP);
      return;
    }
    for (const name of ['findings', 'baseline', 'plan']) if (!opts[name]) throw new Error(`--${name} is required`);
    for (const name of ['findings', 'plan']) if (!existsSync(opts[name])) throw new Error(`${opts[name]} not found`);
    result = reconcile(loadFailing(opts.findings), loadBaseline(opts.baseline), loadDecisions(opts.plan));
  } catch (err) {
    console.error(`prelaunch-reconcile: ${err.message}`);
    console.error('Run with --help for usage.');
    process.exit(2);
  }
  console.log(opts.json ? JSON.stringify(result, null, 2) : lines(result));
  process.exitCode = result.blocking.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
