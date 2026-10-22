#!/usr/bin/env node
// Compiles redirects.csv, the single source of a site's redirects, into the host's config:
// the `redirects` of vercel.json, or a Cloudflare Pages _redirects file.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertNodeVersion } from './lib/node-version.mjs';
import { isCatchAll, isDynamic, isExternal, readRedirectsCsv, splitFrom } from './lib/redirects-csv.mjs';

const NAME = 'build-redirects';
const OUT = { vercel: 'vercel.json', cloudflare: '_redirects' };
const MODES = new Set(['always', 'never']);
export const CLOUDFLARE_LIMITS = { static: 2000, dynamic: 100 };

const HELP = `Usage: ${NAME} --host vercel|cloudflare [options]

Writes the host's redirect rules from redirects.csv (from,to,status,source,note), one rule per row
in the csv's order. Sources are case-sensitive and kept as written.

  --csv <file>              the redirects (default: redirects.csv)
  --host vercel|cloudflare  the hosting target (required)
  --out <file>              where to write (default: vercel.json or _redirects)
  --trailing-slash <mode>   always or never: the site's URL form, used for catch-all targets and
                            Vercel's slash rules (default for vercel: read from the existing
                            vercel.json, else always; for cloudflare: always)
  --help                    show this help

vercel: merges into an existing vercel.json, keeping every other key (headers, rewrites,
cleanUrls, ...) and replacing "redirects". Entries are { source, destination, statusCode }, never
"permanent". A query-string row (/?p=7) matches with "has". A catch-all row (/old/* or
/old/:path*) is written in both its /:path* and /:path*/ forms. Vercel applies "trailingSlash"
before "redirects", so an unslashed source would take two hops (308 to the slashed URL, then the
redirect); the key is therefore replaced by the same 308 normalisation written as the last
redirects, after the site's own.

cloudflare: writes "from to status" lines, static rules first, then splats and placeholders. A
query-string row cannot be matched by _redirects and is left out, named on stderr. Pages accepts
2,000 static and 100 dynamic rules; more than that warns. The file must reach the deployed
output (put it in public/ or point --out at public/_redirects).

A static file at a redirect source competes with the rule: hosts differ on which one answers, so
the redirects gate fails any source that is also a page or file in dist. Delete the page or the
row.

Exit codes: 0 written, 2 usage error or a malformed csv.
`;

const fail = (message) => {
  process.stderr.write(`${NAME}: ${message}\n`);
  process.exit(2);
};

// Escape path-to-regexp's special characters, keeping :name, :name*, :name+ and :name? parameters.
const pathToRegexpSafe = (path) => path.replace(/(:\w+[*+?]?)|([(){}*+?])/g, (m, param, ch) => param ?? `\\${ch}`);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The site's trailing-slash normalisation as redirects, matching what vercel.json's
// "trailingSlash" does, so it runs after the site's own rules instead of before them.
export const SLASH_RULES = {
  always: [
    { source: '/:path((?!\\.well-known(?:/|$))(?:[^/]+/)*[^/.]+)', destination: '/:path/', statusCode: 308 },
    { source: '/:path((?:[^/]+/)*[^/]+\\.\\w+)/', destination: '/:path', statusCode: 308 },
  ],
  never: [{ source: '/:path(.+)/', destination: '/:path', statusCode: 308 }],
};

export function vercelRules(rows, mode) {
  const rules = [];
  for (const row of rows) {
    const { path, query } = splitFrom(row.from);
    const has = query.length ? { has: query.map(([key, value]) => ({ type: 'query', key, value: escapeRegex(value) })) } : {};
    let source = pathToRegexpSafe(path);
    let destination = row.to;
    if (/\/\*$/.test(path)) {
      source = `${pathToRegexpSafe(path.slice(0, -2))}/:splat*`;
      destination = destination.replace(/:splat\b(?![*+?])/g, ':splat*');
    }
    if (!isCatchAll(path)) {
      rules.push({ source, ...has, destination, statusCode: row.status });
      continue;
    }
    if (mode === 'always' && !isExternal(destination) && !destination.endsWith('/')) destination += '/';
    rules.push({ source, ...has, destination, statusCode: row.status });
    if (!source.endsWith('/')) rules.push({ source: `${source}/`, ...has, destination, statusCode: row.status });
  }
  return [...rules, ...SLASH_RULES[mode]];
}

