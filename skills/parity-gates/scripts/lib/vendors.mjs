// Third-party script vendors, shared by the capture and the scripts gate so both name a script
// the same way. No side effects on import.

// Checked in order; the first rule that matches a script names its vendor.
// `src` and `code` test the script URL and the inline code; `id` patterns capture the account id.
export const VENDORS = [
  { vendor: 'gtm', src: /googletagmanager\.com\/gtm\.js/, code: /\bGTM-[A-Z0-9]+\b/, id: [/\b(GTM-[A-Z0-9]+)\b/] },
  {
    vendor: 'ga4',
    src: /googletagmanager\.com\/gtag\/js\?[^#]*\bid=G-/,
    code: /gtag\s*\(\s*['"]config['"]\s*,\s*['"]G-/,
    id: [/\b(G-[A-Z0-9]{4,})\b/],
  },
  {
    vendor: 'meta-pixel',
    src: /connect\.facebook\.net\/[^#]*fbevents\.js/,
    code: /\bfbq\s*\(/,
    id: [/fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d+)['"]/],
  },
  {
    vendor: 'hotjar',
    src: /static\.hotjar\.com/,
    code: /\bhj\s*\(|_hjSettings|static\.hotjar\.com/,
    id: [/hjid\s*:\s*(\d+)/, /hotjar-(\d+)\.js/],
  },
  {
    vendor: 'clarity',
    src: /clarity\.ms\/tag\//,
    code: /\bclarity\s*\(|["']clarity["']\s*,\s*["']script["']/,
    id: [/clarity\.ms\/tag\/(\w+)/, /["']clarity["']\s*,\s*["']script["']\s*,\s*["'](\w+)["']/],
  },
  {
    vendor: 'hubspot',
    src: /js\.hs-scripts\.com|js\.hsforms\.net|js\.hs-analytics\.net/,
    code: /hbspt\.|js\.hs-scripts\.com/,
    id: [/js\.hs-scripts\.com\/(\d+)\.js/, /portalId\s*:\s*["']?(\d+)/],
  },
  {
    vendor: 'intercom',
    src: /widget\.intercom\.io/,
    code: /intercomSettings|\bIntercom\s*\(/,
    id: [/widget\.intercom\.io\/widget\/(\w+)/, /app_id\s*:\s*["'](\w+)["']/],
  },
  { vendor: 'crisp', src: /client\.crisp\.chat/, code: /CRISP_WEBSITE_ID/, id: [/CRISP_WEBSITE_ID\s*=\s*["']([\w-]+)["']/] },
  { vendor: 'tawk', src: /embed\.tawk\.to/, code: /embed\.tawk\.to/, id: [/embed\.tawk\.to\/([^/'"?#]+)/] },
  {
    vendor: 'recaptcha',
    src: /google\.com\/recaptcha|recaptcha\.net|gstatic\.com\/recaptcha/,
    code: /\bgrecaptcha\./,
    id: [/[?&]render=(?!explicit\b)([\w-]+)/, /sitekey['"]?\s*:\s*["']([\w-]+)["']/],
  },
  { vendor: 'youtube', src: /youtube\.com\/(?:iframe_api|player_api)|ytimg\.com/, code: /youtube\.com\/iframe_api/, id: [] },
  { vendor: 'vimeo', src: /player\.vimeo\.com/, code: /player\.vimeo\.com/, id: [] },
  { vendor: 'maps', src: /maps\.googleapis\.com|maps\.google\.com/, code: /maps\.googleapis\.com/, id: [] },
];

// The vendor and account id of one script: its src URL, or its inline code when src is null.
export function detectVendor(src, code) {
  for (const rule of VENDORS) {
    const hit = src ? rule.src.test(src) : rule.code.test(code);
    if (!hit) continue;
    const haystack = src ?? code;
    for (const pattern of rule.id) {
      const match = haystack.match(pattern);
      if (match) return { vendor: rule.vendor, id: match[1] };
    }
    return { vendor: rule.vendor, id: null };
  }
  return { vendor: 'other', id: null };
}

