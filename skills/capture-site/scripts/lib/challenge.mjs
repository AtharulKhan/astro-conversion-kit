// Anti-bot challenges: an answer that is a host's or WAF's "prove you are a browser" page, not
// the site. detectChallenge({ status, headers, body, finalUrl }) -> { provider, cause } or null.
// - SiteGround: a redirect, meta refresh or JS redirect to /.well-known/sgcaptcha/;
// - Cloudflare: the `cf-mitigated: challenge` header, or /cdn-cgi/challenge-platform/ markup with
//   a challenge marker (/h/, orchestrate, chl_page or a challenge title): Bot Fight Mode puts
//   /cdn-cgi/challenge-platform/scripts/jsd/main.js on every page, real error pages included;
// - generic: a tiny HTML page on 202, 403 or 503 that redirects (meta refresh or JS) to a
//   challenge path;
// - and any success status whose HTML body is under 2 KB with no <title>, or a challenge title.
// provider is null when the host is not recognised; cause says what gave it away; kind is
// 'heuristic' for the tiny-page rule alone (it can match a real stub page, so callers weigh it)
// and 'signature' for everything else.

export const CHALLENGE = 'challenge';
export const SUSPECT = 'suspect-challenge';
export const TINY_BYTES = 2048;
const MARKUP_STATUSES = new Set([202, 403, 503]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)/i;
const SITEGROUND = /\/\.well-known\/sgcaptcha\//;
const CLOUDFLARE = /\/cdn-cgi\/challenge-platform\//;
const CLOUDFLARE_MARKER = /\/cdn-cgi\/challenge-platform\/h\/|orchestrate|chl_page|<title[^>]*>\s*(just a moment|attention required)/i;
const CHALLENGE_PATH = /\/\.well-known\/|captcha|challenge|bot-?check|verify|human/i;
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|security check|robot challenge|captcha|are you (a )?human|ddos-guard|bot verification/i;

const KNOWN = [
  { provider: 'SiteGround', pattern: SITEGROUND, path: '/.well-known/sgcaptcha/' },
  { provider: 'Cloudflare', pattern: CLOUDFLARE, path: '/cdn-cgi/challenge-platform/', marker: CLOUDFLARE_MARKER },
];

// The target of a meta refresh or a JS location change in the page, or null.
function redirectTarget(body) {
  const refresh = body.match(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/i)?.[0];
  const content = refresh?.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  const fromMeta = content ? (content[1] ?? content[2]).match(/^\s*\d*\s*;?\s*(?:url\s*=\s*)?['"]?([^'"\s]+)/i)?.[1] : null;
  if (fromMeta) return fromMeta;
  const js = body.match(/location(?:\.href)?\s*(?:=|\.replace\(|\.assign\()\s*["']([^"']+)["']/i);
  return js?.[1] ?? null;
}

const titleOf = (body) => body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1].trim() ?? null;

export function detectChallenge({ status, headers = {}, body = '', finalUrl = null } = {}) {
  if (typeof status !== 'number' || status === 0) return null;
  if (String(headers['cf-mitigated'] ?? '').toLowerCase() === 'challenge') {
    return { kind: 'signature', provider: 'Cloudflare', cause: `${status} with cf-mitigated: challenge` };
  }
  if (REDIRECT_STATUSES.has(status)) {
    const location = headers.location ?? '';
    for (const k of KNOWN) if (k.pattern.test(location)) return { kind: 'signature', provider: k.provider, cause: `${status} redirect to ${k.path}` };
    return null;
  }
  let landed = null;
  try {
    landed = finalUrl ? new URL(finalUrl).pathname : null;
  } catch {
    // not a URL: ignored
  }
  for (const k of KNOWN) if (landed && k.pattern.test(landed)) return { kind: 'signature', provider: k.provider, cause: `${status} after a redirect to ${k.path}` };

  if (typeof body !== 'string') return null;
  const type = headers['content-type'] ?? '';
  if (type ? !HTML_TYPE.test(type) : !/^\s*</.test(body)) return null;
  const bytes = Buffer.byteLength(body);

  if (MARKUP_STATUSES.has(status)) {
    for (const k of KNOWN) if (k.pattern.test(body) && (!k.marker || k.marker.test(body))) return { kind: 'signature', provider: k.provider, cause: `${status} with a page that loads ${k.path}` };
    const target = bytes < TINY_BYTES ? redirectTarget(body) : null;
    if (target && CHALLENGE_PATH.test(target)) return { kind: 'signature', provider: null, cause: `${status} with a ${bytes}-byte page that redirects to ${target}` };
  }
  if (status >= 200 && status < 300 && bytes < TINY_BYTES) {
    const title = titleOf(body);
    if (!title) return { kind: 'heuristic', provider: null, cause: `${status} with a ${bytes}-byte page and no title` };
    if (CHALLENGE_TITLE.test(title)) return { kind: 'heuristic', provider: null, cause: `${status} with a ${bytes}-byte page titled "${title}"` };
  }
  return null;
}
