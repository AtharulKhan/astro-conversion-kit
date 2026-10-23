// Excluded path prefixes (--exclude): parts of the host the capture never requests, such as a
// WordPress multisite's sub-sites (/president/, /media-relations/) or a section the owner leaves
// out. Matching is the parity gates' (their lib/excluded.mjs): one canonical form on both sides,
// so non-ASCII, percent-encoded and either-case escapes compare equal; a prefix ending in / also
// covers that folder without its slash (/services/ excludes /services and /services/roofing/).
// parseExclude(values) -> the prefixes of each comma-separated value, each in canonical form
// starting with /; throws on an empty one, "/" (the whole site) or one that is not a path or URL.
// excludedBy(prefixes, pathname) -> the first prefix covering pathname, or null.
import { canonicalPath, excludedBy } from '../../../parity-gates/scripts/lib/excluded.mjs';

export { excludedBy };

export function parseExclude(values) {
  const prefixes = [];
  for (const part of values.flatMap((v) => String(v).split(','))) {
    const raw = part.trim();
    if (!raw) continue;
    let prefix = raw;
    if (/^https?:\/\//i.test(raw)) {
      try {
        prefix = new URL(raw).pathname;
      } catch {
        throw new Error(`--exclude ${raw} is not a path or URL`);
      }
    }
    if (!prefix.startsWith('/')) throw new Error(`--exclude ${raw} must be a path starting with /, e.g. /president/`);
    prefix = canonicalPath(prefix);
    if (prefix === '/') throw new Error('--exclude / would leave out the whole site');
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return prefixes;
}
