// The conversion pipeline, step by step, the way an agent runs it on a site: scaffold, capture,
// baseline, a minimal build from the captured markup, gates, visual review, suggestions,
// pre-launch and verify-live. Each step is a small named function over a site folder; the e2e
// test calls them in order. Scripts run as child processes so the in-process fixture keeps
// answering.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { chromium } from 'playwright';
import { vercelResolver } from '../../../skills/parity-gates/scripts/lib/vercel-resolver.mjs';

export const KIT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const TMP = join(KIT, 'test', 'tmp');
// The site's production origin. The fixture plays its live site at a local origin; the build is
// for the real host, as a conversion of a live site is.
export const PRODUCTION = 'https://example.com';
export const ENDPOINT = 'https://formspree.io/f/test';
export const HONEYPOT = 'website';
export const ASTRO_VERSION = '7.4.2';
export const WIDTHS = [390, 768, 1440];
const SKILLS = join(KIT, 'skills');
const NODE_BIN = dirname(process.execPath);
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};
// Every child sees this Node first on PATH (npm, npx and astro included), never an indexable flag
// unless a step sets one, and no proposals.
const baseEnv = () => {
  const env = { ...process.env, ...GIT_ENV, PATH: `${NODE_BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
  delete env.PUBLIC_INDEXABLE;
  delete env.PROPOSALS;
  return env;
};

// Runs a command; resolves { code, stdout, stderr } whatever the exit code.
export function sh(command, args, { cwd, env = {}, timeout = 300_000 } = {}) {
  return new Promise((done) => {
    execFile(command, args, { cwd, env: { ...baseEnv(), ...env }, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr, command: [command, ...args].join(' ') });
    });
  });
}

const node = (script, args, options) => sh(process.execPath, [script, ...args], options);
const kit = (skill, script) => join(SKILLS, skill, 'scripts', script);
const npm = (site, args, options = {}) => sh('npm', args, { cwd: site, ...options });

// Throws with the output when a step did not exit with the expected code.
export function expectCode(result, code = 0) {
  if (result.code !== code) {
    throw new Error(`${result.command} exited ${result.code}, expected ${code}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`);
  }
  return result;
}

// state.mjs phase <name>: stamps the previous phase's finishedAt.
export async function phase(site, name) {
  return expectCode(await node(join(site, 'scripts', 'state.mjs'), ['--dir', site, 'phase', name]));
}

export async function finishLastPhase(site) {
  const state = readJson(join(site, '.conversion', 'state.json'));
  return expectCode(await node(join(site, 'scripts', 'state.mjs'), ['--dir', site, 'set', `phases.${state.phase}.finishedAt`, JSON.stringify(new Date().toISOString())]));
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// ---------------------------------------------------------------------------------------------
// Scaffold. The site's node_modules is installed once by init-site, then kept under
// test/tmp/e2e-cache/<hash of the devDependencies> and linked into later scaffolds.

function cacheDir() {
  const kitDeps = readJson(join(KIT, 'package.json')).dependencies;
  const template = readFileSync(join(SKILLS, 'convert-site', 'templates', 'site', 'package.json'), 'utf8');
  const key = createHash('sha256')
    .update(JSON.stringify([process.versions.node.split('.')[0], process.platform, ASTRO_VERSION, kitDeps, template]))
    .digest('hex')
    .slice(0, 16);
  return join(TMP, 'e2e-cache', key, 'node_modules');
}

// init-site with npm install on the first run; later runs scaffold with --no-install and link
// the cached node_modules (the same packages: the key covers everything package.json pins).
// A bare repository beside the site stands in for its GitHub remote, so the branch can be pushed.
export async function scaffold({ site, name = 'Fixture Roofing' }) {
  rmSync(site, { recursive: true, force: true });
  const remote = `${site}-remote.git`;
  rmSync(remote, { recursive: true, force: true });
  expectCode(await sh('git', ['init', '-q', '--bare', remote]));
  const args = ['--dir', site, '--origin', PRODUCTION, '--name', name, '--host', 'vercel', '--astro-version', ASTRO_VERSION, '--repo', remote];
  const cache = cacheDir();
  const installed = !existsSync(cache);
  const result = expectCode(await node(kit('convert-site', 'init-site.mjs'), installed ? args : [...args, '--no-install']));
  if (installed) {
    mkdirSync(dirname(cache), { recursive: true });
    renameSync(join(site, 'node_modules'), cache);
  }
  symlinkSync(cache, join(site, 'node_modules'), 'dir');
  return { ...result, installed };
}

// ---------------------------------------------------------------------------------------------
// Capture: the capture-site chain into <site>/capture, media downloaded into <site>/public.

export async function captureSite({ site, live }) {
  const capture = join(site, 'capture');
  const steps = [
    [kit('capture-site', 'capture.mjs'), [live, '--out', capture, '--delay', '0', '--no-wayback', '--seed', '/old-services', '--seed', '/about']],
    [kit('capture-site', 'media.mjs'), ['--capture', capture, '--download', join(site, 'public'), '--delay', '0']],
    [kit('capture-site', 'templates.mjs'), ['--capture', capture]],
    [kit('capture-site', 'assets.mjs'), ['--capture', capture, '--delay', '0']],
    [join(site, 'scripts', 'review', 'shoot.mjs'), ['--base', live, '--routes', join(capture, 'templates.json'), '--out', join(capture, 'screens', 'live'), '--delay', '0', '--wait', '200']],
    [kit('capture-site', 'readme.mjs'), ['--capture', capture]],
  ];
  const results = [];
  for (const [script, args] of steps) results.push(expectCode(await node(script, args, { cwd: site })));
  return results;
}

export async function baseline(site) {
  return expectCode(await npm(site, ['run', 'baseline']));
}

// ---------------------------------------------------------------------------------------------
// Build: one .astro page per captured page, head values from baseline/seo.json, the rest of the
// head and the whole body moved from the captured HTML.

// Head elements Base.astro writes itself, or that the build replaces (stylesheets go through
// the pruned site.css; the REST API link points at a WordPress the static site does not have).
function headElementKept(node) {
  const name = node.tagName;
  const a = Object.fromEntries((node.attrs ?? []).map(({ name: k, value }) => [k, value]));
  if (!name) return false;
  if (['title', 'style'].includes(name)) return false;
  if (name === 'meta' && (a.charset || ['viewport', 'description', 'robots'].includes((a.name ?? '').toLowerCase()))) return false;
  const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
  if (name === 'link' && ['canonical', 'stylesheet', 'https://api.w.org/'].some((r) => rel.includes(r))) return false;
  return true;
}

// { head, body, bodyClass } of a captured page: source slices, so the markup is moved untouched.
export function splitPage(html) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const htmlNode = document.childNodes.find((n) => n.tagName === 'html');
  const head = htmlNode.childNodes.find((n) => n.tagName === 'head');
  const body = htmlNode.childNodes.find((n) => n.tagName === 'body');
  const slice = (n) => html.slice(n.sourceCodeLocation.startOffset, n.sourceCodeLocation.endOffset);
  const headParts = [];
  for (const child of head.childNodes) {
    if (child.nodeName === '#comment') headParts.push(slice(child));
    else if (headElementKept(child)) headParts.push(slice(child));
  }
  const { startTag, endTag } = body.sourceCodeLocation;
  const inner = html.slice(startTag.endOffset, endTag ? endTag.startOffset : html.length);
  const bodyClass = body.attrs.find((a) => a.name === 'class')?.value ?? '';
  return { head: headParts.join('\n'), body: inner.replace(/^\n/, ''), bodyClass };
}

// Links and sources on the live origin become root-relative; absolute URLs left (og:url,
// og:image, JSON-LD) move to the production origin.
export function rewriteOrigin(markup, live) {
  const escaped = live.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return markup.replace(new RegExp(`((?:href|src|srcset|data-src|data-srcset|action)="[^"]*?)${escaped}(?=/)`, 'g'), (m, before) => before)
    .replace(new RegExp(`(\\s\\d+w,\\s*)${escaped}(?=/)`, 'g'), '$1')
    .replaceAll(live, PRODUCTION);
}

const pageFile = (path) => (path === '/' ? 'index.astro' : `${path.replace(/^\/|\/$/g, '')}/index.astro`);

function astroPage(path, props, head, body) {
  const depth = path === '/' ? 0 : path.replace(/^\/|\/$/g, '').split('/').length;
  const up = '../'.repeat(depth + 1);
  return `---
// Moved from capture/: head values from baseline/seo.json, markup from the captured page.
import Base from '${up}layouts/Base.astro';
const props = ${JSON.stringify(props)};
const head = ${JSON.stringify(head)};
const body = ${JSON.stringify(body)};
---
<Base {...props}>
  <Fragment slot="head" set:html={head} />
  <Fragment set:html={body} />
</Base>
`;
}

export function writePages({ site, live }) {
  const routes = readJson(join(site, 'baseline', 'routes.json'));
  const seo = readJson(join(site, 'baseline', 'seo.json'));
  const written = [];
  for (const route of routes) {
    if (route.status !== 200 || !['page', 'post', 'archive'].includes(route.kind)) continue;
    const { head, body, bodyClass } = splitPage(readFileSync(join(site, 'capture', route.snapshot), 'utf8'));
    const s = seo[route.path] ?? {};
    const props = {
      title: s.title ?? '', description: s.description || undefined, canonical: s.canonical ? s.canonical.replace(live, PRODUCTION) : undefined,
      robots: s.robots || undefined, lang: s.lang || 'en', bodyClass,
    };
    write(join(site, 'src', 'pages', pageFile(route.path)), astroPage(route.path, props, rewriteOrigin(head, live), rewriteOrigin(body, live)));
    written.push(route.path);
  }
  return written;
}

// The live site's 404 page, from the first captured 404, in place of the template's.
export function write404({ site, live }) {
  const route = readJson(join(site, 'baseline', 'routes.json')).find((r) => r.status === 404 && r.snapshot);
  if (!route) return null;
  const record = readJson(join(site, 'capture', 'inventory.json')).find((r) => r.path === route.path);
  const { head, body, bodyClass } = splitPage(readFileSync(join(site, 'capture', route.snapshot), 'utf8'));
  const props = { title: record.title ?? '', description: record.description || undefined, robots: 'noindex', lang: record.lang || 'en', bodyClass };
  write(join(site, 'src', 'pages', '404.astro'), astroPage('/', props, rewriteOrigin(head, live), rewriteOrigin(body, live)));
  return route.path;
}

// Base.astro imports the pruned stylesheet, the way the agent wires it in.
export function importSiteCss(site) {
  const file = join(site, 'src', 'layouts', 'Base.astro');
  const source = readFileSync(file, 'utf8');
  if (source.includes("import '../styles/site.css';")) return;
  writeFileSync(file, source.replace("import { INDEXABLE } from '../lib/site.mjs';", "import { INDEXABLE } from '../lib/site.mjs';\nimport '../styles/site.css';"));
}

export async function pruneCss({ site, live }) {
  const coverage = join(site, '.conversion', 'coverage.json');
  const covered = expectCode(await node(join(site, 'scripts', 'css-coverage.mjs'), ['--base', live, '--routes', join(site, 'capture', 'inventory.json'), '--out', coverage, '--delay', '0'], { cwd: site }));
  const pruned = expectCode(await node(join(site, 'scripts', 'css-prune.mjs'), [
    '--css', join(site, 'capture', 'css'), '--coverage', coverage, '--out', join(site, 'src', 'styles', 'site.css'),
    '--report', join(site, '.conversion', 'prune-report.json'), '--origin', live,
  ], { cwd: site }));
  return { covered, pruned };
}

// An .ico holding one PNG image (Vista and later read PNG-compressed icons).
function icoFromPng(png, size) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size, 6);
  header.writeUInt8(size, 7);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

// The icon set a launch needs, drawn from the captured favicon: favicon.svg, favicon.ico,
// a 180x180 apple-touch-icon.png and a web app manifest that Base.astro links on every page.
export async function writeIcons(site, name = 'Fixture Roofing') {
  const svg = readFileSync(join(site, 'capture', 'assets', 'favicon.svg'));
  write(join(site, 'public', 'favicon.svg'), svg);
  const browser = await chromium.launch();
  const shots = {};
  try {
    const page = await browser.newPage();
    for (const size of [32, 180]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<body style="margin:0;background:#fff"><img style="display:block;width:${size}px;height:${size}px;object-fit:contain" src="data:image/svg+xml;base64,${svg.toString('base64')}"></body>`);
      shots[size] = await page.screenshot({ type: 'png' });
    }
  } finally {
    await browser.close();
  }
  write(join(site, 'public', 'apple-touch-icon.png'), shots[180]);
  write(join(site, 'public', 'favicon.ico'), icoFromPng(shots[32], 32));
  const manifest = { name, short_name: name, start_url: '/', display: 'browser', icons: [{ src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }] };
  write(join(site, 'public', 'site.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
  const layout = join(site, 'src', 'layouts', 'Base.astro');
  const source = readFileSync(layout, 'utf8');
  const links = '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />\n    <link rel="manifest" href="/site.webmanifest" />\n    <slot name="head" />';
  if (!source.includes('rel="manifest"')) writeFileSync(layout, source.replace('<slot name="head" />', links));
}

// The site's own scripts from capture/js/, served at the same paths as on the live site.
export function copyScripts(site) {
  const manifest = join(site, 'capture', 'js', 'manifest.json');
  if (!existsSync(manifest)) return [];
  const copied = [];
  for (const entry of readJson(manifest).filter((e) => e.file)) {
    const path = new URL(entry.src).pathname;
    cpSync(join(site, 'capture', 'js', entry.file), join(site, 'public', path.replace(/^\//, '')));
    copied.push(path);
  }
  return copied;
}

// The captured feeds at <path>/index.xml, and a vercel.json rewrite per feed so the host serves
// it at the live path (Vercel serves only index.html for a directory path).
export function copyFeeds({ site, live }) {
  const routes = readJson(join(site, 'baseline', 'routes.json')).filter((r) => r.kind === 'feed' && r.status === 200);
  const index = readJson(join(site, 'capture', 'feeds', 'index.json'));
  const rewrites = [];
  for (const route of routes) {
    const entry = index.find((f) => f.path === route.path);
    if (!entry) throw new Error(`no captured feed for ${route.path}`);
    const target = route.path.endsWith('/') ? `${route.path}index.xml` : `${route.path}.xml`;
    write(join(site, 'public', target.replace(/^\//, '')), readFileSync(join(site, 'capture', entry.file), 'utf8').replaceAll(live, PRODUCTION));
    rewrites.push({ source: route.path, destination: target });
  }
  const file = join(site, 'vercel.json');
  writeFileSync(file, `${JSON.stringify({ ...readJson(file), rewrites }, null, 2)}\n`);
  return routes.map((r) => r.path);
}

// A static sitemap index listing every indexable page, as @astrojs/sitemap would write it.
export function writeSitemap(site) {
  const routes = readJson(join(site, 'baseline', 'routes.json'))
    .filter((r) => r.status === 200 && ['page', 'post', 'archive'].includes(r.kind) && !r.noindex)
    .map((r) => r.path)
    .sort();
  write(join(site, 'public', 'sitemap-0.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map((p) => `<url><loc>${PRODUCTION}${p}</loc></url>`).join('')}</urlset>\n`);
  write(join(site, 'public', 'sitemap-index.xml'), `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${PRODUCTION}/sitemap-0.xml</loc></sitemap></sitemapindex>\n`);
  return routes;
}

// Every form posts to the new endpoint; the live honeypot field stays.
export function rewireForms(site) {
  const pages = join(site, 'src', 'pages');
  let count = 0;
  for (const file of filesUnder(pages).filter((f) => f.endsWith('.astro'))) {
    const source = readFileSync(file, 'utf8');
    const next = source.replace(/<form\b([^>]*?)\saction=\\"[^"\\]*\\"/g, (m, before) => {
      count += 1;
      return `<form${before} action=\\"${ENDPOINT}\\"`;
    });
    if (next !== source) writeFileSync(file, next);
  }
  return count;
}

// Commit everything on astro-rebuild and push it, as the agent does before each gate run.
export async function commitSite(site, message) {
  expectCode(await sh('git', ['add', '-A'], { cwd: site }));
  expectCode(await sh('git', ['commit', '-q', '--allow-empty', '-m', message], { cwd: site }));
  return expectCode(await sh('git', ['push', '-q', '-u', 'origin', 'astro-rebuild'], { cwd: site }));
}

export async function buildRedirects(site) {
  return expectCode(await npm(site, ['run', 'redirects:build']));
}

export async function build(site, { indexable = false } = {}) {
  return expectCode(await npm(site, ['run', 'build'], { env: indexable ? { PUBLIC_INDEXABLE: 'true' } : {} }));
}

export async function verify(site, { indexable = false } = {}) {
  // The theme's own scripts stay at their live paths (copyScripts), which the routes gate is told.
  const args = ['run', 'verify', '--', '--origin', PRODUCTION, '--endpoint', ENDPOINT, '--honeypot', HONEYPOT, '--host', 'vercel', '--allow-extra', '/wp-content/themes/*'];
  return npm(site, args, { env: indexable ? { PUBLIC_INDEXABLE: 'true' } : {} });
}

// ---------------------------------------------------------------------------------------------
// Serving the build.

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

// npx astro preview --background on `port` (Astro 7 backgrounds the server when it has no
// terminal anyway); resolves { origin, close() } once it answers. close() runs astro preview stop.
export async function astroPreview(site, port) {
  const started = expectCode(await sh('npx', ['astro', 'preview', '--background', '--port', String(port), '--host', '127.0.0.1'], { cwd: site }));
  const origin = `http://127.0.0.1:${port}`;
  const close = () => sh('npx', ['astro', 'preview', 'stop'], { cwd: site });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${origin}/`);
      await res.arrayBuffer();
      if (res.ok) return { origin, close };
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await close();
      throw new Error(`astro preview did not answer within 60 s\n${started.stdout}${started.stderr}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.xml': 'application/xml', '.css': 'text/css', '.js': 'text/javascript',
  '.txt': 'text/plain', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2', '.json': 'application/json',
};

// A local stand-in for the Vercel deployment of dist/: vercel.json's redirects (one hop per
// request, through the parity gates' Vercel resolver), its exact-path rewrites and its catch-all
// headers, then the files (a directory path serves only its index.html, as on Vercel).
// astro preview applies none of vercel.json, so verify-live runs against this.
export function serveLikeVercel(site) {
  const dist = join(site, 'dist');
  const config = readJson(join(site, 'vercel.json'));
  const resolveUrl = vercelResolver({ config, dist });
  const headers = (config.headers ?? []).filter((r) => r.source === '/(.*)').flatMap((r) => r.headers);
  const server = createServer((req, res) => {
    const { hops } = resolveUrl(req.url);
    const extra = Object.fromEntries(headers.map(({ key, value }) => [key, value]));
    if (hops.length) {
      res.writeHead(hops[0].status, { ...extra, Location: hops[0].to });
      return res.end();
    }
    const requested = decodeURIComponent(req.url.split('?')[0]);
    const rewrite = (config.rewrites ?? []).find((r) => r.source === requested);
    const path = (rewrite ? rewrite.destination : requested).replace(/^\/+/, '');
    const candidates = !path ? ['index.html'] : path.endsWith('/') ? [`${path}index.html`] : [path, `${path}/index.html`];
    const file = candidates.map((c) => join(dist, c)).find((f) => f.startsWith(dist + sep) && existsSync(f) && statSync(f).isFile());
    if (!file) {
      const notFound = join(dist, '404.html');
      res.writeHead(404, { ...extra, 'Content-Type': TYPES['.html'] });
      return res.end(existsSync(notFound) ? readFileSync(notFound) : 'Not found');
    }
    const body = readFileSync(file);
    res.writeHead(200, { ...extra, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      done({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(() => c())) });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Review, suggestions, pre-launch, verify-live.

export async function review({ site, live, preview }) {
  const r = (script) => join(site, 'scripts', 'review', script);
  const dir = join(site, 'review');
  const templates = join(site, 'capture', 'templates.json');
  const shoot = expectCode(await node(r('shoot.mjs'), ['--base', preview, '--routes', templates, '--out', join(dir, 'new'), '--delay', '0', '--wait', '200']));
  const diff = await node(r('diff.mjs'), ['--a', join(site, 'capture', 'screens', 'live'), '--b', join(dir, 'new'), '--out', join(dir, 'diff')]);
  const styles = await node(r('styles.mjs'), ['--live', live, '--new', preview, '--routes', templates, '--out', join(dir, 'styles.json'), '--delay', '0']);
  const sheet = expectCode(await node(r('sheet.mjs'), ['--live', join(site, 'capture', 'screens', 'live'), '--new', join(dir, 'new'), '--diff', join(dir, 'diff', 'diff.json'), '--styles', join(dir, 'styles.json'), '--out', join(dir, 'index.html')]));
  return { shoot, diff, styles, sheet };
}

export async function suggest(site) {
  return expectCode(await node(kit('suggest-improvements', 'suggest.mjs'), [
    '--capture', join(site, 'capture'), '--baseline', join(site, 'baseline'), '--review', join(site, 'review'),
    '--out', join(site, 'docs', 'suggestions.md'), '--json', join(site, '.conversion', 'suggestions.json'),
  ]));
}

export async function preLaunch(site) {
  rmSync(`${site}-pre-launch`, { recursive: true, force: true });
  return node(kit('pre-launch', 'pre-launch.mjs'), [
    '--dir', site, '--production-url', 'https://example.com', '--ignore-dir', 'capture', '--skip-build',
    '--out', `${site}-pre-launch`,
  ], { cwd: site });
}

export async function verifyLive(site, base) {
  return node(join(site, 'scripts', 'verify-live.mjs'), ['--base', base, '--baseline', join(site, 'baseline'), '--expect-noindex', '--delay', '0'], { cwd: site });
}

