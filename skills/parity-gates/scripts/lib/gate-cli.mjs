// Shared command-line plumbing for the gate scripts. No side effects on import.
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const VALUE_FLAGS = ['dist', 'baseline', 'paths', 'exceptions', 'proposals'];

function usage(name) {
  return `Usage: ${name} [options]

  --dist <dir>          built site to check (default: dist)
  --baseline <dir>      captured baseline (default: baseline)
  --paths <list>        comma-separated paths to check, * matches anything (default: all)
  --exceptions <file>   approved differences (default: exceptions.json)
  --proposals <file>    proposed differences, used when PROPOSALS=on (default: proposals.json)
  --json                print { gate, checked, failed, failures } as JSON
  --help                show this help

Exit codes: 0 pass, 1 failed gate, 2 usage or environment error.
`;
}

function usageError(name, message) {
  process.stderr.write(`${name}: ${message}\n\n${usage(name)}`);
  process.exit(2);
}

// "/a/,/blog/*" -> path => boolean. `*` matches any run of characters, including "/".
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
  const regexes = patterns.map(
    (p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`),
  );
  const match = (path) => regexes.some((re) => re.test(path));
  match.patterns = patterns;
  return match;
}

export function gateArgs(argv, name) {
  const values = {
    dist: 'dist',
    baseline: 'baseline',
    paths: '',
    exceptions: 'exceptions.json',
    proposals: 'proposals.json',
  };
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage(name));
      process.exit(0);
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (!m || !VALUE_FLAGS.includes(m[1])) usageError(name, `unknown option ${arg}`);
    let value = m[2];
    if (value === undefined) {
      value = argv[i + 1];
      i += 1;
    }
    if (value === undefined || value === '' || value.startsWith('--')) usageError(name, `--${m[1]} needs a value`);
    values[m[1]] = value;
  }
  return { ...values, paths: pathMatcher(values.paths), json };
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

const show = (value) => (typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value ?? null));

function renderDiff(diff) {
  return diff
    .map(({ op, text }) => (op === 'delete' ? `[-${text}-]` : op === 'insert' ? `{+${text}+}` : text))
    .join(' ');
}

// results: { checked, failures: [{ path, field, expected, actual, diff? }] }
export function report(
  name,
  { checked = 0, failures = [] } = {},
  { json = process.argv.includes('--json'), out = process.stdout, exit = process.exit } = {},
) {
  const failed = failures.length;
  if (json) {
    out.write(`${JSON.stringify({ gate: name, checked, failed, failures }, null, 2)}\n`);
  } else {
    for (const f of failures) {
      out.write(`  ${f.path} ${f.field}: expected ${show(f.expected)}, got ${show(f.actual)}\n`);
      if (Array.isArray(f.diff) && f.diff.length) out.write(`    diff: ${renderDiff(f.diff)}\n`);
    }
    out.write(`${name}: ${checked} checked, ${failed} failed\n`);
  }
  return exit(failed > 0 ? 1 : 0);
}
