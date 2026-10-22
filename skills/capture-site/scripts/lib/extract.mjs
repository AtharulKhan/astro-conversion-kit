// One page's inventory record from its HTML. Pure: HTML string and URL in, record out.
// extractPage(html, url, { status, finalUrl, snapshot }) -> the record described in the
// capture-site SKILL.md. Besides the inventory fields it carries `alternates[]` and `shortlink`
// (from <link rel>) so the crawler can follow them without parsing the page twice.
import { attr, byTag, find, findAll, parseHtml, walk } from '../../../parity-gates/scripts/lib/html.mjs';
import { normaliseText, visibleText } from '../../../parity-gates/scripts/lib/visible-text.mjs';

// Checked in order; the first rule that matches a script names its vendor.
// `src` and `code` test the script URL and the inline code; `id` patterns capture the account id.
const VENDORS = [
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

const NOT_FIELDS = new Set(['submit', 'button', 'reset', 'image']);
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original'];
const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];

const bareHost = (host) => host.toLowerCase().replace(/^www\./, '');
const unique = (values) => [...new Set(values)];

function textOf(node) {
  const parts = [];
  walk(node, (n) => {
    if (n.nodeName === '#text') parts.push(n.value);
    return n.tagName === 'script' || n.tagName === 'style' ? false : undefined;
  });
  return normaliseText(parts.join(' '));
}

function relTokens(node) {
  return (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

function resolver(base) {
  return (href) => {
    if (href === null || href === undefined) return null;
    const trimmed = String(href).trim();
    if (!trimmed) return null;
    try {
      return new URL(trimmed, base).href;
    } catch {
      return null;
    }
  };
}

function absoluteSrcset(srcset, resolve) {
  if (!srcset) return null;
  return srcset
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const [url, ...descriptor] = candidate.split(/\s+/);
      return [resolve(url) ?? url, ...descriptor].join(' ');
    })
    .join(', ');
}

function toInt(value) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

function detectVendor(src, code) {
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

function jsonLdBlocks(document) {
  const blocks = [];
  for (const node of findAll(document, (n) => n.tagName === 'script' && (attr(n, 'type') ?? '').toLowerCase() === 'application/ld+json')) {
    const raw = node.childNodes.map((c) => c.value ?? '').join('').trim();
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // A broken block is left out; the snapshot still has it.
    }
  }
  return blocks;
}

// Top-level nodes of every block, flattening arrays and @graph.
function jsonLdNodes(blocks) {
  const nodes = [];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      nodes.push(value);
      if (value['@graph']) visit(value['@graph']);
    }
  };
  visit(blocks);
  return nodes;
}

function metaMaps(document) {
  const og = {};
  const twitter = {};
  const named = {};
  for (const meta of findAll(document, byTag('meta'))) {
    const key = (attr(meta, 'property') ?? attr(meta, 'name') ?? '').trim();
    const content = attr(meta, 'content');
    if (!key || content === null) continue;
    const lower = key.toLowerCase();
    if (lower.startsWith('og:')) og[lower.slice(3)] ??= content;
    else if (lower.startsWith('twitter:')) twitter[lower.slice(8)] ??= content;
    named[lower] ??= content;
  }
  return { og, twitter, named };
}

