# Build rules

Binding for every page, layout and file in the site. The capture is the source; the default build
equals live, faults included. When a rule here and a gate disagree, the gate is right about
parity and this file is wrong: say so and fix this file.

## Structure

- **Layouts and shared parts are always components.** One layout per template in
  `src/layouts/<Template>.astro`, built on `Base.astro`. The header, navigation and footer are
  `src/components/Header.astro`, `Nav.astro`, `Footer.astro` (plus any other block every page of
  a template shares, such as a sidebar), each holding the captured markup of the representative
  page, copied, not retyped.
- **Content blocks are the captured markup.** A page's main content is moved from
  `capture/pages/<slug>.html` by a script, never by hand: a small Node script in the site (for
  example `tools/extract-content.mjs`, using `parse5`) cuts each page's content region and writes
  it to `src/content/pages/<slug>.html`; each template's route (for example
  `src/pages/[...path].astro` with `getStaticPaths` over `baseline/routes.json`) renders it with
  `<Fragment set:html={html} />` inside the template's layout. The content region is found by
  the same selector for every page of a template; a page that does not fit means the template
  split is wrong, not that the page needs special casing.
- **Head tags from the baseline.** Title, description, canonical, robots, `lang`, Open Graph,
  Twitter and JSON-LD come from `baseline/seo.json` per path (JSON-LD as captured, in
  `<script type="application/ld+json" set:html>`). The body class and `<html>` attributes are
  copied from the captured page.
- **No retyping, no tidying.** Text, headings, alt text, link text, whitespace inside `<pre>`,
  entities and odd markup stay as captured. A typo is reproduced and goes in the suggestions.
- **Components beyond the shared parts** are the optional pass (`components-optional.md`),
  after the visual review, never during the build.

## CSS

- Coverage first, then prune: `capture/css-coverage.json` (phase 2) and `css-prune.mjs` into
  `src/styles/site.css`, imported once by `Base.astro`. The pruned file is the stylesheet; it is
  never rewritten, reformatted or "cleaned up". The used rules of the head's `<style>` blocks
  (WordPress emits several per page) are in it, each page's set under a comment naming its pages.
  A captured `@import` is replaced by the imported sheet's pruned rules in place; one whose
  target was not captured stays an `@import` and is listed under `unresolvedImports` in
  `.conversion/css-prune-report.json`: check each one loads from the new site or restore its
  rules. Exit 1 means a stylesheet file (`unmatched`) never appeared in coverage and was kept
  whole: re-run coverage on the pages that link it.
- **One stylesheet for every template** is the v0.1 default, recorded as a decision in the plan
  (topic "one pruned site.css", default "one file", cost if wrong "each page loads rules other
  templates use"). Splitting it per template is an improvement the suggestions report may
  propose, never part of the default build.
- A diff caused by pruning (a state the coverage run never saw: an open menu, a JavaScript-added
  class) is fixed by restoring the original rule from `capture/css/`, copied as written, into
  `src/styles/restored.css` with a comment naming the source file. New CSS is allowed only for a
  difference the static build creates itself (a script that no longer runs), each rule with a
  comment and a decision id.
- Inline `style` attributes and `<style>` blocks in the captured content stay where they are.

## Media and fonts

- **Original paths, always.** Mode `repo`: copy the capture's download into `public/` so every
  file is at its site path (`cp -R .conversion/media-cache/. public/`), every file the capture
  listed, referenced or not
  (WordPress image sizes included). Mode `store` or `live-temporary`: nothing under the media
  prefix goes in `public/`; the host file says how the prefix is reached. In every mode, files
  outside the media prefix are copied to `public/` at their live paths (the media gate checks
  them in `dist/`).
- **Optimiser suffixes are separate files.** `-scaled`, `-e1612345678`, `photo.jpg.webp`,
  `-300x200`: each variant is kept at its own URL. `?ver=` query strings on assets stay in the
  markup as written; the static host ignores them.
- **Lazy images.** Where the live markup holds the real source in `data-src`, `data-srcset` or
  `data-lazy-src` and a script swaps it in, the build writes that value into `src` (and `srcset`)
  so the image shows without the script; the `data-*` attributes stay as captured.
- **Fonts self-hosted.** Every font in `capture/assets/` is served from the site at its original
  path (same-origin fonts) or under `/fonts/` (fonts the live site loaded from a font service),
  with the same families, weights and styles. Replacing a font service link with local
  `@font-face` rules is a decision row; the visual review proves it.
- Logo, favicon, apple-touch-icon and the web manifest from `capture/assets/`, same paths.

## Scripts

- Third-party scripts follow the `keep` allowlist (`third-party.md`).
- Same-origin theme and plugin scripts are in the capture (`capture/js/`, listed in
  `baseline/js.json`). The default is to copy each one that drives visible behaviour (a lazy
  loader, a menu toggle, a scroll reveal, a slider), and the vendor library it needs, to its
  live path under `public/`, so the captured `<script src>` tags keep working; the routes gate
  allows those paths. Rebuilding one as a small inline script against the same markup, or
  dropping it, is a decision row per script.
- Scripts that do nothing on a static site (`wp-emoji`, `admin-bar`, `comment-reply`,
  `wp-embed` and the like) are dropped by default, with their `<script>` tags, under one decision
  row for the set.

## Redirects

- `redirects.csv` (from, to, status, source, note) is the single source. `npm run baseline`
  writes it from the capture; a redirect you add (a duplicate slug, a `.html` form, an old URL
  from the intake) is a row with `source` `decision` and the decision id in `note`.
- A URL the live sitemap lists but live answers 404: redirect it to the nearest live parent, or
  the posts archive for a post, as a decision row, because pre-launch requires every predecessor
  URL to resolve.
- `npm run redirects:build` writes `vercel.json` `redirects` or `public/_redirects`. Never edit
  the generated rules by hand. Every chain becomes one hop to the final target. It also writes a
  rewrite per feed (`/feed/` to `/feed/index.xml`, from `baseline/routes.json`), since neither
  host serves `index.xml` for a directory path.
- A static page at a redirect source fails the redirects gate: delete the page or the row.

## Sitemaps, feeds, robots, 404

- Sitemaps and feeds are endpoints at the live URLs (`src/pages/sitemap_index.xml.js`,
  `feed/index.xml.js`, …) generated from `baseline/routes.json` and `capture/feeds/`, never
  hand-typed. The sitemaps gate decides what they must list.
- `src/pages/robots.txt.js` stays as scaffolded; replace its indexable body with the captured
  `capture/robots.txt` (sitemap URLs adjusted only if their file names changed).
- `src/pages/404.astro` holds the captured 404 page's markup in its layout.

## What is never fixed in the build

Shortcode leftovers (`[gallery]`), placeholder text, broken links, missing alt text, duplicate
titles, missing H1s, dead tags: reproduced as live, written to the suggestions. Fixing one is a
proposal. (Redirect chains are the exception the gates require: each becomes one hop.)
