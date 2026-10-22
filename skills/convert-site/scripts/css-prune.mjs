#!/usr/bin/env node
// Builds one stylesheet from the captured CSS, dropping the rules no page used
// according to css-coverage.mjs, and keeping the ones coverage cannot see.
// Exit codes: 0 written, 2 usage or input error.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as csstree from 'css-tree';
import { assertNodeVersion } from '../../../scripts/lib/node-version.mjs';

const HELP = `Usage: node css-prune.mjs --css <capture/css dir> --coverage coverage.json
                         --out <site.css> --report prune-report.json

Reads every .css file in --css (in capture/css/manifest.json order when present,
[{ file, href|inline, pages[] }]), matches each to its coverage from
css-coverage.mjs (stylesheet URLs through the manifest's href, falling back to
the file's basename; inline:<n> entries by their text), and writes one
stylesheet in source order that keeps:
  - every rule any page used (its range overlaps a used range)
  - every rule whose selector contains :hover :focus :active :visited :target
    :checked ::before ::after :nth or :not(
  - every @font-face, @keyframes, @import and @supports block, and everything
    inside @media (prefers-*)
  - other @media blocks only when a rule inside them is kept
@import rules are moved to the top of the output; @charset is dropped.

The report is { before: bytes, after: bytes, removedRules: n,
keptBecause: { pseudo: n, atRule: n } }, where keptBecause counts rules and
blocks no page used that were kept by the exceptions above.

Exit codes: 0 written, 2 usage or input error.`;

