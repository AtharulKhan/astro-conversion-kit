# Platforms

The capture works from what the site serves over HTTP: rendered HTML, sitemaps, response headers
and redirects. It never needs a database, an admin login or a plugin. Platform knowledge only adds
sources (an API that lists every page or every image size) and explains oddities in the markup.
`fingerprint.mjs` names the platform in at most four requests:

```
node skills/capture-site/scripts/fingerprint.mjs https://www.example.com
```

It recognises WordPress, Drupal, Webflow, Squarespace, Wix, Shopify, Joomla and plain static
sites. Shopify sites are stores and are out of scope (see the [FAQ](faq.md)).

## WordPress

The first-class case.

- **REST dumps.** When `/wp-json/` answers, the capture pages through `wp/v2/pages`, `posts`,
  `media`, `categories` and `tags` (following `X-WP-TotalPages`) and saves the JSON. Pages and
  posts the sitemap forgot show up here. Drafts and private content never do; the API only returns
  what is public.
- **Every image size.** WordPress writes resized copies of each upload (`photo-300x200.jpg`,
  `photo-1024x683.jpg`) and lists them in `srcset` and in the media API. The media set includes
  every registered size, referenced or not, because other sites and old emails may link to any of
  them and that cannot be known from the site itself.
- **`?p=` shortlinks.** `/?p=123` redirects to the post or page with that id. The capture records
  these from the API ids, and they become rows in `redirects.csv`; ids that 404 on the live site
  stay 404.
- **Category-base collisions.** `/category/news/` and a page called `/news/`, or a plugin that
  strips the category base so archives and pages share one namespace. The plan lists every slug
  claimed twice and which one the live site actually serves; the build serves the same one.
- **Shortcodes.** A leftover `[gallery]` or `[contact-form-7 id="12"]` in content means a plugin
  was removed or never rendered it. The build reproduces what the live page shows, raw brackets
  included, and the item goes in the suggestions.
- **Lazy-load attributes.** Themes and plugins put the real image in `data-src`, `data-srcset` or
  `data-lazy-src` and swap it in with script, often with a `<noscript>` duplicate. The capture
  reads the real source from those attributes and screenshots with reveals forced visible, so the
  media set and the screenshots both see the actual image.
- **Optimiser suffixes.** Image and cache plugins add `-scaled` (large uploads), `-e1612345678`
  (edited images), `.webp` next to the original (`photo.jpg.webp`) and `?ver=` query strings on
  assets. Each variant the site serves is a separate file at a separate URL and is kept as one.
- **Feeds and sitemaps.** `/feed/`, category feeds, core `wp-sitemap.xml` and plugin sitemaps
  (`sitemap_index.xml`, `post-sitemap.xml`) are captured; URLs in a sitemap that 404 are recorded
  as 404, not dropped silently.
- **Forms.** Plugin forms post to `admin-ajax.php` or a REST route, which will not exist. They are
  rewired to the chosen third-party endpoint with the same field names, honeypot and thank-you
  page.

## Drupal

- **`/node/<id>` aliases.** Drupal serves each page at its alias (`/about-us`) and at
  `/node/12`. The static site serves the alias and turns `/node/12` into a redirect to it, so old
  links keep working without a duplicate page.
- **Media prefix.** Files live under `/sites/default/files/`, with image-style derivatives under
  `/sites/default/files/styles/<style>/public/`, often with an `?itok=` query. That prefix is the
  media prefix for the store decision.
- **JSON:API.** When the `jsonapi` module is enabled, `/jsonapi` lists nodes and files and is used
  as an extra source. Most sites do not enable it, and the capture does not need it.
- **Paged sitemaps.** Sitemap modules split large sitemaps as `sitemap.xml?page=2`. The capture
  follows every page; the new site's sitemap is a single plain file at `sitemap.xml`. A static
  host ignores the query string, so the old paged URLs all resolve to that one sitemap.
- **End-of-life versions.** Drupal 7 sites convert the same way. Converting one is a good reason
  to: it removes the unpatched PHP.

## Webflow, Squarespace, Wix

These render on the platform's servers and host assets on the platform's CDN.

- **Media off the site's domain.** Images come from the platform CDN, not the site's own origin.
  The capture lists them, and by default the build keeps pointing at the CDN, exactly as live.
  When the account closes, CDN media disappears, so the agent proposes mirroring it under a local
  prefix. Mirroring changes every one of those URLs, so it is a logged exception that a person
  approves, never a silent default.
- **Script-driven layout.** Webflow interactions, Squarespace blocks and most of a Wix page are
  built or animated by script. The capture saves the rendered DOM and screenshots with animations
  disabled. Interactions that matter (menus, sliders, accordions) are rebuilt with a small script
  and checked in the visual review.
- **Forms** post to the platform and are rewired to the chosen endpoint.
- **Exports.** A Webflow code export or a Wix export can be read too, but the live site stays the
  source of truth: the gates compare against what visitors were served.

## Static and hand-written sites

The simplest case. Note whether URLs end in `.html`, `/` or neither; the scaffold matches the
majority, and the rest become redirects. Server-side includes, `.htaccess` rewrites and redirects
that only exist in the old server's config are found by the crawl as redirects, not by reading the
config. Ask the person for the old `.htaccess` if they have it: it may hold redirects no link
points to.

## Any platform

Legacy URLs from the Wayback Machine are added to the candidate set and marked unverified, because
they may be links other sites still use. After launch, `post-launch` watches for 404s so anything
only linked from outside surfaces in the first 30 days.
