// What Cloudflare Pages answers for a URL, from _redirects and dist/. No side effects on import.
//
// _redirects: "from to [status]" lines (status 302 when left out), `#` comments. Static rules (no
// splat, no placeholder) are tried before dynamic ones, each group in file order, first match
// wins. `*` matches anything and fills `:splat`; `:name` matches one path segment. Matching is on
// the path only (a rule cannot match a query string) and case-sensitive.
// Then Pages serves dist/ with its own trailing-slash handling: /about/ for about/index.html and
// /about for about.html, each other form 308-redirected to it.
import { distSet, follow } from './vercel-resolver.mjs';

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&');
const isDynamicRule = (from) => from.includes('*') || /:\w/.test(from);

function compileRule(from) {
  const names = [];
  let re = '';
  for (const part of from.split(/(\*|:\w+)/)) {
    if (part === '*') {
      names.push('splat');
      re += '(.*)';
    } else if (/^:\w+$/.test(part)) {
      names.push(part.slice(1));
      re += '([^/]+)';
    } else re += escapeRe(part);
  }
  return { regex: new RegExp(`^${re}$`), names };
}

// _redirects text -> rules in match order: [{ from, to, status, dynamic, regex, names }]
export function parseRedirectsFile(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [from, to, status = '302'] = line.split(/\s+/);
    if (!from || !to) continue;
    rules.push({ from, to, status: Number(status), dynamic: isDynamicRule(from), ...compileRule(from) });
  }
  return [...rules.filter((r) => !r.dynamic), ...rules.filter((r) => r.dynamic)];
}

const decode = (path) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

// cloudflareResolver({ rules, dist, origins }) -> (url) => { hops, final }
export function cloudflareResolver({ rules = [], dist, origins = [] }) {
  const files = distSet(dist);

  function redirect(path) {
    for (const rule of rules) {
      const m = rule.regex.exec(path);
      if (!m) continue;
      const params = Object.fromEntries(rule.names.map((name, i) => [name, m[i + 1]]));
      const to = rule.to.replace(/:(\w+)/g, (match, name) => (name in params ? params[name] : match));
      return { to, status: rule.status };
    }
    return null;
  }

  function serve(path) {
    const p = decode(path).replace(/^\/+/, '');
    const found = (status = 200) => ({ path, status });
    if (!p) return found(files.has('index.html') ? 200 : 404);
    if (p.endsWith('/')) {
      const base = p.slice(0, -1);
      if (files.has(`${base}/index.html`)) return found();
      if (files.has(`${base}.html`)) return { to: `/${base}`, status: 308 };
      return found(404);
    }
    if (p === 'index.html' && files.has(p)) return { to: '/', status: 308 };
    if (p.endsWith('/index.html') && files.has(p)) return { to: `/${p.slice(0, -'index.html'.length)}`, status: 308 };
    if (p.endsWith('.html') && files.has(p)) return { to: `/${p.slice(0, -'.html'.length)}`, status: 308 };
    if (files.has(p) || files.has(`${p}.html`)) return found();
    if (files.has(`${p}/index.html`)) return { to: `/${p}/`, status: 308 };
    return found(404);
  }

  return (url) => follow(url, (path) => redirect(path) ?? serve(path), origins);
}

export const resolveCloudflare = (url, options) => cloudflareResolver(options)(url);
