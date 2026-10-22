// What the capture treats as a page, and what it never requests: shared by the crawl
// (capture.mjs) and the Wayback list (wayback.mjs) so the two cannot drift apart.
export const PAGE_EXTENSIONS = new Set(['', 'html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'shtml', 'cfm']);
// Never requested at all.
export const NEVER = /(?:^|\/)(?:wp-admin|wp-login|xmlrpc\.php)(?:[/.?]|$)/i;
// Never a page (the REST lists are fetched on purpose, not crawled).
export const NOT_PAGES = /^\/wp-json(?:\/|$)/i;

// The lowercase extension of a path's last segment, or '' when it has none.
export function extensionOf(pathname) {
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
}
