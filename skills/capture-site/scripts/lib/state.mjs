// Crawl state, saved as `<capture>/state.json` so a blocked crawl can resume.
// Shape: { version, origin, startedAt, updatedAt, phase: 'discover'|'crawl'|'done', options,
//          queue: [{ url, attempts }], seen[], foundBy{ key: source[] }, records[], redirects[],
//          feeds[], slugs{ slug: key }, fingerprint }
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const STATE_FILE = 'state.json';
const VERSION = 1;

export function newState(origin, options) {
  const now = new Date().toISOString();
  return {
    version: VERSION,
    origin,
    startedAt: now,
    updatedAt: now,
    phase: 'discover',
    options,
    queue: [],
    seen: [],
    foundBy: {},
    records: [],
    redirects: [],
    feeds: [],
    slugs: {},
    fingerprint: null,
  };
}

export function loadState(dir) {
  const file = join(dir, STATE_FILE);
  if (!existsSync(file)) return null;
  const state = JSON.parse(readFileSync(file, 'utf8'));
  if (state.version !== VERSION) throw new Error(`${file} has version ${state.version}, expected ${VERSION}`);
  return state;
}

// Written to a temporary file and renamed, so an interrupted write never leaves half a state.
export function saveState(dir, state) {
  const file = join(dir, STATE_FILE);
  mkdirSync(dirname(file), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}
