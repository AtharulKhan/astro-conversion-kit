#!/usr/bin/env node
// Forms gate: each page with a form on the live site has the same forms in the build, each with
// the same field names in the same order, the same method, and its action set to the endpoint
// the build submits to (--endpoint). --honeypot names a spam-trap field every form must carry;
// --thank-you names the page every form leads to.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, report } from '../lib/gate-cli.mjs';
import { attr, byTag, findAll, parseHtml } from '../lib/html.mjs';
import { formFields } from '../lib/forms.mjs';
import { distFiles, firstExisting, pageFiles, pageFormat, readJson, requireInputs } from '../lib/dist.mjs';

const NAME = 'forms';
const OPTIONS = {
  endpoint: { type: 'string', default: '', description: 'the URL every form posts to; required when the baseline has a form' },
  honeypot: { type: 'string', default: '', description: 'a field name every form must have; allowed even where the live form had none' },
  'thank-you': { type: 'string', default: '', description: 'the page every form leads to: a hidden _next or redirect field equal to it, and a built page' },
};
const NOTES = `
Fields are named input, select and textarea elements, without submit, button, reset and image
inputs, read the way the capture reads them. A _next or redirect field the live form did not
have is the endpoint's thank-you setting and is not compared with the live fields.
--thank-you <path>: every form must carry a hidden _next or redirect field equal to it, and the
path must be a page in dist. Without it the thank-you page is not checked, and the summary
counts each form as skipped.
`;
const THANK_YOU_FIELDS = ['_next', 'redirect'];

// The forms of a built page, as the capture records them; fields are names, hidden values kept.
export function formsOf(html) {
  return findAll(parseHtml(html), byTag('form')).map((form) => ({
    action: attr(form, 'action') || null,
    method: (attr(form, 'method') || 'get').toLowerCase(),
    fields: formFields(form).map((f) => f.name),
    hidden: Object.fromEntries(
      findAll(form, (n) => n.tagName === 'input' && (attr(n, 'type') ?? '').toLowerCase() === 'hidden' && attr(n, 'name')).map((n) => [attr(n, 'name'), attr(n, 'value') ?? '']),
    ),
  }));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function compareForm(path, label, expected, actual, { endpoint, honeypot, thankYou }) {
  const failures = [];
  const field = (name) => (label ? `${label} ${name}` : name);
  const want = expected.fields.map((f) => (typeof f === 'string' ? f : f.name));
  let got = actual.fields;
  if (honeypot) {
    if (!got.includes(honeypot)) failures.push({ path, field: field('honeypot'), expected: honeypot, actual: null });
    if (!want.includes(honeypot)) got = got.filter((name) => name !== honeypot);
  }
  got = got.filter((name) => !THANK_YOU_FIELDS.includes(name) || want.includes(name));
  if (thankYou) {
    const values = THANK_YOU_FIELDS.filter((name) => name in actual.hidden).map((name) => actual.hidden[name]);
    if (!values.includes(thankYou)) failures.push({ path, field: field('thank-you'), expected: thankYou, actual: values[0] ?? null });
  }
  if (!same(want, got)) failures.push({ path, field: field('fields'), expected: want, actual: got });
  const method = (expected.method || 'get').toLowerCase();
  if (method !== actual.method) failures.push({ path, field: field('method'), expected: method, actual: actual.method });
  if (actual.action !== endpoint) failures.push({ path, field: field('action'), expected: endpoint, actual: actual.action });
  return failures;
}

export function checkForms({ dist, forms, endpoint, honeypot = '', thankYou = '', paths = () => true }) {
  const files = distFiles(dist);
  const format = pageFormat(files);
  const failures = [];
  let checked = 0;
  let formCount = 0;
  for (const [path, expected] of Object.entries(forms)) {
    if (!paths(path) || expected.length === 0) continue;
    checked += 1;
    const candidates = pageFiles(path, format);
    const file = firstExisting(dist, candidates);
    if (!file) {
      failures.push({ path, field: 'page', expected: candidates[0], actual: null });
      continue;
    }
    const actual = formsOf(readFileSync(join(dist, file), 'utf8'));
    if (actual.length !== expected.length) {
      failures.push({ path, field: 'forms', expected: expected.length, actual: actual.length });
      continue;
    }
    formCount += expected.length;
    expected.forEach((form, i) => {
      const label = expected.length > 1 ? `form ${i + 1}` : '';
      failures.push(...compareForm(path, label, form, actual[i], { endpoint, honeypot, thankYou }));
    });
  }
  if (thankYou && checked > 0) {
    const candidates = pageFiles(thankYou, format);
    if (!candidates.some((c) => files.includes(c))) failures.push({ path: thankYou, field: 'thank-you', expected: candidates[0], actual: null });
  }
  if (thankYou || checked === 0) return { checked, failures };
  return { checked, failures, skipped: formCount, skipReason: 'thank-you not checked', notes: ['thank-you: not checked (no --thank-you)'] };
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { options: OPTIONS, notes: NOTES });
  requireInputs(NAME, args.dist, args.baseline, ['forms.json']);
  const forms = readJson(join(args.baseline, 'forms.json'));
  const withForms = Object.entries(forms).filter(([path, list]) => args.paths(path) && list.length > 0);
  if (withForms.length > 0 && !args.endpoint) {
    process.stderr.write(`${NAME}: --endpoint <url> is required: the baseline has forms on ${withForms.map(([p]) => p).join(', ')}\n`);
    process.exit(2);
  }
  const results = checkForms({
    dist: args.dist,
    forms,
    endpoint: args.endpoint,
    honeypot: args.honeypot,
    thankYou: args.thankYou,
    paths: args.paths,
  });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