const PSEUDO = /:hover|:focus|:active|:visited|:target|:checked|::before|::after|:nth|:not\(/;
const KEEP_WHOLE = new Set(['font-face', 'keyframes', 'supports']);

class UsageError extends Error {}

const overlaps = (used, start, end) => used.some(([a, b]) => a < end && b > start);
const sourceOf = (text, node) => (node?.loc ? text.slice(node.loc.start.offset, node.loc.end.offset) : '');
const unprefixed = (name) => csstree.vendorPrefix(name) ? name.slice(csstree.vendorPrefix(name).length) : name;

// Filters a list of rules and at-rules in place; returns how many survived.
function pruneList(list, text, used, counts, imports) {
  const kept = [];
  list.forEach((node) => {
    const covered = node.loc ? overlaps(used, node.loc.start.offset, node.loc.end.offset) : true;
    if (node.type === 'Rule') {
      if (covered) kept.push(node);
      else if (PSEUDO.test(sourceOf(text, node.prelude))) {
        counts.pseudo += 1;
        kept.push(node);
      } else counts.removedRules += 1;
      return;
    }
    if (node.type !== 'Atrule') {
      kept.push(node);
      return;
    }
    const name = unprefixed(node.name.toLowerCase());
    if (name === 'charset') return;
    if (name === 'import' && imports) {
      if (!covered) counts.atRule += 1;
      imports.push(node);
      return;
    }
    const prefers = name === 'media' && /prefers-/i.test(sourceOf(text, node.prelude));
    const nested = node.block && !KEEP_WHOLE.has(name) && !prefers
      && !node.block.children.some((child) => child.type === 'Declaration');
    if (nested) {
      if (pruneList(node.block.children, text, used, counts, null)) kept.push(node);
      return;
    }
    if (!covered) counts.atRule += 1;
    kept.push(node);
  });
  const replacement = new csstree.List().fromArray(kept);
  list.head = replacement.head;
  list.tail = replacement.tail;
  return kept.length;
}

// Prunes one stylesheet's text against used [start, end] ranges into that text.
// Returns { css, imports, removedRules, keptBecause }; css holds everything but
// the @import rules, which come back separately so a combined file can put them first.
export function pruneCss(text, usedRanges) {
  const ast = csstree.parse(text, { positions: true });
  const counts = { pseudo: 0, atRule: 0, removedRules: 0 };
  const imports = [];
  pruneList(ast.children, text, usedRanges, counts, imports);
  return {
    css: csstree.generate(ast),
    imports: imports.map((node) => csstree.generate(node)),
    removedRules: counts.removedRules,
    keptBecause: { pseudo: counts.pseudo, atRule: counts.atRule },
  };
}

// Maps ranges taken in coverage text onto a file's text: unchanged when the texts
// match, shifted when the coverage text sits inside the file, and otherwise
// located rule by rule.
export function mapRanges(fileText, coverageText, usedRanges) {
  if (fileText === coverageText) return usedRanges;
  const at = fileText.indexOf(coverageText);
  if (at !== -1) return usedRanges.map(([start, end]) => [start + at, end + at]);
  const mapped = [];
  let from = 0;
  for (const [start, end] of usedRanges) {
    const segment = coverageText.slice(start, end);
    let found = fileText.indexOf(segment, from);
    if (found === -1) found = fileText.indexOf(segment);
    if (found === -1) continue;
    mapped.push([found, found + segment.length]);
    from = found + segment.length;
  }
  return mapped;
}

function normalizeUrl(href, { search = true } = {}) {
  try {
    const url = new URL(href);
    url.hash = '';
    if (!search) url.search = '';
    return url.href;
  } catch {
    return href;
  }
}

function urlBasename(href) {
  try {
    return basename(new URL(href).pathname);
  } catch {
    return basename(href.split(/[?#]/)[0]);
  }
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read ${what} ${file}: ${error.message}`);
  }
}

// The .css files in source order: manifest order first, then the rest by name.
function listFiles(dir) {
  if (!existsSync(dir)) throw new UsageError(`--css ${dir} does not exist`);
  const names = readdirSync(dir).filter((name) => name.endsWith('.css'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const manifestFile = join(dir, 'manifest.json');
  const manifest = existsSync(manifestFile) ? readJson(manifestFile, 'manifest') : [];
  if (!Array.isArray(manifest)) throw new UsageError(`${manifestFile} is not a JSON array`);
  const byFile = new Map(manifest.filter((entry) => entry && names.includes(entry.file)).map((entry) => [entry.file, entry]));
  const ordered = [...byFile.keys(), ...names.filter((name) => !byFile.has(name))];
  return ordered.map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8'), entry: byFile.get(name) }));
}

// Gives each coverage entry to the file it describes; returns Map<file name, ranges[]>.
function assignCoverage(files, coverage) {
  const ranges = new Map(files.map((file) => [file.name, []]));
  for (const [key, { text = '', usedRanges = [] }] of Object.entries(coverage)) {
    let file;
    if (key.startsWith('inline:')) {
      file = files.find((f) => f.entry?.inline !== undefined && f.text.includes(text))
        ?? files.find((f) => f.text.includes(text));
    } else {
      file = files.find((f) => f.entry?.href && normalizeUrl(f.entry.href) === normalizeUrl(key))
        ?? files.find((f) => f.entry?.href && normalizeUrl(f.entry.href, { search: false }) === normalizeUrl(key, { search: false }))
        ?? files.find((f) => f.name === urlBasename(key));
    }
    if (file) ranges.get(file.name).push(...mapRanges(file.text, text, usedRanges));
  }
  return ranges;
}

export function prune({ css, coverage }) {
  const files = listFiles(css);
  if (!files.length) throw new UsageError(`--css ${css} holds no .css files`);
  const assigned = assignCoverage(files, coverage);
  const imports = [];
  const bodies = [];
  const report = { before: 0, after: 0, removedRules: 0, keptBecause: { pseudo: 0, atRule: 0 } };
  for (const file of files) {
    const used = assigned.get(file.name);
    if (!used.length) console.error(`warning: no coverage matched ${file.name}; only the exception rules are kept`);
    const result = pruneCss(file.text, used);
    imports.push(...result.imports);
    if (result.css) bodies.push(result.css);
    report.before += Buffer.byteLength(file.text);
    report.removedRules += result.removedRules;
    report.keptBecause.pseudo += result.keptBecause.pseudo;
    report.keptBecause.atRule += result.keptBecause.atRule;
  }
  const output = [...imports, ...bodies].join('\n') + '\n';
  report.after = Buffer.byteLength(output);
  return { output, report };
}

function parse(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        css: { type: 'string' },
        coverage: { type: 'string' },
        out: { type: 'string' },
        report: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.help) return { help: true };
  for (const name of ['css', 'coverage', 'out', 'report']) if (!values[name]) throw new UsageError(`--${name} is required`);
  return values;
}

function main() {
  assertNodeVersion();
  let options;
  let result;
  try {
    options = parse(process.argv.slice(2));
    if (options.help) {
      console.log(HELP);
      return;
    }
    const coverage = readJson(options.coverage, 'coverage');
    if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
      throw new UsageError(`${options.coverage} is not a coverage object`);
    }
    result = prune({ css: options.css, coverage });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`css-prune: ${error.message}\nRun with --help for usage.`);
    process.exit(2);
  }
  for (const file of [options.out, options.report]) mkdirSync(dirname(file), { recursive: true });
  writeFileSync(options.out, result.output);
  writeFileSync(options.report, `${JSON.stringify(result.report, null, 2)}\n`);
  const { before, after, removedRules, keptBecause } = result.report;
  console.log(`css: ${before} -> ${after} bytes, ${removedRules} rules removed `
    + `(kept unused: ${keptBecause.pseudo} pseudo, ${keptBecause.atRule} at-rule); wrote ${options.out}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
