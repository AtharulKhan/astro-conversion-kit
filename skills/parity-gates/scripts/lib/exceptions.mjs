// Approved differences between the baseline and the build. No side effects on import.
// exceptions.json is an array of { path, field, from, to, reason, approvedBy, date }.
// With PROPOSALS=on, proposals.json (same record shape) is loaded after it.
import { existsSync, readFileSync } from 'node:fs';

export const EXCEPTION_KEYS = ['path', 'field', 'from', 'to', 'reason', 'approvedBy', 'date'];
export const EXCEPTION_FIELDS = [
  'title', 'description', 'canonical', 'robots', 'h1', 'h2', 'text',
  'og', 'jsonLd', 'link', 'redirect', 'media',
];

function readRecords(file) {
  if (!file || !existsSync(file)) return [];
  let records;
  try {
    records = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: not valid JSON (${error.message})`);
  }
  if (!Array.isArray(records)) throw new Error(`${file}: expected an array of exceptions`);
  records.forEach((record, index) => {
    const where = `${file}[${index}]`;
    if (!record || typeof record !== 'object') throw new Error(`${where}: expected an object`);
    for (const key of EXCEPTION_KEYS) {
      if (record[key] === undefined || record[key] === null || record[key] === '') {
        throw new Error(`${where}: missing "${key}"`);
      }
    }
    if (!EXCEPTION_FIELDS.includes(record.field)) {
      throw new Error(`${where}: field "${record.field}" is not one of ${EXCEPTION_FIELDS.join('|')}`);
    }
  });
  return records;
}

export function loadExceptions(file, { proposals = 'proposals.json', env = process.env } = {}) {
  const records = readRecords(file);
  if (env.PROPOSALS === 'on') records.push(...readRecords(proposals));
  return records;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Replace every occurrence of `from` inside value: a whole value that equals `from`, an array
// item or object value that equals it, or (for visible text) a phrase inside a string.
function substitute(value, from, to, phrase) {
  if (same(value, from)) return { value: to, hit: true };
  if (Array.isArray(value)) {
    let hit = false;
    const next = value.map((item) => {
      const r = substitute(item, from, to, phrase);
      hit ||= r.hit;
      return r.value;
    });
    return { value: next, hit };
  }
  if (value && typeof value === 'object') {
    let hit = false;
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      const r = substitute(item, from, to, phrase);
      hit ||= r.hit;
      next[key] = r.value;
    }
    return { value: next, hit };
  }
  if (phrase && typeof value === 'string' && typeof from === 'string' && value.includes(from)) {
    return { value: value.split(from).join(String(to)), hit: true };
  }
  return { value, hit: false };
}

// Returns a copy of `expected` with matching exceptions applied, plus
// `stale` (true when an exception for this path no longer matches) and `staleExceptions`.
export function applyExceptions(expected, path, exceptions = []) {
  const record = structuredClone(expected ?? {});
  const staleExceptions = [];
  for (const exception of exceptions) {
    if (exception.path !== path) continue;
    const { field, from, to } = exception;
    const result = field in record
      ? substitute(record[field], from, to, field === 'text')
      : { hit: false };
    if (result.hit) record[field] = result.value;
    else staleExceptions.push(exception);
  }
  record.stale = staleExceptions.length > 0;
  record.staleExceptions = staleExceptions;
  return record;
}
