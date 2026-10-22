# Drupal

Read this after `fingerprint.mjs` says `drupal` (a `Drupal` generator or `X-Generator` header,
`/sites/default/files/` or `drupal-settings-json` in the page). The fingerprint also names the
theme and the modules it can see in asset paths.

## `/node/<id>` aliases become redirects

Drupal serves each page at its alias (`/about-us`) and at `/node/12`, usually both with status
200. The static site serves the alias only, and `/node/12` becomes a redirect to it so old links
keep working without a duplicate page. Drupal prints the id in `<link rel="shortlink"
href="/node/12">`: read the `shortlink` field of each record in `inventory.json` to build the
alias-to-node list, and note it. To confirm a few live, pass them with `--seed /node/12` (on a
`--resume` the seeds of the first run are kept, so start a fresh `--out` if you need new ones).
A site with the Redirect or Global Redirect module already answers `/node/12` with a 301, which
lands in `redirects.json` by itself.

## Media prefix

Files live under `/sites/default/files/` (or `/sites/<site>/files/` on a multisite), with
image-style derivatives under `/sites/default/files/styles/<style>/public/`, often with an
`?itok=` query. `media.json` keys files by path, so the `itok` variants of one file are one entry.
That prefix is the media prefix for the store decision; note it.

## JSON:API

The fingerprint reports `hasRest` when the page links `/jsonapi`. The capture does not read
JSON:API (its REST dump is WordPress only), and most Drupal sites do not enable it. Pages it would
list are reached through the sitemaps and the crawl; if the person says pages are missing, ask
them for the paths and pass them with `--seed`.

## Paged sitemaps

Sitemap modules split large sitemaps as `sitemap.xml?page=2`, listed from the index at
`/sitemap.xml` (the fingerprint asks for that on Drupal). The capture follows every page and saves
each under `sitemaps/`. The new site's sitemap is one plain `sitemap.xml`; a static host ignores
the query string, so the old paged URLs all resolve to it.

## Drupal 7 and Drupal 8 or later

The two generations write different body classes, and `templates.mjs` clusters Drupal by markup
(Jaccard 0.6, body classes weighted double; classes ending in a number are ignored):

- **Drupal 7**: `front`, `not-front`, `page-node`, `node-type-<type>`, `page-node-12`, and a
  theme-specific region markup. Content types usually separate cleanly by `node-type-*`.
- **Drupal 8 and later**: `path-frontpage`, `path-node`, `page-node-type-<type>`,
  `user-logged-out`, and Twig-built wrappers (`layout-container`, `region-*`). Layout Builder
  pages may split off from the rest of their content type; check each representative.

A Drupal 7 site converts the same way. Note the version: an end-of-life site is a reason the
person may want the conversion done quickly.

## Forms

Webform posts to Drupal itself and carries a `form_build_id` and `form_token`. The inventory
records the field names; the tokens are not fields to keep.
