# Hosting

The build is plain static files in `dist/`, so any static host can serve it. Only three things are
host-specific: redirects, response headers, and how media outside the repository is reached. All
three are generated from files in the site repository (`redirects.csv`, the headers template and
`docs/media-plan.json`), so switching host means regenerating config, not rebuilding the site.

The kit supports two hosts directly: Vercel (the default) and Cloudflare Pages. It writes their
config files and the runbook commands. It never changes DNS, domains or dashboard settings.

## The indexable switch

Every build is `noindex, nofollow`, with a robots.txt that disallows everything, unless the build
runs with `PUBLIC_INDEXABLE=true`. Only the production build sets it. Previews stay noindexed
whatever the host's protection settings are, so a leaked staging link does not get indexed.
`npm run verify:release` runs the gates on an indexable build before launch.

## Vercel

**Project.** A static project with no framework adapter. `npx vercel deploy` makes a preview;
`npx vercel deploy --prod` deploys production.

**Indexing.** Set `PUBLIC_INDEXABLE` for the Production environment only:
`npx vercel env add PUBLIC_INDEXABLE production` with the value `true`. Never set it for Preview.

**Redirects.** `npm run redirects:build` writes the `redirects` array in `vercel.json` from
`redirects.csv`. Vercel's `permanent: true` answers 308; where the live site answered 301, the
entry needs an explicit `statusCode`, and the redirect gate shows any mismatch. Vercel caps how many routes `vercel.json`
can hold (2,048 at the time of writing); a larger set needs the project's bulk redirects, and the
runbook says so when the count is over.

**Headers.** `vercel.json` ships a baseline: `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`, and a one-year
immutable cache on `/_astro/*`. Add a Content-Security-Policy yourself once you know which
third-party scripts stay; a wrong one breaks forms and analytics silently.

**URL modes.** The scaffold matches the live site's majority URL form:

| Live URLs look like | Astro | `vercel.json` |
|---|---|---|
| `/about/` | `trailingSlash: 'always'`, `build.format: 'directory'` | slash rules adding `/` |
| `/about` | `trailingSlash: 'never'`, `build.format: 'file'` | `"cleanUrls": true`, slash rules removing `/` |

`vercel.json` carries no `trailingSlash` key: Vercel applies it before `redirects`, so every
unslashed redirect source would take two hops. `npm run redirects:build` writes the same 308
normalisation as the last entries of `redirects`, after the site's own rules. A query row whose
target is its own path (`/?p=2` to `/`) is left out: Vercel passes the query on, so it would
redirect to itself. `cleanUrls` serves
`about.html` at `/about` and redirects `/about.html` there; it is never combined with the directory
format. URLs in the minority form become rows in `redirects.csv`.

**Media in Blob.** When the media decision is "store", files are uploaded to a public Vercel Blob
store by `media-upload.mjs` (it reads `BLOB_READ_WRITE_TOKEN` from the environment and checks every
upload's size), and `vercel.json` gets a rewrite from the media prefix (for example
`/wp-content/uploads/:path*`) to the store. The public URLs stay the same.

**Deployment protection.** Vercel protects preview deployments by default, so visitors (and
scripts) get a login page. Vercel's Protection Bypass for Automation lets a script through with a
secret header, but `launch-audit` cannot send that header yet. So the choice is: open the preview
to the public for the audit (it is still noindexed), or keep it protected and accept that the
staging audit appears under "Not covered" until it can run. Keep previews of sites you do not own the
content of protected.

## Cloudflare Pages

**Project.** Deploy with wrangler from your machine or CI:

```
npm run build
npx wrangler pages deploy dist --branch astro-rebuild
```

That gives a preview at `astro-rebuild.<project>.pages.dev`. Production is
`PUBLIC_INDEXABLE=true npm run build && npx wrangler pages deploy dist --branch main`, which deploys
to production only when the project's production branch is `main` (check it in the Pages project
settings). The first deploy has to name the project, with `--project-name <name>` or a
`wrangler.toml` holding `name` and `pages_build_output_dir = "dist"`. Because
wrangler uploads the local `dist/`, the indexable switch belongs on that local build, not in the
Pages dashboard.

