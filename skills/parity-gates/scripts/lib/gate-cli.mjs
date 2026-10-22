// Shared command-line plumbing for the gate scripts. No side effects on import.
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_EXCEPTIONS, DEFAULT_PROPOSALS, loadExceptions } from './exceptions.mjs';

const STANDARD_OPTIONS = {
  dist: { type: 'string', default: 'dist', description: 'built site to check' },
  baseline: { type: 'string', default: 'baseline', description: 'captured baseline' },
  paths: { type: 'string', default: '', description: 'comma-separated paths to check, * matches anything (default: all)' },
  exceptions: { type: 'string', default: DEFAULT_EXCEPTIONS, description: 'approved differences' },
  proposals: { type: 'string', default: DEFAULT_PROPOSALS, description: 'proposed differences, used when PROPOSALS=on' },
  json: { type: 'boolean', default: false, description: 'print { gate, checked, failed, failures } as JSON' },
};

function usage(name, options, notes = '') {
  const lines = Object.entries(options).map(([flag, spec]) => {
    const left = spec.type === 'string' ? `--${flag} <value>` : `--${flag}`;
    const def = spec.default !== undefined && spec.default !== '' && spec.default !== false ? ` (default: ${spec.default})` : '';
    return `  ${left.padEnd(24)}${spec.description ?? ''}${def}`;
  });
  lines.push(`  ${'--help'.padEnd(24)}show this help`);
  return `Usage: ${name} [options]\n\n${lines.join('\n')}\n${notes ? `\n${notes.trim()}\n` : ''}\nExit codes: 0 pass, 1 failed gate, 2 usage or environment error.\n`;
}

const camel = (flag) => flag.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const trimSlash = (p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// "/a/,/blog/*" -> path => boolean. Trailing slashes are ignored on both sides,
// `*` matches any run of characters including "/", and "/x/*" also matches "/x".
export function pathMatcher(list) {
  const patterns = String(list ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (patterns.length === 0) {
    const all = () => true;
    all.patterns = [];
    return all;
  }
  const regexes = patterns.map((pattern) => {
    const p = trimSlash(pattern);
    if (p.endsWith('/*')) {
      const base = p.slice(0, -2).split('*').map(escape).join('.*');
      return new RegExp(`^${base}(?:/.*)?$`);
    }
    return new RegExp(`^${p.split('*').map(escape).join('.*')}$`);
  });
  const match = (path) => {
    const p = trimSlash(String(path));
    return regexes.some((re) => re.test(p));
  };
  match.patterns = patterns;
  return match;
}

// gateArgs(argv, name, { options: { 'allow-extra': { type: 'boolean' }, host: { type: 'string', default: 'vercel' } } })
// Standard keys plus each extra option, camelCased. --help exits 0, usage errors exit 2.
export function gateArgs(argv, name, { options: extra = {}, notes = '' } = {}) {
  const options = { ...STANDARD_OPTIONS, ...extra };
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage(name, options, notes));
    process.exit(0);
  }
  const parserOptions = {};
  for (const [flag, spec] of Object.entries(options)) {
    parserOptions[flag] = { type: spec.type ?? 'string' };
    if (spec.default !== undefined) parserOptions[flag].default = spec.default;
  }
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: parserOptions, strict: true, allowPositionals: false }));
  } catch (error) {
    process.stderr.write(`${name}: ${error.message}\n\n${usage(name, options, notes)}`);
    process.exit(2);
  }
  const result = {};
  for (const [flag, value] of Object.entries(values)) result[camel(flag)] = value;
  result.paths = pathMatcher(values.paths);
  return result;
}

// loadExceptions for a gate's parsed args; a file that is not valid exits 2.
export function gateExceptions(name, args) {
  try {
    return loadExceptions(args.exceptions, { proposals: args.proposals });
  } catch (error) {
    process.stderr.write(`${name}: ${error.message}\n`);
    return process.exit(2);
  }
}

function htmlFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...htmlFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(full);
  }
  return files;
}

// dist/index.html -> "/", dist/about/index.html -> "/about/", dist/404.html -> "/404.html".
export function builtPages(dist) {
  return htmlFiles(dist)
    .map((file) => {
      const rel = relative(dist, file).split(sep).join('/');
      const path = rel === 'index.html' ? '/' : rel.endsWith('/index.html') ? `/${rel.slice(0, -'index.html'.length)}` : `/${rel}`;
      return { path, file };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const show = (value) => JSON.stringify(value ?? null);
const CONTEXT = 5;

// Equal runs are cut to CONTEXT words either side of a change.
export function renderDiff(diff) {
  return diff
    .map(({ op, text }, index) => {
      if (op === 'delete') return `[-${text}-]`;
      if (op === 'insert') return `{+${text}+}`;
      const w = text.split(' ');
      const first = index === 0;
      const last = index === diff.length - 1;
      if (first && last) return text;
      if (first) return w.length > CONTEXT ? `... ${w.slice(-CONTEXT).join(' ')}` : text;
      if (last) return w.length > CONTEXT ? `${w.slice(0, CONTEXT).join(' ')} ...` : text;
      return w.length > CONTEXT * 2 ? `${w.slice(0, CONTEXT).join(' ')} ... ${w.slice(-CONTEXT).join(' ')}` : text;
    })
    .join(' ');
}

// results: { checked, failures: [{ path, field, expected, actual, diff? }] }
export function report(name, { checked = 0, failures = [] } = {}, { json = false, out = process.stdout, exit = process.exit } = {}) {
  const failed = failures.length;
  if (json) {
    out.write(`${JSON.stringify({ gate: name, checked, failed, failures }, null, 2)}\n`);
  } else {
    for (const f of failures) {
      if (Array.isArray(f.diff) && f.diff.length) out.write(`  ${f.path} ${f.field}: ${renderDiff(f.diff)}\n`);
      else out.write(`  ${f.path} ${f.field}: expected ${show(f.expected)}, got ${show(f.actual)}\n`);
    }
    out.write(`${name}: ${checked} checked, ${failed} failed\n`);
  }
  return exit(failed > 0 ? 1 : 0);
}
