// Excluded path prefixes (--exclude): parts of the host the capture never requests, such as a
// WordPress multisite's sub-sites (/president/, /media-relations/) or a section the owner leaves
// out. A prefix is matched against a URL's path as written; one ending in / also covers that
// folder without its slash (/services/ excludes /services and /services/roofing/).
// parseExclude(values) -> the prefixes of each comma-separated value, each starting with /;
// throws on an empty one, "/" (the whole site) or one that is not a path or URL.
// excludedBy(prefixes, pathname) -> the first prefix covering pathname, or null.

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
    if (prefix === '/') throw new Error('--exclude / would leave out the whole site');
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return prefixes;
}

export function excludedBy(prefixes, pathname) {
  for (const prefix of prefixes ?? []) {
    if (pathname.startsWith(prefix)) return prefix;
    if (prefix.endsWith('/') && pathname === prefix.slice(0, -1)) return prefix;
  }
  return null;
}
