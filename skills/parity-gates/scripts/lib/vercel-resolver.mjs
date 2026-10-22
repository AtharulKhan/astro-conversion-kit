// What a Vercel static deployment answers for a URL, from vercel.json and dist/, without a network
// or Vercel's own libraries. No side effects on import.
//
// Order, as Vercel builds its routes from vercel.json for a static project:
//   1. cleanUrls       /about.html and /about/index -> /about (308)
//   2. trailingSlash   true: /about -> /about/ (308, not for /.well-known or a last segment with a
//                      dot); false: /about/ -> /about (308)
//   3. redirects       in order, first match wins; path-to-regexp sources (`:name`, `:name*`,
//                      `:name+`, `:name?`, `:name(regex)`), strict and case-sensitive, with
//                      `has`/`missing` query conditions
//   4. the filesystem  dist/
//   5. rewrites        an exact source (no parameters) serves its destination's file when no file
//                      answered at step 4
// Each redirect is a hop; the next request starts again at step 1.
import { existsSync, statSync } from 'node:fs';
import { distFiles } from './dist.mjs';
import { isExternal } from './redirects-csv.mjs';

export const MAX_HOPS = 10;

function groupEnd(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '\\') i += 1;
    else if (src[i] === '(') depth += 1;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  throw new Error(`unbalanced "(" in ${src}`);
}

