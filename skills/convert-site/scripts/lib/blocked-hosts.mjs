// Analytics, tag, pixel and chat hosts that a screenshot or a style sample never needs. Blocking
// them keeps test loads out of the live site's reports and late widgets out of the shot.
// The same file lives in visual-review and convert-site; a test keeps the copies identical and a
// superset of the tracking vendors parity-gates names.

// A request is blocked when its host is one of these or a subdomain of one.
export const BLOCKED_HOSTS = [
  // Google Analytics, Tag Manager and the ad conversion pixels they load
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com', 'googleadservices.com', 'doubleclick.net',
  // Facebook (Meta) pixel
  'connect.facebook.net',
  // Hotjar, Microsoft Clarity
  'hotjar.com', 'hotjar.io', 'clarity.ms',
  // HubSpot tracking, cookie banner and chat (not js.hsforms.net, which draws a form)
  'hs-scripts.com', 'hs-analytics.net', 'hs-banner.com', 'hscollectedforms.net', 'usemessages.com',
  // Intercom, Drift
  'intercom.io', 'intercomcdn.com', 'drift.com', 'driftt.com',
  // LinkedIn insight, TikTok and Pinterest tags
  'snap.licdn.com', 'px.ads.linkedin.com', 'analytics.tiktok.com', 'ct.pinterest.com',
  // Segment, Mixpanel, Plausible, Fathom, Matomo cloud
  'segment.com', 'segment.io', 'mxpnl.com', 'mixpanel.com', 'plausible.io', 'usefathom.com', 'matomo.cloud', 'innocraft.cloud',
  // Crisp, Tawk and Zendesk chat
  'crisp.chat', 'tawk.to', 'zdassets.com', 'zopim.com',
];

export function isBlockedUrl(url) {
  const host = url.hostname.toLowerCase();
  return BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

// Aborts every request a Playwright browser context makes to a blocked host.
export async function blockAnalytics(context) {
  await context.route((url) => isBlockedUrl(url), (route) => route.abort('blockedbyclient'));
}