// Returns { lines, skipped, counts }. In "always" mode a catch-all's target gets its trailing
// slash (Pages would otherwise add it with a second hop), and the bare prefix (/old/, an empty
// splat) gets a static rule of its own so it does not land on a "//" URL.
export function cloudflareLines(rows, mode = 'always') {
  const staticLines = [];
  const dynamicLines = [];
  const skipped = [];
  for (const row of rows) {
    if (row.from.includes('?')) {
      skipped.push(row);
      continue;
    }
    let { from, to } = row;
    const param = /:(\w+)[*+]/.exec(from);
    if (param) {
      from = from.replace(param[0], '*');
      to = to.replace(new RegExp(`:${param[1]}\\b[*+?]?`, 'g'), ':splat');
    }
    if (mode === 'always' && from.endsWith('/*') && to.endsWith('/:splat')) {
      staticLines.push(`${from.slice(0, -1)} ${to.slice(0, -':splat'.length)} ${row.status}`);
      to = `${to}/`;
    }
    (isDynamic(from) ? dynamicLines : staticLines).push(`${from} ${to} ${row.status}`);
  }
  return {
    lines: [...staticLines, ...dynamicLines],
    skipped,
    counts: { static: staticLines.length, dynamic: dynamicLines.length },
  };
}

function inferMode(existing) {
  if (existing.trailingSlash === true) return 'always';
  if (existing.trailingSlash === false || existing.cleanUrls === true) return 'never';
  return 'always';
}

function main() {
  assertNodeVersion();
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        csv: { type: 'string', default: 'redirects.csv' },
        host: { type: 'string' },
        out: { type: 'string' },
        'trailing-slash': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    fail(`${error.message}\n\n${HELP}`);
  }
  const { host } = values;
  if (!OUT[host]) fail(`--host must be vercel or cloudflare, not ${JSON.stringify(host ?? '')}`);
  const mode = values['trailing-slash'];
  if (mode !== undefined && !MODES.has(mode)) fail(`--trailing-slash must be always or never, not ${JSON.stringify(mode)}`);
  if (!existsSync(values.csv)) fail(`not found: ${values.csv}`);
  let rows;
  try {
    rows = readRedirectsCsv(values.csv);
  } catch (error) {
    fail(error.message);
  }
  const out = values.out ?? OUT[host];

  if (host === 'vercel') {
    let existing = {};
    if (existsSync(out)) {
      try {
        existing = JSON.parse(readFileSync(out, 'utf8'));
      } catch (error) {
        fail(`${out}: not valid JSON (${error.message})`);
      }
    }
    const urlMode = mode ?? inferMode(existing);
    const { trailingSlash, redirects: _replaced, ...kept } = existing;
    const redirects = vercelRules(rows, urlMode);
    writeFileSync(out, `${JSON.stringify({ ...kept, redirects }, null, 2)}\n`);
    if (trailingSlash !== undefined) {
      process.stderr.write(
        `${NAME}: replaced "trailingSlash": ${trailingSlash} with ${SLASH_RULES[urlMode].length} slash rule(s) after the site's ` +
          'redirects, so an unslashed source redirects in one hop\n',
      );
    }
    process.stdout.write(`${NAME}: ${rows.length} rows -> ${redirects.length} rules in ${out} (vercel, trailing slash ${urlMode})\n`);
    return;
  }

  const { lines, skipped, counts } = cloudflareLines(rows, mode ?? 'always');
  const header = `# Generated by ${NAME} from ${values.csv}; edit that file instead.\n`;
  writeFileSync(out, `${header}${lines.join('\n')}\n`);
  if (skipped.length) {
    process.stderr.write(
      `${NAME}: ${skipped.length} row(s) left out: _redirects cannot match a query string (${skipped.map((r) => r.from).join(', ')})\n`,
    );
  }
  if (counts.static > CLOUDFLARE_LIMITS.static) {
    process.stderr.write(`${NAME}: warning: ${counts.static} static rules; Cloudflare Pages accepts 2,000\n`);
  }
  if (counts.dynamic > CLOUDFLARE_LIMITS.dynamic) {
    process.stderr.write(`${NAME}: warning: ${counts.dynamic} dynamic rules; Cloudflare Pages accepts 100\n`);
  }
  process.stdout.write(`${NAME}: ${rows.length} rows -> ${lines.length} rules in ${out} (cloudflare)\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
