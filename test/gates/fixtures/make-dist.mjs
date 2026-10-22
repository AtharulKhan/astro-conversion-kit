// A dist/ built from test/fixture/site/ the way an Astro static build lays it out, for the gate
// tests. makeDist(outDir, { bad, origin, staging }) writes it and returns outDir. With staging,
// every page also carries the <meta name="robots" content="noindex, nofollow"> the site
// template's Base.astro adds to a build that is not PUBLIC_INDEXABLE.
//
// Layout: `/about/` -> about/index.html, `/` -> index.html, 404.html, feed/index.xml, media at the
// same paths as on the live site, theme CSS and JS under _astro/, sitemap-index.xml and
// sitemap-0.xml listing every indexable page, robots.txt, and _headers with the security headers
// and the staging X-Robots-Tag: noindex. wp-json/ and the WordPress sitemaps
// are left out. Canonical, og:url and og:image are absolute on `origin`; every other site URL is
// root-relative, as Astro writes them.
//
// `bad` names mutations from MUTATIONS, applied in order to the copy. Gate tasks add their own
// entries; each one throws when the text it changes is missing, so a fixture edit cannot make a
// mutation silently do nothing.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE = fileURLToPath(new URL('../../fixture/site/', import.meta.url));
export const DIST_ORIGIN = 'https://www.example.com';

