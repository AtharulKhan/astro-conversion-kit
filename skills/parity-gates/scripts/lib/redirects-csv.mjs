// redirects.csv, the single source of a site's redirects: from,to,status,source,note.
// No side effects on import.
//
// `from` is a root-relative path, optionally with a query string (`/?p=7`), or a catch-all: a
// trailing `/*` (the target may use `:splat`) or a `:name*` parameter (the target may use
// `:name`). `to` is a root-relative path or an absolute URL. Matching is case-sensitive.
import { readFileSync } from 'node:fs';

export const CSV_HEADER = ['from', 'to', 'status', 'source', 'note'];
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// RFC 4180 fields: quoted fields may hold commas, quotes ("") and newlines.
export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

// Returns [{ from, to, status, source, note, line }]. Throws on a malformed file.
export function parseRedirectsCsv(text, file = 'redirects.csv') {
  const [header, ...rows] = parseCsvText(text.replace(/^﻿/, ''));
  if (!header || CSV_HEADER.some((name, i) => (header[i] ?? '').trim() !== name)) {
    throw new Error(`${file}: the first line must be ${CSV_HEADER.join(',')}`);
  }
  return rows.map((cells, index) => {
    const line = index + 2;
    const [from, to, status, source = '', note = ''] = cells.map((c) => c.trim());
    if (!from?.startsWith('/')) throw new Error(`${file}:${line}: "from" must start with /, got ${JSON.stringify(from ?? '')}`);
    if (!to) throw new Error(`${file}:${line}: "to" is empty`);
    if (/\s/.test(from) || /\s/.test(to)) throw new Error(`${file}:${line}: "from" and "to" must not contain spaces (encode them as %20)`);
    const code = Number(status);
    if (!REDIRECT_STATUSES.has(code)) {
      throw new Error(`${file}:${line}: status must be one of ${[...REDIRECT_STATUSES].join(', ')}, got ${JSON.stringify(status ?? '')}`);
    }
    return { from, to, status: code, source, note, line };
  });
}

export function readRedirectsCsv(file) {
  return parseRedirectsCsv(readFileSync(file, 'utf8'), file);
}

// "/?p=7&a=b" -> { path: "/", query: [["p","7"],["a","b"]] }
export function splitFrom(from) {
  const at = from.indexOf('?');
  if (at === -1) return { path: from, query: [] };
  const query = [...new URLSearchParams(from.slice(at + 1))];
  return { path: from.slice(0, at), query };
}

// A catch-all: a trailing "/*" or a ":name*" / ":name+" parameter.
export const isCatchAll = (from) => /\/\*$/.test(from) || /:\w+[*+]/.test(from);
// Anything with a splat or a placeholder.
export const isDynamic = (from) => from.includes('*') || /:\w/.test(from);
export const isExternal = (to) => /^[a-z][a-z0-9+.-]*:\/\//i.test(to);
