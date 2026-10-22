# Suggestion checks

One row per check in `scripts/checks/`. Effort and risk are the defaults each item starts with;
"applyable" means `convert-site --apply <id>` can make the change mechanically. Every check
reads the capture and baseline only; none of them requests the live site or changes anything.

Item shape: `{ id, path, element?, evidence, why, effort, risk, applyable, pages? }`. One
problem repeated across a site (a script, an image, a link, a title) is one item: `path` is the
first page it appears on, the evidence names the page count and the first three pages, and
`pages` lists every page it applies to (in the JSON; the markdown keeps the short evidence). The
grouped checks, which always fill `pages`, are `render-blocking-scripts`, `missing-alt`,
`http-links`, `mixed-content`, `oversized-images` and `duplicate-titles`.

| id | category | what it looks for | evidence | effort | risk | applyable |
|---|---|---|---|---|---|---|
| `missing-h1` | seo | 200 pages with no `<h1>` | inventory `h1[]` | S | low | no |
| `multiple-h1` | seo | 200 pages with more than one `<h1>` | the h1 texts | S | low | no |
| `duplicate-titles` | seo | indexable pages sharing a `<title>`, one item per title | the title and its pages | S | low | no |
| `missing-descriptions` | seo | indexable pages with no or an empty meta description | inventory `description` | S | none | no |
| `long-titles` | seo | titles over 60 characters | length and title | S | low | no |
| `orphan-pages` | seo | indexable pages no crawled page links to; pages in no sitemap linked from only one page | `links.json` inbound links, `foundBy` | S | none | no |
| `noindex-in-sitemap` | seo | noindex pages the sitemap lists | robots value, `foundBy` | S | low | yes |
| `thin-pages` | content | indexable pages under 150 words, leaving out the home page, archives, pages with a form and thank-you, confirmation, privacy and terms pages | `wordCount` | M | none | no |
| `stale-dates` | content | posts whose modified (or published) date is over 3 years old | the date and its age | M | none | no |
| `shortcode-leftovers` | content | WordPress shortcodes printed as text (`[gallery ids="…"]`, page-builder tags) | the shortcode text | M | low | no |
| `placeholder-text` | content | lorem ipsum, "Hello world!", "Sample Page", TODO/TBD, unfilled `{{merge}}` tags | a snippet around the match | S | none | no |
| `broken-links` | links | internal links and sitemap entries that answer 4xx/5xx, plus any `links.json` `broken` list | status and linking pages | S | low | no |
| `redirect-chains` | links | redirects with intermediate hops | the chain from `redirects.json` `hops[]` | S | low | yes |
| `http-links` | links | external links written `http://`; on an https site, an http canonical or og:url | the links | S | low | yes |
| `missing-alt` | accessibility | `<img>` with no alt attribute (an empty alt is decorative and passes) | the image src and size | S | none | no |
| `oversized-images` | performance | images over 300 KB (needs `media.json`), or shown at under half their natural width with no srcset candidate within 1.5× the shown width; Lighthouse responsive/optimised image audits | bytes from `media.json`, width from the size suffix or srcset | S | low | yes |
| `no-webp` | performance | JPEG or PNG files used on pages with no modern format | content type, size, pages | S | low | yes |
| `render-blocking-scripts` | performance | external `<head>` scripts without async or defer; Lighthouse render-blocking-resources | the script src | S | medium | yes |
| `mixed-content` | security | https pages loading http images, scripts, styles or iframes | the insecure URLs | S | medium | yes |
| `missing-security-headers` | security | failing Lighthouse has-hsts, csp-xss, clickjacking-mitigation, origin-isolation; missing headers when a record carries `headers` | audit titles or header names | S | medium | yes |
| `dead-analytics` | analytics | a measurement vendor (gtm, ga4, meta-pixel, hotjar, clarity, hubspot, intercom, crisp, tawk) loading with no id; embeds such as YouTube, Vimeo, Maps and reCAPTCHA are never reported | `scripts.json` vendor, pages | S | low | yes |
| `duplicate-analytics` | analytics | one vendor reporting to two ids on a page, or the same tag script loaded twice | the ids or the script | S | medium | yes |
| `inconsistent-spacing` | design | the same selector with different margin, padding or gap on different templates at one width | live values per template from `review/styles.json` | M | medium | no |
| `mobile-overflow` | design | a screenshot wider than its viewport (horizontal scroll) | PNG width from `review/new/manifest.json` shots | M | low | no |

Not covered: a check that throws is listed as "check failed: <message>" and the rest still run.
`no-webp` and the size half of `oversized-images` need `media.json`; `inconsistent-spacing` and
`mobile-overflow` need `--review`; `missing-security-headers` needs Lighthouse reports with the
best-practices audits, or captured headers. Without them the report lists the check (or the
missing part) under "Not covered", which is not a pass.
