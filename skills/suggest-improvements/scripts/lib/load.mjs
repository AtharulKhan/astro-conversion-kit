// Reads every input the checks use into one context object. Only the capture's inventory.json
// and the baseline's routes.json are required; everything else is optional and comes back
// empty when absent, and the checks that need it report themselves not covered.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class InputError extends Error {}

function readJson(file, fallback) {
  if (!file || !existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new InputError(`${file} is not valid JSON: ${error.message}`);
  }
}

// [{ path, report }] from <dir>/<slug>.json; the slug is the capture's page slug, and the
// report's requestedUrl names the page when the slug is not one.
function lighthouseReports(dir, inventory) {
  if (!dir || !existsSync(dir)) return [];
  const bySlug = new Map(
    inventory.filter((r) => r.snapshot).map((r) => [r.snapshot.replace(/^pages\//, '').replace(/\.html$/, ''), r.path]),
  );
  const reports = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const report = readJson(join(dir, name), null);
    if (!report?.audits) continue;
    const slug = name.replace(/\.json$/, '');
    let path = bySlug.get(slug) ?? null;
    if (!path) {
      try {
        path = new URL(report.requestedUrl ?? report.finalUrl ?? report.finalDisplayedUrl).pathname;
      } catch {
        path = slug;
      }
    }
    reports.push({ path, report });
  }
  return reports;
}

export function loadContext({ capture, baseline, review = null, lighthouse = null, gates = null, now = new Date() }) {
  if (!existsSync(join(capture, 'inventory.json'))) {
    throw new InputError(`no inventory.json in ${capture}: run capture.mjs first`);
  }
  if (!existsSync(join(baseline, 'routes.json'))) {
    throw new InputError(`no routes.json in ${baseline}: run build-baseline.mjs first`);
  }
  if (review && !existsSync(review)) throw new InputError(`--review ${review} does not exist`);
  if (lighthouse && !existsSync(lighthouse)) throw new InputError(`--lighthouse ${lighthouse} does not exist`);
  if (gates && !existsSync(gates)) throw new InputError(`--gates ${gates} does not exist`);
  const inventory = readJson(join(capture, 'inventory.json'), []);
  return {
    inventory,
    baseline: {
      routes: readJson(join(baseline, 'routes.json'), []),
      seo: readJson(join(baseline, 'seo.json'), {}),
      media: readJson(join(baseline, 'media.json'), []),
      scripts: readJson(join(baseline, 'scripts.json'), {}),
      meta: readJson(join(baseline, 'meta.json'), null),
    },
    media: readJson(join(capture, 'media.json'), []),
    redirects: readJson(join(capture, 'redirects.json'), []),
    links: readJson(join(capture, 'links.json'), { internal: {}, external: {} }),
    templates: readJson(join(capture, 'templates.json'), []),
    styles: review ? readJson(join(review, 'styles.json'), []) : [],
    manifest: review ? readJson(join(review, 'new', 'manifest.json'), []) : [],
    lighthouse: lighthouseReports(lighthouse ?? join(capture, 'lighthouse-live'), inventory),
    gates: gates ? readJson(gates, null) : null,
    meta: readJson(join(baseline, 'meta.json'), null) ?? readJson(join(capture, 'meta.json'), {}),
    now,
    readSnapshot: (rel) => {
      const file = rel ? join(capture, rel) : null;
      return file && existsSync(file) ? readFileSync(file, 'utf8') : null;
    },
    readReviewPng: (rel) => {
      const file = review && rel ? join(review, 'new', rel) : null;
      return file && existsSync(file) ? readFileSync(file) : null;
    },
  };
}
