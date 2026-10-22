---
name: capture-site
description: Crawl a live website, read-only and paced, into a capture/ folder that a rebuild is checked against — every page's HTML, text and head tags, redirects with every hop, links, third-party scripts, the media set, stylesheets, fonts, logo and icons, feeds, templates, and live screenshots at three widths. Use before converting or rebuilding a site, when asked to crawl, capture, snapshot or inventory a site, or when a capture stopped on blocks and needs resuming.
---

# capture-site

Save everything the live site serves, once, so every later step works from the capture.

## The golden rule

**The live site is read-only, and the capture is read-only afterwards.** The scripts only make
paced GET and HEAD requests; never submit a form, log in, or fetch by hand to fill a gap. Once the
notes are written, nothing under `capture/` is edited: it is the evidence every gate reads.

## When to use

Step 2 of a conversion (`convert-site` runs it), or any time a live site has to be inventoried
(a staging or new site is `launch-audit`'s job). A capture that exited 3 resumes, as below.

## Pacing

Every script waits **2500 ms between requests** by default and sends a desktop Chrome user agent.
Keep the default `--delay` against a live site (`--delay 0` is for local fixtures only), and never
change `--ua` to get past a block.

- `capture` doubles its wait after a 429 or 503 (up to 32 times), tries each URL 3 times, and
  stops after **3 different URLs blocked in a row** (403, 429, 503 or a network error), state
  saved. It never requests `wp-admin`, `wp-login`, `xmlrpc.php` or `?s=` searches.
- `media` tries each file 3 times: a persistent 429 or 503 stops it at once; a 403 or network
  error is recorded as that file's status, and 3 such files in a row stop it.
- `fingerprint` does not retry: a blocked home page is exit 3. `assets` and `shoot` back off and
  stop after 3 blocked responses in a row.

## The command sequence

Run from the folder that will hold `capture/` (the site repository's root). `<skill-dir>` is the
absolute path of this skill's folder, in a copy of the kit where `npm install` has run (the
scripts import its packages). Every script prints `--help`; run it rather than reading the
source. Run each step as its own command, in this order:

1. **Fingerprint**, then read the platform reference for what it names (table below):

       node <skill-dir>/scripts/fingerprint.mjs https://www.example.com

2. **Capture.** Discovery is the sitemaps, the REST lists (WordPress, when the fingerprint finds
   REST; `--no-rest` skips), the link crawl, and `--seed <path>` or `--seed-file <file>` (one
   path or URL per line, `#` comments) for paths the crawl cannot reach (old URLs, an old
   `.htaccess`). After the crawl, Wayback paths it did not find go to `wayback-unverified.txt`
   (`--no-wayback` skips). `?p=` shortlinks are recorded unverified and never fetched unless you
   pass `--verify-shortlinks`.

       node <skill-dir>/scripts/capture.mjs https://www.example.com --out capture

   Then the **Wayback second pass**, when `wayback-unverified.txt` is not empty: it requests each
   archived path once, so the ones that still redirect land in `capture/redirects.json` with
   source `seed` (the baseline's redirects pick them up) and the rest are recorded with their
   status in `inventory.json`. `--seed`, `--seed-file` and `--include-query` all apply on
   `--resume`, and the Wayback Machine is not asked again:

       node <skill-dir>/scripts/capture.mjs https://www.example.com --out capture --resume --seed-file capture/wayback-unverified.txt

3. **Media.** Lists every media file in `capture/media.json` and saves it under
   `.conversion/media-cache/`, the conversion's working directory, which stays out of git:

       node <skill-dir>/scripts/media.mjs --capture capture --download .conversion/media-cache

4. **Templates.** Clusters the pages that answered 200 into `capture/templates.json`. On
   WordPress, pages group by template body class first (`home`, `page`, `single-post`,
   `archive`, template classes) and a page whose markup is clearly different (Jaccard below 0.5)
   splits off as `page-2`; other platforms merge by markup at Jaccard 0.6, as `template-<n>`:

       node <skill-dir>/scripts/templates.mjs --capture capture

5. **Assets.** Logo, favicon, apple-touch-icon and every `@font-face` font into `capture/assets/`:

       node <skill-dir>/scripts/assets.mjs --capture capture

6. **Live screenshots**, one per template at 390, 768 and 1440, with the visual-review shooter:

       node <skill-dir>/../visual-review/scripts/shoot.mjs --base https://www.example.com --routes capture/templates.json --widths 390,768,1440 --out capture/screens/live

7. **Lighthouse (optional).** Only when `npx --no-install lighthouse --version` answers; never
   install it unasked; if it is missing, say so in the notes (a skip, not a pass). Run `mkdir -p
   capture/lighthouse-live`, then one run per `representative` in `templates.json`, in turn:

       npx --no-install lighthouse https://www.example.com/ --quiet --chrome-flags="--headless=new" --output json --output html --output-path capture/lighthouse-live/home

8. **README.** Summarises the capture in `capture/README.md`; its `## Notes` open with generated
   lines, rewritten on every run (how many Wayback paths the second pass verified and what each
   answered: status, redirect target). Run it last, and after any rerun:

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

- `fingerprint`: run it again.
- `capture`: run the same command with `--resume`. URLs that answered 429, 503 or a network error
  are retried with a fresh set of tries; a URL that kept answering 403 is recorded with status 403
  (in `meta.json` `discoveryErrors` when it was a sitemap or REST list) and the crawl moves on.
- `media`, `assets`: run the same command again; work already done is kept.
- `shoot`: rerun with a longer `--delay`.

Never retry in a tight loop. After two stops in a row, tell the person and carry on with the rest.

## What lands in capture/

    inventory.json        one record per page: status, head tags, JSON-LD, headings, forms, links
    pages/  text/         raw HTML and visible text per page
    redirects.json        every redirect, chains collapsed, hops kept; shortlinks marked verified or not
    links.json            internal and external links, with the pages that carry them
    scripts.json          third-party vendors with their ids and pages
    media.json            every media file with sources, pages, status, type and bytes
    css/                  every stylesheet, inline <style> blocks, manifest.json; the sheets a
                          stylesheet @imports (any host, 5 levels deep) too, their manifest
                          entries with importedBy: [importer hrefs] and the importer's pages;
                          one deeper still is listed with status "too-deep", not fetched
    js/                   the site's own <script src> files (theme JavaScript) and manifest.json:
                          [{ file, src, pages }], or { file: null, src, pages, status } for a file
                          not saved (an HTTP status, "off-site" for a redirect off the host,
                          "too-large" over 5 MB); [] when the site has none
    templates.json        template clusters with a representative page each
    assets/               logo, icons, fonts, index.json
    screens/live/         live screenshots and manifest.json (gitignored)
    lighthouse-live/      Lighthouse reports, when run (gitignored)
    sitemaps/ feeds/ robots.txt wp-rest/ wayback-unverified.txt meta.json state.json
    README.md             the generated summary and its ## Notes

## What you write by hand

Under `## Notes` in `capture/README.md` (kept when the README is regenerated): every resume and
why; every URL recorded 403 and every `discoveryErrors` entry; the Wayback status from
`meta.json`, and whether the second pass ran (its results are generated); whether shortlinks were verified; seeds you passed and where they came from; media
hosts other than the site's own (a platform CDN) seen in `pages/`; every `bannerClosed`,
`heightMismatch` and `error` in `screens/live/manifest.json`; a template split or merge that looks
wrong; Lighthouse run or skipped; the platform oddities. Facts with paths, before the commit.

## Size, time and address limits

- Every request has a total timeout (30 s; media size checks 120 s; a download 6 hours, so a
  large file is in practice bounded by the 30 s idle timeout) and gives up after 30 s with no
  data. Downloads (media, fonts, PDFs) stream to disk; one larger than `--max-file-bytes`
  (`media`, `assets`; default 2 GB) is recorded `"too-large"` and not saved. Pages, stylesheets,
  sitemaps and REST lists are capped at 20 MB after decompression (`"too-large"`).
- A request to any host but the origin's own (stylesheets, fonts and icons on other hosts, a
  redirect to another host) is refused when the host resolves to a loopback, private,
  link-local or cloud-metadata address, and recorded `"blocked-address"`. The origin itself may
  be such an address (a local or staging copy).

## Platform references

| Fingerprint | Read |
|---|---|
| `wordpress` | `references/wordpress.md` |
| `drupal` | `references/drupal.md` |
| `webflow`, `squarespace`, `wix` | `references/webflow-squarespace-wix.md` |
| `static`, `joomla`, anything else | `references/static-and-unknown.md` |

`shopify` is a store and out of scope for conversion: stop and tell the person.

## Not covered

Repeat this list to the person verbatim. None of it was captured:

- Classes and states added by JavaScript after load (open menus, sliders); coverage runs later.
- CSS `@import` more than 5 levels below a linked stylesheet (listed `too-deep` in
  `css/manifest.json`, never fetched).
- Media on other hosts (platform CDNs, image services): not listed in `media.json`.
- A URL that answers 503 for good blocks the run until it recovers.
- Indexing directives from `<meta name="robots">` only; `X-Robots-Tag` headers are not read.
- Anything only a login, a form submission or a search reveals.
- A file over `--max-file-bytes` or a page or stylesheet over 20 MB (`"too-large"`), and
  anything on a host that resolves to a private address (`"blocked-address"`).
- A host whose DNS answer changes between the address check and the request.
- Requests made by the browser: the live screenshots and Lighthouse load pages in headless
  Chromium with no address guard, so a page's frames, images and scripts can reach a private
  address.