**Redirects.** `npm run redirects:build` writes `public/_redirects` from `redirects.csv`; Astro copies it
into `dist/`, which is what wrangler uploads and what the redirect gate reads. Each line is
`source destination status`; Pages treats a line with no status as a 302, so every line must carry
the code the live site used. Pages allows 2,000 static and 100 dynamic redirects (dynamic means a
splat or a placeholder). Beyond that, the rest belong in Cloudflare Bulk Redirects, an account-level
list set up in the dashboard; the runbook points you there when the count is over. `_redirects`
cannot match a query string, so query rows (WordPress `/?p=7` shortlinks) go to
`cloudflare-query-redirects.csv` beside `redirects.csv`, each to be created as a Single Redirect
(a rule on `http.request.uri.query`); the redirect gate lists them as skipped.

**Headers.** `public/_headers` (copied into `dist/` by the build) carries the same baseline as Vercel: `nosniff`, the referrer policy,
`SAMEORIGIN` framing, and an immutable cache on `/_astro/*`.

**URL modes.** Pages serves `about/index.html` at `/about/` and redirects `/about` to it, and serves
`about.html` at `/about`. Its automatic redirects are 308s; if the live site used 301 for the same
pair, the redirect gate shows the difference, and accepting it is an entry in `exceptions.json`.

**Media in R2.** When the media decision is "store", files go to an R2 bucket through its
S3-compatible API (`media-upload.mjs --store r2`, reading `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` and `R2_BUCKET` from the environment), keyed by their site path. Pages cannot
rewrite to another origin, so the kit ships a small Pages Function that serves the media prefix
from the bucket. This is the one place the converted site runs code at the edge, and only when
media is over the repository threshold; with media in the repository there is no function at all.
The runbook spells out the steps:

1. Copy [the function template](../skills/convert-site/templates/cloudflare/r2-media-function.js)
   to `functions/<prefix>/[[path]].js` in the site repository, with the prefix's leading slash
   dropped (for example `functions/wp-content/uploads/[[path]].js`). It answers GET and HEAD, looks
   the path up in the bucket, returns 404 when it is missing, and otherwise returns the file with
   its stored content type, its etag, `x-content-type-options: nosniff` and
   `cache-control: public, max-age=31536000, immutable`; a path that does not decode is a 404.
   `_redirects` and `_headers` do not apply on a Pages Function route, so a redirect row under the
   media prefix needs handling in the function or a step in the runbook.
2. Bind the bucket to the Pages project as `MEDIA`: in the dashboard (the project's settings,
   Bindings, R2 bucket), or in `wrangler.toml` with `[[r2_buckets]]`, `binding = "MEDIA"` and
   `bucket_name = "<bucket>"`. `wrangler pages deploy` uploads `functions/` along with `dist/`.
3. After the deploy, request one media URL on the new site and confirm it returns 200 with the
   right content type and size.

**Preview access.** Pages previews are public by default. Put Cloudflare Access in front of them if
the content should not be seen; the same "Not covered" note as Vercel applies to the staging audit.

## No media store yet

If media needs a store and there are no store credentials, `media-plan.mjs --mode live-temporary`
serves media from the live site, for staging only: a `vercel.json` rewrite on Vercel, a 302 line
in `_redirects` on Cloudflare Pages. The plan carries a warning, and the runbook
puts "create the store and upload" before the DNS step. Do not launch in this mode: when the old
host goes, the media goes with it.

## Other static hosts

Netlify, GitHub Pages, S3 with CloudFront and similar serve `dist/` unchanged. Redirects and
headers have to be written in that host's format from `redirects.csv` by hand, and the redirect
gate should be run against the deployed preview to prove them.
