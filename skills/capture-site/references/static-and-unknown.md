# Static, hand-written and unknown sites

Read this after `fingerprint.mjs` says `static` or `joomla`, or names a platform with no reference
of its own. The capture works the same way on every site: sitemaps (when there are any), the link
crawl, Wayback, and `--seed`.

## URL shape

Note whether URLs end in `.html`, `/` or neither, from the paths in `inventory.json`. The scaffold
matches the majority; the rest become redirects. Also note:

- `/index.html` and `/` both answering 200 (a duplicate the build turns into a redirect).
- Mixed case in paths: a static host is case-sensitive, an old Windows server may not have been.
- Pages that are real only with a query string (`page.php?id=3`, Joomla's
  `index.php?option=com_content&view=article&id=7`). The capture drops query strings by default;
  run it with `--include-query` when such pages exist, and say so in the notes.

## No sitemap

Many hand-written sites have none, so the crawl only finds what is linked from the home page down.
Wayback adds archived paths it did not find to `wayback-unverified.txt`. Ask the person for any
paths they know of (old campaign pages, PDFs sent by email) and pass each with `--seed`.

## Redirects that live in server config

`.htaccess` rewrites, server-side includes and redirects in the old server's config are only seen
when something requests the old URL. The crawl records those it meets in `redirects.json`. Ask the
person for the old `.htaccess` or server config if they have it: it may hold redirects no link
points to. Seed the old URLs from it so each is captured with its real chain.

## Joomla

A `Joomla!` generator. Search-engine-friendly URLs look like any other site; without them, every
page is an `index.php?...` query (use `--include-query`). Menu item ids (`Itemid=`) in links are
part of the URL the site serves.

## Templates

Without platform body classes, `templates.mjs` groups pages by markup (Jaccard at least 0.6,
body classes weighted double) as `template-<n>`. On a hand-written site every page may differ a
little; check that each representative is a fair example and note the paths that belong together.

## Anything else

A platform the fingerprint does not know (a headless front end, an in-house CMS) is captured as
static. Note the generator or the giveaway markers you see in `pages/`, any API the pages call
(from `scripts.json` and the HTML), and anything a page builds only in the browser: the capture
saves the HTML the server sent, not what script added afterwards.