function tokenize(src) {
  const tokens = [];
  let text = '';
  let unnamed = 0;
  const flush = () => {
    if (text) tokens.push({ type: 'text', value: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      text += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if ((ch === ':' && /\w/.test(src[i + 1] ?? '')) || ch === '(') {
      let j = i;
      let name;
      if (ch === ':') {
        j = i + 1;
        while (j < src.length && /\w/.test(src[j])) j += 1;
        name = src.slice(i + 1, j);
      } else name = String(unnamed++);
      let pattern = null;
      if (src[j] === '(') {
        const end = groupEnd(src, j);
        pattern = src.slice(j + 1, end);
        j = end + 1;
      }
      const mod = src[j] && '*+?'.includes(src[j]) ? src[j++] : '';
      flush();
      tokens.push({ type: 'param', name, pattern, mod });
      i = j;
      continue;
    }
    text += ch;
    i += 1;
  }
  flush();
  return tokens;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// path-to-regexp (strict, case-sensitive, "/" as delimiter) -> { regex, names }
export function compileSource(source) {
  const tokens = tokenize(source);
  const names = [];
  let re = '';
  tokens.forEach((token, k) => {
    if (token.type === 'text') {
      const next = tokens[k + 1];
      re += escapeRe(next?.type === 'param' && token.value.endsWith('/') ? token.value.slice(0, -1) : token.value);
      return;
    }
    const prev = tokens[k - 1];
    const pre = prev?.type === 'text' && prev.value.endsWith('/') ? '\\/' : '';
    const p = token.pattern ?? '[^\\/#\\?]+?';
    names.push(token.name);
    if (token.mod === '') re += `${pre}(${p})`;
    else if (token.mod === '?') re += `(?:${pre}(${p}))?`;
    else re += `(?:${pre}((?:${p})(?:${pre}(?:${p}))*))${token.mod === '*' ? '?' : ''}`;
  });
  return { regex: new RegExp(`^${re}$`), names };
}

// Fill :name parameters of a destination; an empty optional parameter drops its leading "/".
export function fillDestination(destination, params) {
  return destination.replace(/(\/?):(\w+)(?:\([^)]*\))?([*+?]?)/g, (match, slash, name, mod) => {
    if (!(name in params)) return match;
    const value = params[name];
    if (value === undefined || value === '') return mod ? '' : slash;
    return `${slash}${value}`;
  });
}

function conditionHolds(condition, query) {
  if (condition.type !== 'query') return false;
  const values = query.getAll(condition.key);
  if (condition.value === undefined) return values.length > 0;
  const re = new RegExp(`^(?:${condition.value})$`);
  return values.some((v) => re.test(v));
}

const decode = (path) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

// The dist files as a set, for the resolvers.
export function distSet(dist) {
  return existsSync(dist) && statSync(dist).isDirectory() ? new Set(distFiles(dist)) : new Set();
}

// Shared request loop: next(path, search) returns a hop { to, status } or a final { path, status }.
// Both hosts pass the request's query string on to a destination that has none, so it is carried
// across hops (and `final.path` keeps it). A hop to an absolute URL on one of `origins` continues
// at its path; any other absolute URL ends the chain with { path: url, status: null }. A URL
// requested twice, or more than MAX_HOPS hops, ends it with status "loop".
export function follow(url, next, origins = []) {
  const hops = [];
  const seen = new Set([url]);
  let current = url;
  for (let n = 0; n < MAX_HOPS; n += 1) {
    const at = current.indexOf('?');
    const path = at === -1 ? current : current.slice(0, at);
    const search = at === -1 ? '' : current.slice(at);
    const result = next(path, search);
    if (!('to' in result)) return { hops, final: { path: current, status: result.status } };
    const to = result.to.includes('?') ? result.to : `${result.to}${search}`;
    hops.push({ from: current, to, status: result.status });
    if (isExternal(to)) {
      const own = origins.find((o) => o && (to === o || to.startsWith(`${o}/`) || to.startsWith(`${o}?`)));
      if (!own) return { hops, final: { path: to, status: null } };
      current = to.slice(own.length) || '/';
      if (current.startsWith('?')) current = `/${current}`;
    } else current = to;
    if (seen.has(current)) return { hops, final: { path: current, status: 'loop' } };
    seen.add(current);
  }
  return { hops, final: { path: current, status: 'loop' } };
}

// vercelResolver({ config, dist, origins }) -> (url) => { hops: [{ from, to, status }], final: { path, status } }
export function vercelResolver({ config = {}, dist, origins = [] }) {
  const files = distSet(dist);
  const { cleanUrls = false, trailingSlash } = config;
  const rules = (config.redirects ?? []).map((rule) => ({ rule, ...compileSource(rule.source) }));
  const slash = trailingSlash === true ? '/' : '';

  function urlRules(path) {
    if (cleanUrls) {
      let m = /^\/(?:(.+)\/)?index(?:\.html)?\/?$/.exec(path);
      if (m) return { to: m[1] ? `/${m[1]}${slash}` : '/', status: 308 };
      m = /^\/(.*)\.html\/?$/.exec(path);
      if (m) return { to: `/${m[1]}${slash}`, status: 308 };
    }
    if (trailingSlash === true && !/^\/\.well-known(?:\/.*)?$/.test(path)) {
      let m = /^\/((?:[^/]+\/)*[^/.]+)$/.exec(path);
      if (m) return { to: `/${m[1]}/`, status: 308 };
      m = /^\/((?:[^/]+\/)*[^/]+\.\w+)\/$/.exec(path);
      if (m) return { to: `/${m[1]}`, status: 308 };
    }
    if (trailingSlash === false) {
      const m = /^\/(.+)\/$/.exec(path);
      if (m) return { to: `/${m[1]}`, status: 308 };
    }
    return null;
  }

  function redirect(path, search) {
    const query = new URLSearchParams(search);
    for (const { rule, regex, names } of rules) {
      const m = regex.exec(path);
      if (!m) continue;
      if (rule.has && !rule.has.every((c) => conditionHolds(c, query))) continue;
      if (rule.missing && rule.missing.some((c) => conditionHolds(c, query))) continue;
      const params = Object.fromEntries(names.map((name, i) => [name, m[i + 1]]));
      const status = rule.statusCode ?? (rule.permanent === false ? 307 : 308);
      return { to: fillDestination(rule.destination, params), status };
    }
    return null;
  }

  function serve(path) {
    const p = decode(path).replace(/^\/+|\/+$/g, '');
    const candidates = !p ? ['index.html'] : path.endsWith('/') ? [`${p}/index.html`] : [p, ...(cleanUrls ? [`${p}.html`] : []), `${p}/index.html`];
    return { path, status: candidates.some((c) => files.has(c)) ? 200 : 404 };
  }

  // Exact rewrites only: a source with parameters or a destination off the site is not followed.
  const rewrites = new Map((config.rewrites ?? []).filter((r) => !/[:(*]/.test(r.source) && !isExternal(r.destination)).map((r) => [r.source, r.destination]));
  function rewrite(path) {
    const answer = serve(path);
    if (answer.status === 200 || !rewrites.has(path)) return answer;
    return { path, status: serve(rewrites.get(path)).status };
  }

  return (url) => follow(url, (path, search) => urlRules(path) ?? redirect(path, search) ?? rewrite(path), origins);
}

export const resolveVercel = (url, options) => vercelResolver(options)(url);
