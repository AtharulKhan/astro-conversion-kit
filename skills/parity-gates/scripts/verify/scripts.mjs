#!/usr/bin/env node
// Scripts gate: every third-party vendor in baseline/scripts.json with keep: true is on every
// page it was on (pages the live site served at 200) with the same account id; a vendor with
// keep: false is on no page; and no built page carries a vendor the live site did not have.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, report } from '../lib/gate-cli.mjs';
import { attr, byTag, findAll, parseHtml } from '../lib/html.mjs';
import { detectVendor } from '../../../capture-site/scripts/lib/extract.mjs';
import { distFiles, htmlPages, PAGE_KINDS, readJson, requireInputs } from '../lib/dist.mjs';

const NAME = 'scripts';
const NOTES = `
Vendors are recognised by the same rules the capture uses. To drop a vendor from the build, set
its keep to false in baseline/scripts.json; keep is the only field that may be edited there.
`;

// vendor -> [ids] of the third-party scripts on a page.
export function vendorsOf(html) {
  const vendors = new Map();
  const scripts = findAll(parseHtml(html), byTag('script')).filter((n) => (attr(n, 'type') ?? '').toLowerCase() !== 'application/ld+json');
  for (const node of scripts) {
    const src = attr(node, 'src');
    const code = src ? '' : node.childNodes.map((c) => c.value ?? '').join('');
    const { vendor, id } = detectVendor(src, code);
    if (vendor === 'other') continue;
    const ids = vendors.get(vendor) ?? [];
    if (id && !ids.includes(id)) ids.push(id);
    vendors.set(vendor, ids);
  }
  return vendors;
}

const shown = (ids) => (ids.length === 0 ? 'present' : ids.length === 1 ? ids[0] : ids);

export function checkScripts({ dist, scripts, routes, paths = () => true }) {
  const served = new Set(routes.filter((r) => r.status === 200 && PAGE_KINDS.has(r.kind)).map((r) => r.path));
  const pages = htmlPages(distFiles(dist)).filter((p) => paths(p.path));
  const failures = [];
  for (const page of pages) {
    const found = vendorsOf(readFileSync(join(dist, page.file), 'utf8'));
    for (const [vendor, ids] of found) {
      if (scripts[vendor]?.keep !== true) failures.push({ path: page.path, field: vendor, expected: null, actual: shown(ids) });
    }
    for (const [vendor, entry] of Object.entries(scripts)) {
      if (entry.keep !== true || !served.has(page.path) || !(entry.pages ?? []).includes(page.path)) continue;
      const ids = found.get(vendor);
      if (!ids) failures.push({ path: page.path, field: vendor, expected: entry.id ?? 'present', actual: null });
      else if (entry.id && !ids.includes(entry.id)) failures.push({ path: page.path, field: vendor, expected: entry.id, actual: shown(ids) });
    }
  }
  return { checked: pages.length, failures };
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { notes: NOTES });
  requireInputs(NAME, args.dist, args.baseline, ['scripts.json', 'routes.json']);
  const results = checkScripts({
    dist: args.dist,
    scripts: readJson(join(args.baseline, 'scripts.json')),
    routes: readJson(join(args.baseline, 'routes.json')),
    paths: args.paths,
  });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
