---
name: parity-gates
description: Freeze a site capture into baseline/ and prove an Astro build matches it — every route, redirect (one hop, through a simulation of the host), SEO head field, visible text, internal link, media file, sitemap entry, feed, form, third-party script and security header — with approved differences in exceptions.json and improvements in proposals.json. Use after a capture to build the baseline, when compiling redirects.csv for Vercel or Cloudflare, before calling any conversion page done, when a gate fails and needs reading, or to check a staging deploy against the baseline.
---

# parity-gates

Build the baseline once from `capture/`, then gate every build against it until every gate
passes. The gates read only `baseline/`, never the live site, so a build can still be verified
after the old host is gone.

## The golden rule

**The default build equals live, and a gate is never softened.** No flag turns a failure into a
warning. Four more that follow from it:

1. **Never edit `baseline/` by hand.** The one exception: `keep` in `baseline/scripts.json`,
   which is how a vendor is dropped (set it to `false`, and record the decision).
2. **A difference is an entry, not an edit.** Unavoidable: `exceptions.json`. An improvement:
   `proposals.json`, active only with `PROPOSALS=on`. Both are in `references/exceptions.md`.
3. **A skip is not a pass.** A gate that could not check something says `N skipped (reason)`
   on its summary line. Report every skip.
4. **Report a wrong gate as a kit bug; never change the gate in the site**, nor the baseline.

## Running the scripts

A site made by `convert-site` has the scripts in `scripts/`; run them from the site root as the
npm scripts below, options after `--`. Outside a scaffolded site, run the `node` form shown under
each step from the site root, where `<skill-dir>` is the absolute path of this skill's folder in
a copy of the kit where `npm install` has run. Every script prints `--help`; run it rather than
reading the source. Exit 0 pass, 1 failed gate or drift, 2 usage or missing input.

## 1. Baseline (once)

    npm run baseline
    node <skill-dir>/scripts/build-baseline.mjs --capture capture --out baseline    # fallback