const ORIGIN = /\{\{ORIGIN\}\}/g;
const THEME = 'wp-content/themes/fixture';
const LEFT_OUT = [/^wp-json\//, /^[^/]*sitemap[^/]*\.xml$/, /^robots\.txt$/];

function filesUnder(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else files.push(full);
  }
  return files;
}

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function html(source, origin) {
  return source
    .replace(/^<link rel="https:\/\/api\.w\.org\/"[^>]*>\n/m, '')
    .replace(`{{ORIGIN}}/${THEME}/style.css?ver=1.4.2`, '/_astro/style.css')
    .replace(`{{ORIGIN}}/${THEME}/js/reveal.js?ver=1.4.2`, '/_astro/reveal.js')
    .replace(/(<link rel="canonical" href=")\{\{ORIGIN\}\}/g, `$1${origin}`)
    .replace(/(<meta property="og:(?:url|image)" content=")\{\{ORIGIN\}\}/g, `$1${origin}`)
    .replace(ORIGIN, '');
}

const HEADERS = [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  X-Frame-Options: SAMEORIGIN',
  '  X-Robots-Tag: noindex',
  '',
].join('\n');

const GA4 = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-FIXTURE1"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-FIXTURE1');
</script>
`;

const pagePath = (rel) => (rel === 'index.html' ? '/' : `/${rel.slice(0, -'index.html'.length)}`);

// Replace the first `from` in a dist file; throws when it is not there.
export function edit(dist, file, from, to) {
  const full = join(dist, file);
  const source = readFileSync(full, 'utf8');
  if (!source.includes(from)) throw new Error(`make-dist: ${file} has no ${JSON.stringify(from)}`);
  writeFileSync(full, source.replace(from, to));
}

export const MUTATIONS = {
  // /hidden-page/ is not built.
  'missing-page': (dist) => {
    if (!existsSync(join(dist, 'hidden-page', 'index.html'))) throw new Error('make-dist: no hidden-page to remove');
    rmSync(join(dist, 'hidden-page'), { recursive: true });
  },
  // /extra-page/ is built but was never on the live site.
  'extra-page': (dist) => {
    cpSync(join(dist, 'about', 'index.html'), join(dist, 'extra-page', 'index.html'));
  },
  'changed-title': (dist) => edit(dist, 'about/index.html', '<title>About Us | ', '<title>About | '),
  'changed-h1': (dist) => edit(dist, 'services/index.html', '>Services</h1>', '>Our services</h1>'),
  'changed-paragraph': (dist) => edit(dist, 'contact/index.html', 'within one business day', 'within two business days'),
  'removed-description': (dist) =>
    edit(dist, 'about/index.html', '<meta name="description" content="A family-run roofing and siding company serving the area since 1998.">\n', ''),
  // /private-page/ loses its robots noindex.
  'lost-noindex': (dist) => edit(dist, 'private-page/index.html', '<meta name="robots" content="noindex, nofollow">\n', ''),
  // /services/, the target of /old-services and /?p=7, is not built.
  'redirect-target-missing': (dist) => {
    if (!existsSync(join(dist, 'services', 'index.html'))) throw new Error('make-dist: no services page to remove');
    rmSync(join(dist, 'services', 'index.html'));
  },
  // A page left at the redirect source /old-services (served there as old-services.html).
  'redirect-source-page': (dist) => {
    cpSync(join(dist, 'services', 'index.html'), join(dist, 'old-services.html'));
  },
  // Not a defect: the build.format "file" layout, every <dir>/index.html moved to <dir>.html.
  'file-format': (dist) => {
    for (const full of filesUnder(dist)) {
      const rel = relative(dist, full).split(sep).join('/');
      if (!rel.endsWith('/index.html')) continue;
      const target = join(dist, `${rel.slice(0, -'/index.html'.length)}.html`);
      cpSync(full, target);
      rmSync(full);
    }
  },
  // /about/ links to /contact-us/, which is not built.
  'broken-link': (dist) => edit(dist, 'about/index.html', '<a href="/contact/">', '<a href="/contact-us/">'),
  // /contact/ links to /about without its trailing slash.
  'unslashed-link': (dist) => edit(dist, 'contact/index.html', '<a href="/about/">', '<a href="/about">'),
  // hero.jpg is one byte longer than the live file.
  'media-drift': (dist) => {
    const file = join(dist, 'wp-content', 'uploads', '2026', '01', 'hero.jpg');
    if (!existsSync(file)) throw new Error('make-dist: no hero.jpg to change');
    appendFileSync(file, Buffer.from([0]));
  },
  // /feed/ is not built.
  'missing-feed': (dist) => {
    if (!existsSync(join(dist, 'feed', 'index.xml'))) throw new Error('make-dist: no feed to remove');
    rmSync(join(dist, 'feed'), { recursive: true });
  },
  // /feed/ has one item fewer than the live feed.
  'dropped-feed-item': (dist) => {
    const file = join(dist, 'feed', 'index.xml');
    const source = readFileSync(file, 'utf8');
    const item = /<item>[\s\S]*?<\/item>\n?/.exec(source);
    if (!item) throw new Error('make-dist: feed/index.xml has no <item>');
    writeFileSync(file, source.replace(item[0], ''));
  },
  // The sitemap leaves out /about/.
  'sitemap-missing-page': (dist) => edit(dist, 'sitemap-0.xml', `<url><loc>${DIST_ORIGIN}/about/</loc></url>`, ''),
  // The contact form asks for email before name.
  'reordered-field': (dist) => {
    const name = '<p><label for="cf-name">Name</label><input id="cf-name" type="text" name="name" required></p>';
    const email = '<p><label for="cf-email">Email</label><input id="cf-email" type="email" name="email" required></p>';
    edit(dist, 'contact/index.html', `${name}\n    ${email}`, `${email}\n    ${name}`);
  },
  // /about/ lost the GA4 tag.
  'dropped-ga4': (dist) => edit(dist, 'about/index.html', GA4, ''),
  // /about/ gained a vendor the live site never had.
  'added-vendor': (dist) =>
    edit(dist, 'about/index.html', '</head>', '<script async src="https://static.hotjar.com/c/hotjar-1234567.js?sv=6"></script>\n</head>'),
  // _headers lost X-Content-Type-Options.
  'missing-header': (dist) => edit(dist, '_headers', '  X-Content-Type-Options: nosniff\n', ''),
};

const STAGING_META = '<meta name="robots" content="noindex, nofollow">\n</head>';

export function makeDist(outDir, { bad = [], origin = DIST_ORIGIN, staging = false } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const indexable = [];
  for (const full of filesUnder(SITE)) {
    const rel = relative(SITE, full).split(sep).join('/');
    if (LEFT_OUT.some((re) => re.test(rel))) continue;
    if (rel === `${THEME}/style.css`) {
      const css = readFileSync(full, 'utf8').replace(/url\("fonts\//g, `url("/${THEME}/fonts/`);
      write(join(outDir, '_astro', 'style.css'), css);
    } else if (rel === `${THEME}/js/reveal.js`) {
      write(join(outDir, '_astro', 'reveal.js'), readFileSync(full));
    } else if (rel.endsWith('.html')) {
      const page = html(readFileSync(full, 'utf8'), origin);
      write(join(outDir, rel), staging ? page.replace('</head>', STAGING_META) : page);
      if (rel !== '404.html' && !/<meta name="robots" content="[^"]*noindex/i.test(page)) indexable.push(pagePath(rel));
    } else if (rel.endsWith('.xml')) {
      write(join(outDir, rel), readFileSync(full, 'utf8').replace(ORIGIN, origin));
    } else {
      write(join(outDir, rel), readFileSync(full));
    }
  }
  const urls = indexable.sort().map((p) => `<url><loc>${origin}${p}</loc></url>`).join('');
  write(
    join(outDir, 'sitemap-0.xml'),
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`,
  );
  write(
    join(outDir, 'sitemap-index.xml'),
    `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemap-0.xml</loc></sitemap></sitemapindex>\n`,
  );
  write(join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap-index.xml\n`);
  write(join(outDir, '_headers'), HEADERS);
  for (const name of bad) {
    const mutate = MUTATIONS[name];
    if (!mutate) throw new Error(`make-dist: unknown mutation "${name}" (known: ${Object.keys(MUTATIONS).join(', ')})`);
    mutate(outDir);
  }
  return outDir;
}
