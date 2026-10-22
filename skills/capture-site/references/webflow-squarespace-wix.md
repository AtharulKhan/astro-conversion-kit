# Webflow, Squarespace and Wix

Read this after `fingerprint.mjs` says `webflow`, `squarespace` or `wix`. These platforms render
on their own servers and host assets on their own CDNs. There is no REST list to dump: discovery
is the sitemaps, the crawl, Wayback and `--seed`.

## Media off the site's domain

Images, fonts and files come from the platform CDN, not the site's own host:

| Platform | Typical media hosts |
|---|---|
| Webflow | `cdn.prod.website-files.com`, `assets.website-files.com`, `uploads-ssl.webflow.com` |
| Squarespace | `images.squarespace-cdn.com`, `static1.squarespace.com` |
| Wix | `static.wixstatic.com`, `video.wixstatic.com` |

`media.json` lists only the site's own host, so these files are **not listed and not
downloaded**. Search `pages/` and `css/` for the hosts, and write each host, a file count from a
quick search, and two example URLs under `## Notes`. By default the build keeps pointing at the
CDN, as live. Mirroring it changes every one of those URLs, so it is a decision for the person,
made later, never a silent default.

## Script-driven layout

- **Webflow**: `data-wf-page` and `data-wf-site` on `<html>`, `w-` classes, and interactions
  (`data-w-id`) run by `webflow.js`. Elements an interaction hides start with inline
  `opacity: 0` or a transform; the screenshots force reveals visible, but note the pages that use
  interactions.
- **Squarespace**: `sqs-block` sections, a per-site `site.css`, and blocks (galleries, summary
  blocks, forms) built by script after load. Collections (blog, events, products) have their own
  sitemap entries and paged list URLs like `?offset=`; those query strings are dropped unless you
  pass `--include-query`, so note any list that only pages that way.
- **Wix**: the HTML is server-rendered, but most layout is absolutely positioned by script and
  the CSS is largely inline. Expect templates to cluster poorly; check every representative.
  Sitemaps are split by type (`pages-sitemap.xml`, `blog-posts-sitemap.xml`) under a
  `sitemap.xml` index.

Menus, sliders and accordions the scripts build are not in the captured markup's static state;
they are rebuilt later and checked in the visual review.

## Templates

These sites carry few template body classes, so `templates.mjs` groups them by markup alone
(Jaccard at least 0.6, as `template-<n>`). Look at `templates.json`: one template per page, or one
template holding every page, both mean the clustering did not find the layouts. Write which paths
belong together under `## Notes`.

## Forms and exports

Forms post to the platform; the inventory records the action and field names. A Webflow code
export or a Wix export can be read too, but the live site stays the source of truth: the gates
compare against what visitors were served.
