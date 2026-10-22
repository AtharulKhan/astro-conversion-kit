---
name: capture-site
description: Crawl a live website, read-only and paced, into a capture/ folder that a rebuild is checked against — every page's HTML, text and head tags, redirects with every hop, links, third-party scripts, the media set, stylesheets, fonts, logo and icons, feeds, templates, and live screenshots at three widths. Use before converting or rebuilding a site, when asked to crawl, capture, snapshot or inventory a site, or when a capture stopped on blocks and needs resuming.
---

# capture-site

Save everything the live site serves, once, so every later step works from the capture and never
from the live site.

## The golden rule

**The live site is read-only, and the capture is read-only afterwards.** The scripts only make
paced GET and HEAD requests; never submit a form, log in, or request anything by hand to fill a
gap. Once the capture is finished and its notes written, nothing under `capture/` is edited: it is
the evidence the gates and the visual review compare against.

## When to use

- Step 2 of a conversion (`convert-site` runs it), or any time a live site has to be inventoried
  (a staging or new site is `launch-audit`'s job). A capture that exited 3 resumes, as below.

## Pacing

Every script waits **2500 ms between requests** per host by default, sends a desktop Chrome user
agent, doubles its wait after a 429 or 503 (up to 32 times), tries each URL 3 times, and stops
after **3 different URLs blocked in a row** (403, 429, 503 or a network error) with its state
saved. Keep the default `--delay` against a live site; `--delay 0` is for local fixtures only.
Never change `--ua` to get past a block. The crawl never requests `wp-admin`, `wp-login`,
`xmlrpc.php` or `?s=` searches.

## The command sequence

Run from the folder that will hold `capture/` (the site repository's root). `<skill-dir>` is this
skill's folder. Every script prints `--help`; run it rather than reading the source. Run each
step as its own command, in this order:

1. **Fingerprint**, then read the platform reference for what it names (table below):

       node <skill-dir>/scripts/fingerprint.mjs https://www.example.com

2. **Capture.** Discovery is the union of the sitemaps, the platform REST lists (WordPress, when
   the fingerprint finds REST; `--no-rest` to skip), the link crawl, and `--seed <path>` for
   paths the crawl cannot reach (old URLs from the person, an old `.htaccess`, a campaign link).
   After the crawl it asks the Wayback Machine for archived paths (`--no-wayback` to skip) and
   writes the ones it did not find to `wayback-unverified.txt`. `?p=` shortlinks are recorded as
   unverified redirects and never fetched unless you pass `--verify-shortlinks`.

       node <skill-dir>/scripts/capture.mjs https://www.example.com --out capture

3. **Media.** Lists every media file in `capture/media.json` with one paced HEAD each, and saves
   them byte for byte under `media-cache/` (gitignored; it mirrors site paths):

       node <skill-dir>/scripts/media.mjs --capture capture --download media-cache

4. **Templates.** Clusters the 200 pages into `capture/templates.json`. On WordPress, pages group
   by template body class first (`home`, `page`, `single-post`, `archive`, template classes) and a
   page whose markup is clearly different (Jaccard below 0.5) splits off as `page-2`; other
   platforms merge pages by markup at Jaccard 0.6 or more, as `template-<n>`:

       node <skill-dir>/scripts/templates.mjs --capture capture

5. **Assets.** Logo, favicon, apple-touch-icon and every `@font-face` font into `capture/assets/`:

       node <skill-dir>/scripts/assets.mjs --capture capture

6. **Live screenshots**, one per template at 390, 768 and 1440, with the visual-review shooter:

       node <skill-dir>/../visual-review/scripts/shoot.mjs --base https://www.example.com --routes capture/templates.json --widths 390,768,1440 --out capture/screens/live

7. **Lighthouse (optional).** Only when `npx --no-install lighthouse --version` answers; never
   install it unasked. If it is missing, say so in the notes: a skip, not a pass. One run per
   template representative, one at a time:

       npx --no-install lighthouse https://www.example.com/ --quiet --chrome-flags="--headless=new" --output json --output html --output-path capture/lighthouse-live/home

8. **README.** Summarises the capture in `capture/README.md`. Run it last, and after any rerun:

       node <skill-dir>/scripts/readme.mjs --capture capture

| Script | Exit |
|---|---|
| `fingerprint` | 0 done, 2 usage or unreachable, 3 blocking |
| `capture` | 0 done, 2 usage, 3 stopped on blocks or unreachable (resumable) |
| `media`, `assets` | 0 done (missing files included), 2 usage or no capture, 3 stopped on blocks |
| `templates`, `readme` | 0 done, 2 usage or no `inventory.json` |
| `shoot` | 0 all shot, 1 a route failed, 2 usage, 3 stopped on blocks |

## On exit 3

The site is blocking requests or cannot be reached. Wait (minutes, not seconds), then:

- `capture`: run the same command with `--resume`. URLs that answered 429, 503 or a network error
  are retried with a fresh set of tries; a URL that kept answering 403 is recorded with status 403
  (in `meta.json` `discoveryErrors` when it was a sitemap or REST list) and the crawl moves on.
- `media`, `assets`: run the same command again; work already done is kept.
- `shoot`: rerun with a longer `--delay`.

Never retry in a tight loop. After two stops in a row, tell the person and carry on with the rest
of the work; a site that blocks every request cannot be captured from here.

## What lands in capture/

    inventory.json        one record per page: status, title, description, robots, canonical,
                          alternates, Open Graph, JSON-LD, headings, forms, links, images, foundBy
    pages/  text/         raw HTML and visible text per page
    redirects.json        every redirect, chains collapsed, hops kept; shortlinks marked verified or not
    links.json            internal and external links, with the pages that carry them
    scripts.json          third-party vendors with their ids and pages
    media.json            every media file with sources, pages, status, type and bytes
    css/                  every stylesheet, inline <style> blocks, manifest.json
    templates.json        template clusters with a representative page each
    assets/               logo, icons, fonts, index.json
    screens/live/         live screenshots and manifest.json (gitignored)
    lighthouse-live/      Lighthouse reports, when run (gitignored)
    sitemaps/  feeds/  robots.txt  wp-rest/  wayback-unverified.txt  meta.json  state.json
    README.md             the generated summary and its ## Notes

## What you write by hand

Under `## Notes` in `capture/README.md` (kept when the README is regenerated): every resume and
why; every URL recorded 403 and every `discoveryErrors` entry; the Wayback status from
`meta.json`; whether shortlinks were verified; seeds you passed and where they came from; media
hosts other than the site's own (a platform CDN) seen in `pages/`; every `bannerClosed`,
`heightMismatch` and `error` in `screens/live/manifest.json`; a template split or merge that looks
wrong, with the paths; Lighthouse run or skipped; and the platform oddities from the reference.
Facts with paths, not opinions. Write the notes before the capture is committed.

## Platform references

| Fingerprint | Read |
|---|---|
| `wordpress` | `references/wordpress.md` |
| `drupal` | `references/drupal.md` |
| `webflow`, `squarespace`, `wix` | `references/webflow-squarespace-wix.md` |
| `static`, `joomla`, anything else | `references/static-and-unknown.md` |

`shopify` is a store and out of scope for conversion: stop and tell the person.

## Not covered

Repeat this list to the person verbatim. None of it was captured.

- Classes and states added by JavaScript after load (open menus, sliders); coverage runs later.
- CSS `@import` chains: imported stylesheets are not followed.
- Media on other hosts (platform CDNs, image services): not listed in `media.json`.
- A URL that answers 503 for good blocks the run until it recovers.
- Indexing directives from `<meta name="robots">` only; `X-Robots-Tag` headers are not read.
- Anything only a login, a form submission or a search reveals.