It needs `capture/inventory.json`, `media.json` (capture's `media.mjs`) and `templates.json`
(`templates.mjs`), and exits 2 naming the step to run when one is missing. It writes
`baseline/{routes,seo,redirects,media,forms,scripts,meta,counts}.json` and `baseline/text/`, and
`redirects.csv` at the site root. A shortlink with no target is left out and named on stderr.
Commit `baseline/` and `redirects.csv` together. `--check` recounts `baseline/` against
`counts.json` (exit 1 on drift). Every file's shape is in `references/contracts.md`.

## 2. Redirects

`redirects.csv` (`from,to,status,source,note`) is the single source of the site's redirects.
`source` is `crawl`, `sitemap`, `shortlink` or `seed` from the capture; a row you add is
`decision`, its `note` naming the decision id. Never hand-edit the compiled output; compile:

    npm run redirects:build
    node <skill-dir>/scripts/build-redirects.mjs --csv redirects.csv --host vercel --out vercel.json --trailing-slash always    # fallback

`--host cloudflare --out public/_redirects` for Pages (Astro copies it into `dist/`). Vercel: the
`redirects` key is replaced, every other key kept, and `trailingSlash` is removed and written as
the compiler's own 308 slash rules after the site's, so an unslashed source is still one hop.
Cloudflare: a query row (`/?p=7`) cannot be matched by `_redirects` and goes to
`cloudflare-query-redirects.csv`, to be created as a Single Redirect (a "needs you" item). A
query row whose target is its own path (`/?p=2` to `/`) is a no-op and is left out on both hosts.

## 3. Verify

    npm run build
    npm run verify -- --endpoint https://forms.example.com/f/abc --thank-you /thank-you/
    node <skill-dir>/scripts/verify/run-all.mjs --endpoint https://forms.example.com/f/abc --thank-you /thank-you/    # fallback

`run-all` runs the ten gates in alphabetical order, gives each one only the options it accepts,
and stops at the first failure. Shared options: `--paths` (comma list, `*` matches anything),
`--json`, `--origin` (links, seo, sitemaps: the host the build is for), `--allow-extra` (routes),
`--endpoint`, `--honeypot`, `--thank-you` (forms; `--endpoint` is required when the baseline has a
form), `--host`, `--config`, `--csv` (redirects), `--media-plan` (media). Fix the first failure,
rebuild, rerun. One gate alone: `node <skill-dir>/scripts/verify/<gate>.mjs`.

| Gate | Passes when | A skip means |
|---|---|---|
| `forms` | Each live form is on its page with the same field names in order, method, and action set to `--endpoint`; `--honeypot` on every form | No `--thank-you`: the thank-you page was not checked |
| `headers` | Host config sends nosniff, Referrer-Policy, X-Frame-Options or CSP frame-ancestors, and `X-Robots-Tag: noindex` on every path; with `PUBLIC_INDEXABLE=true` noindex is forbidden | |
| `links` | Every internal href and src resolves to a built page or file, a redirect source or baseline media; `/about` where the build serves `/about/` fails | |
| `media` | Every baseline media file is in `dist/` (or the store manifest) with the same bytes | Plan mode `live-temporary`: served from live, nothing checked |
| `redirects` | Every baseline redirect and csv row answers in one hop with the same status, and the target answers 200 in `dist/` (or is external); no source is also a built file | A no-op query row, or any query row on Cloudflare |
| `routes` | Every page, post, archive and feed at 200 is built, noindex routes still say noindex, nothing extra is built (the capture's own scripts in `baseline/js.json`, at their live paths, and the launch icon set are not extras) | |
| `scripts` | Each kept vendor is on exactly its live pages with the same ids; a dropped one on none; no new vendor | |
| `seo` | Title, description, canonical, robots, lang, h1, h2, og and JSON-LD @types equal per page; site URLs on the site's origin | |
| `sitemaps` | The sitemap lists exactly the indexable 200 pages on the origin; every feed is built with as many items | |
| `text` | Each page's visible text equals `baseline/text/` (word diff, 5 words of context) | |

## 4. Differences and decisions

When the build cannot or should not match live, read `references/exceptions.md`. In short: an
entry is `{ path, field, from, to, reason, approvedBy, date }`; `from: ""` records a value the
build adds, `to: ""` one it removes; an exception that no longer matches, or names a path the gate
does not check, **fails** the gate. Every oddity on the live site (a missing H1, a dead tag, a
broken link) is reproduced by default and gets a decision row (id, topic, choice, default,
reason, cost if wrong) saying so and what the fix would be.

## 5. Staging, proposals and release builds

`PUBLIC_INDEXABLE` and `PROPOSALS` change what Astro builds, so set them on the **build**, not
only on the gate run; a gate run on a build made without them checks the wrong site. Pass
`--origin` only when the build itself was made for that host; a scaffolded build's `site` is the
live origin, so its canonicals and sitemap stay on it.

    npm run build && npm run verify -- --endpoint ... --thank-you ...                                       # staging
    PROPOSALS=on npm run build && npm run verify:proposals -- --endpoint ... --thank-you ...                 # proposals
    PUBLIC_INDEXABLE=true npm run build && npm run verify:release -- --endpoint ... --thank-you ...          # release

After a staging deploy, check it over HTTP against the baseline (the bypass value from the
environment, never pasted in chat). A release deploy is checked the same way without
`--expect-noindex`:

    npm run verify:live -- --base https://my-site.vercel.app --expect-noindex --bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"
    node <skill-dir>/scripts/verify-live.mjs --base https://my-site.vercel.app --expect-noindex --bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"    # fallback

It checks every baseline route at 200 (or a `--sample`), every redirect in one hop with the same
kind of status, noindex on pages iff `--expect-noindex`, the sitemap, and 20 media files by
bytes (or `--media-manifest`). Exit 3 means it was blocked: wait and rerun. A failure marked
`unverified live` is a shortlink the capture never requested.

## Present the result

1. **Every gate's summary line**, failures first, with the failing lines quoted.
2. **Every skip**, with its count and reason: none of it was checked.
3. **Every exception and proposal** with its reason, and every `keep: false` vendor.
4. **Every decision row** added in this run, and every `decision` row in `redirects.csv`.
5. **Not covered, verbatim**: the list below, every line, in the PR and in your report.

## Not covered

Repeat this list to the person verbatim. No gate checks any of it:

- Content rendered by JavaScript after load: the gates read the built HTML only.
- Hover, focus and open states (menus, sliders, accordions).
- Headers on a route served by a Function (a media store route): the headers gate reads config.
- Media served from the live site in staging (`live-temporary`): skipped, not compared.
- Shortlinks the capture did not request: their targets are unverified until `verify-live` passes.
- Whether a form submission is delivered: the forms gate checks markup only.
- `feed/index.xml` is checked in `dist/`; on Vercel, `/feed/` may need a rewrite to serve it.

## References

| File | Covers |
|---|---|
| `references/contracts.md` | Every baseline file's shape, `redirects.csv`, the gates' `--json` output |
| `references/exceptions.md` | Exceptions, proposals, `PROPOSALS=on`, reproduce live by default, decision rows |