export function extractPage(html, url, { status = null, finalUrl = null, snapshot = null } = {}) {
  const page = new URL(url);
  const document = parseHtml(html);
  const baseHref = attr(find(document, byTag('base')) ?? {}, 'href');
  const resolve = resolver(resolver(page.href)(baseHref) ?? page.href);
  const { og, twitter, named } = metaMaps(document);

  const links = findAll(document, byTag('link'));
  const linkHref = (rel) => links.filter((n) => relTokens(n).includes(rel)).map((n) => resolve(attr(n, 'href'))).filter(Boolean);

  const headings = (tag) => findAll(document, byTag(tag)).map(textOf).filter(Boolean);
  const body = find(document, byTag('body'));
  const titleNode = find(document, byTag('title'));

  const images = [];
  for (const img of findAll(document, byTag('img'))) {
    const lazySrc = LAZY_SRC.map((name) => attr(img, name)).find(Boolean);
    const src = resolve(lazySrc ?? attr(img, 'src'));
    if (!src || src.startsWith('data:')) continue;
    const srcset = LAZY_SRCSET.map((name) => attr(img, name)).find(Boolean) ?? attr(img, 'srcset');
    images.push({
      src,
      srcset: absoluteSrcset(srcset, resolve),
      alt: attr(img, 'alt'),
      width: toInt(attr(img, 'width')),
      height: toInt(attr(img, 'height')),
      lazy: Boolean(lazySrc) || (attr(img, 'loading') ?? '').toLowerCase() === 'lazy',
    });
  }

  const iframes = unique(
    findAll(document, byTag('iframe'))
      .map((n) => resolve(attr(n, 'src') ?? attr(n, 'data-src')))
      .filter((src) => src && src !== 'about:blank'),
  );

  const forms = findAll(document, byTag('form')).map((form) => ({
    action: attr(form, 'action') || null,
    method: (attr(form, 'method') || 'get').toLowerCase(),
    fields: findAll(form, (n) => ['input', 'select', 'textarea'].includes(n.tagName))
      .filter((n) => attr(n, 'name'))
      .map((n) => ({
        name: attr(n, 'name'),
        type: n.tagName === 'input' ? (attr(n, 'type') || 'text').toLowerCase() : n.tagName,
        required: attr(n, 'required') !== null,
      }))
      .filter((field) => !NOT_FIELDS.has(field.type)),
  }));

  const scripts = findAll(document, byTag('script'))
    .filter((n) => (attr(n, 'type') ?? '').toLowerCase() !== 'application/ld+json')
    .map((n) => {
      const src = resolve(attr(n, 'src'));
      const code = src ? '' : n.childNodes.map((c) => c.value ?? '').join('');
      return { src, inline: !src, ...detectVendor(src, code) };
    });

  const styles = [];
  walk(document, (n) => {
    if (n.tagName === 'link' && relTokens(n).includes('stylesheet')) {
      const href = resolve(attr(n, 'href'));
      if (href) styles.push({ href, inline: false });
    } else if (n.tagName === 'style') styles.push({ href: null, inline: true });
    return undefined;
  });

  const internalLinks = [];
  const externalLinks = [];
  for (const a of findAll(document, (n) => n.tagName === 'a' || n.tagName === 'area')) {
    const href = resolve(attr(a, 'href'));
    if (!href) continue;
    const target = new URL(href);
    if (!/^https?:$/.test(target.protocol)) continue;
    target.hash = '';
    if (bareHost(target.hostname) === bareHost(page.hostname)) internalLinks.push(target.pathname + target.search);
    else externalLinks.push(target.href);
  }

  const blocks = jsonLdBlocks(document);
  const ldNodes = jsonLdNodes(blocks);
  const ldValue = (key) => ldNodes.map((n) => n[key]).find((v) => typeof v === 'string') ?? null;
  const text = visibleText(html);

  return {
    url: page.href,
    path: page.pathname + page.search,
    status,
    finalUrl: finalUrl ?? page.href,
    title: titleNode ? textOf(titleNode) : null,
    description: named.description ?? null,
    canonical: linkHref('canonical')[0] ?? null,
    robots: named.robots ?? null,
    lang: attr(find(document, byTag('html')) ?? {}, 'lang'),
    h1: headings('h1'),
    h2: headings('h2'),
    h3: headings('h3'),
    og,
    twitter,
    jsonLd: blocks,
    jsonLdTypes: unique(ldNodes.flatMap((n) => [].concat(n['@type'] ?? []))),
    published: named['article:published_time'] ?? ldValue('datePublished'),
    modified: named['article:modified_time'] ?? og.updated_time ?? ldValue('dateModified'),
    wordCount: text ? text.split(/\s+/).length : 0,
    bodyClasses: (attr(body ?? {}, 'class') ?? '').split(/\s+/).filter(Boolean),
    images,
    iframes,
    forms,
    scripts,
    styles,
    internalLinks: unique(internalLinks),
    externalLinks: unique(externalLinks),
    snapshot,
    text,
    alternates: unique(linkHref('alternate')),
    shortlink: linkHref('shortlink')[0] ?? null,
  };
}
