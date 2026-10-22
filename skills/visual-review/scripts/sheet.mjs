#!/usr/bin/env node
// Contact sheet: one self-contained HTML page with live, new and diff
// screenshots side by side per route and width, plus failing style rows.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertNodeVersion } from '../../../scripts/lib/node-version.mjs';

const HELP = `Usage: node sheet.mjs --live <dir> --new <dir> --diff <diff.json> [--styles styles.json] [--out index.html]

Builds a single self-contained HTML page (images inlined) with, per route, a
row per width showing the live, new and diff screenshots side by side, the
differing-pixel percent, pass or fail, and the failing style rows beneath.

  --live, --new  screenshot folders holding manifest.json and <route>/<width>.png
  --diff         diff.json; diff images are read from the folder it sits in
  --styles       styles.json from styles.mjs (optional)
  --out          output HTML file (default index.html)

Exit codes: 0 sheet written, 2 usage or environment error.`;

class UsageError extends Error {}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read ${label} ${file}: ${err.message}`);
  }
}

const key = (route, width) => `${route}\u0000${width}`;

function indexManifest(dir) {
  const entries = readJson(join(dir, 'manifest.json'), 'manifest');
  if (!Array.isArray(entries)) throw new UsageError(`${join(dir, 'manifest.json')} is not a JSON array`);
  return new Map(entries.map((e) => [key(e.route, e.width), { ...e, path: isAbsolute(e.file) ? e.file : join(dir, e.file) }]));
}

function figure(label, file, extra = '') {
  const caption = `<figcaption>${escapeHtml(label)}${extra ? ` <span class="muted">${escapeHtml(extra)}</span>` : ''}</figcaption>`;
  if (!file || !existsSync(file)) return `<figure class="missing">${caption}<div class="none">no image</div></figure>`;
  const data = readFileSync(file).toString('base64');
  return `<figure>${caption}<div class="frame"><img src="data:image/png;base64,${data}" alt="${escapeHtml(label)}" loading="lazy"></div></figure>`;
}

const verdict = (pass) => (pass ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>');

function styleTable(rows) {
  if (rows.length === 0) return '';
  const body = rows
    .map((r) => `<tr><td>${verdict(false)}</td><td><code>${escapeHtml(r.selector)}</code></td><td>${escapeHtml(r.property)}</td><td>${escapeHtml(r.live)}</td><td>${escapeHtml(r.new)}</td></tr>`)
    .join('\n');
  return `<table class="styles"><thead><tr><th></th><th>Selector</th><th>Property</th><th>Live</th><th>New</th></tr></thead><tbody>\n${body}\n</tbody></table>`;
}

export function buildSheet({ liveDir, newDir, diffFile, stylesFile }) {
  const live = indexManifest(liveDir);
  const next = indexManifest(newDir);
  const diff = readJson(diffFile, 'diff');
  if (!Array.isArray(diff)) throw new UsageError(`${diffFile} is not a JSON array`);
  const styles = stylesFile ? readJson(stylesFile, 'styles') : [];
  const diffDir = dirname(diffFile);

  const diffByKey = new Map(diff.map((d) => [key(d.route, d.width), d]));
  const order = [];
  const seen = new Set();
  for (const { route, width } of [...diff, ...live.values(), ...next.values(), ...styles]) {
    const k = key(route, width);
    if (!seen.has(k)) {
      seen.add(k);
      order.push({ route, width });
    }
  }
  const routes = [...new Set(order.map((o) => o.route))];

  let failing = 0;
  const sections = routes.map((route) => {
    const rows = order.filter((o) => o.route === route).map(({ width }) => {
      const k = key(route, width);
      const a = live.get(k);
      const b = next.get(k);
      const d = diffByKey.get(k);
      const relativeFile = a ? relative(liveDir, a.path) : b ? relative(newDir, b.path) : null;
      const diffImage = d && relativeFile ? join(diffDir, relativeFile) : null;
      const badStyles = styles.filter((s) => s.route === route && s.width === width && !s.pass);
      if (d && !d.pass) failing += 1;
      failing += badStyles.length;
      const percent = Number.isFinite(d?.percent) ? `${d.percent.toFixed(2)} %` : 'n/a';
      const summary = d
        ? `${verdict(d.pass)} <strong>${escapeHtml(percent)}</strong> differing pixels <span class="muted">heights ${escapeHtml(d.heightA ?? '?')} / ${escapeHtml(d.heightB ?? '?')} px</span>`
        : `<span class="muted">${a || b ? 'no diff' : 'style only'}</span>`;
      const shots = a || b || d
        ? `<div class="shots">
${figure('Live', a?.path, a?.bannerClosed ? 'banner closed' : '')}
${figure('New', b?.path, b?.bannerClosed ? 'banner closed' : '')}
${d ? figure('Diff', diffImage) : ''}
</div>`
        : '';
      return `<div class="row${d && !d.pass ? ' bad' : ''}">
<h3>${escapeHtml(width)} px ${summary}</h3>
${shots}
${styleTable(badStyles)}
</div>`;
    });
    return `<section><h2><code>${escapeHtml(route)}</code></h2>\n${rows.join('\n')}\n</section>`;
  });

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual review</title>
<style>
:root { --bg: #fff; --fg: #1d1d1f; --muted: #6b6b70; --line: #e3e3e6; --pass: #1a7f37; --fail: #c62828; --card: #f7f7f8; }
@media (prefers-color-scheme: dark) { :root { --bg: #16161a; --fg: #ececf1; --muted: #9a9aa3; --line: #2c2c33; --pass: #4cc26a; --fail: #ff6b6b; --card: #1e1e24; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
h1 { margin: 0 0 4px; font-size: 22px; }
h2 { margin: 32px 0 8px; font-size: 18px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.muted { color: var(--muted); font-weight: 400; }
.pass { color: var(--pass); font-weight: 700; }
.fail { color: var(--fail); font-weight: 700; }
.row { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 12px 0; }
.row.bad { border-color: var(--fail); }
.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; align-items: start; }
figure { margin: 0; }
figcaption { font-size: 13px; margin-bottom: 4px; }
.frame { max-height: 1600px; overflow-y: auto; border: 1px solid var(--line); }
img { width: 100%; height: auto; display: block; }
.none { padding: 24px; text-align: center; color: var(--muted); border: 1px dashed var(--line); }
table.styles { margin-top: 12px; border-collapse: collapse; width: 100%; font-size: 13px; display: block; overflow-x: auto; }
table.styles th, table.styles td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
</style>
</head>
<body>
<h1>Visual review</h1>
<p class="muted">${routes.length} routes, ${order.length} route-width rows, ${failing} failing rows.</p>
${sections.join('\n')}
</body>
</html>
`;
  return { html, failing };
}

function options(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        live: { type: 'string' },
        new: { type: 'string' },
        diff: { type: 'string' },
        styles: { type: 'string' },
        out: { type: 'string', default: 'index.html' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (values.help) return { help: true };
  for (const name of ['live', 'new', 'diff']) {
    if (!values[name]) throw new UsageError(`--${name} is required`);
  }
  return {
    liveDir: resolve(values.live),
    newDir: resolve(values.new),
    diffFile: resolve(values.diff),
    stylesFile: values.styles ? resolve(values.styles) : null,
    out: resolve(values.out),
  };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const opts = options(argv);
    if (opts.help) {
      console.log(HELP);
      return 0;
    }
    const { html, failing } = buildSheet(opts);
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, html);
    console.log(`Wrote ${opts.out} (${failing} failing rows)`);
    return 0;
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeVersion();
  process.exitCode = main();
}
