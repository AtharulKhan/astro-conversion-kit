# FAQ

## What does it refuse to do?

Rebuild anything that needs a server: site search, comments, carts and checkout, memberships and
logins, user-generated content. It reports them at intake with the options (a third-party embed,
keeping that part on the old platform under a subdomain, or a separate project). It also refuses
to run on end-of-life Node, to commit to your `main`, to log in to or submit forms on the live
site, to touch DNS, or to convert more than one site per run.

## How long does it take?

Mostly the crawl, which makes one request every 2.5 seconds by default: 100 pages take about four
minutes, and every media file, stylesheet, font and feed is one more request, so a site with 100
pages and 1,000 images takes closer to 45 minutes. The build and the visual review depend on how many distinct templates the site has more than on page
count. A small brochure site is usually a single sitting; larger sites are better run in sessions,
and the run resumes from its state file.

## Can I make the crawl faster?

The pace is there so the live site does not slow down or block you. If it is your own site and
your host can take it, `--delay` lowers it. If the site starts answering 429 or 503, the crawl
backs off on its own, and after three blocks in a row it stops and saves its place.

## What if the media library is huge?

Media stays in the repository only when the total is under 300 MB, no single file is over 25 MB
and there are fewer than 10,000 files. Over any of those, it goes to Vercel Blob or Cloudflare R2
and the host rewrites the original paths to the store, so no media URL changes. Every file the site
or its API knows about is carried, including image sizes nothing links to, because outside links
to them cannot be known. See [hosting.md](hosting.md).

## The site has a store. Can it convert?

The store pages cannot be static. The usual answer is to convert everything else and keep the shop
on its platform under a subdomain (`shop.example.com`), or to use a hosted checkout embed. The
plan lists the store URLs as out of scope and the redirects that would point at the new location.

## Can I redesign the site while converting?

Not in the same step. The default build reproduces the live site exactly, faults included, so the
gates can prove nothing was lost. Fixes and design changes go in as proposals that ship only in a
`PROPOSALS=on` build until you approve them. Once the converted site is live and gated, redesigning
it is ordinary Astro work, and the gates tell you exactly what each change touched.

## What happens to my forms?

Each form posts to a third-party form endpoint you choose at intake, with the same field names,
the same honeypot and the same thank-you page. One test submission goes to the address you give
at intake, never to an address found on the site. If you name no endpoint, the runbook lists it as
something you need to set up before launch.

## What about analytics and tag managers?

Every third-party script on the live site is found during capture and listed in
`docs/third-party.md` with the pages it was on. Each is kept or dropped with a reason. The gates
check that the kept ones are present and nothing else is, and `post-launch` checks that analytics
still fires after the cutover.

## What if my agent has no browser or cannot run subagents?

Nothing changes in what gets checked. Screenshots, pixel diffs and style checks are Node scripts
using Playwright's own Chromium. A built-in browser only helps the agent look at the contact sheet;
without one it reads the diff numbers and the failing style rows. Subagents only make the capture
and review faster.

## How do I resume a run that stopped?

Open a new session in the site repository and ask the agent to continue the conversion. It reads
`.conversion/state.json` for the phase, counts and decisions, and the capture resumes from its own
crawl state. A crawl that stopped because the site blocked it exits with code 3 and continues where
it stopped when run again.

## Does it work with sites that are not WordPress?

Yes. The capture reads rendered HTML, so Drupal, Joomla, Webflow, Squarespace, Wix and hand-written
sites convert the same way. Platform APIs, where they exist, only add sources. See
[platforms.md](platforms.md).

## What if I do not have a Vercel or Cloudflare account?

You still get the whole conversion: every gate, the visual review against a local preview, the
suggestions and a runbook. Deploying is then the runbook's first step, and the staging audit is
listed under "Not covered" until it runs.

## Will my search rankings survive?

The kit keeps what search engines see: every URL, title, description, canonical, robots directive,
structured data block, sitemap entry and redirect, checked by machine. It does not guarantee
rankings, and nobody can. The runbook has you export Search Console data before DNS moves and
`post-launch` watches for 404s and crawl errors for 30 days.

## Does the kit change the live site or DNS?

No. The live site is only read, at a slow pace, without logging in or submitting anything. DNS,
domains and the old host are changed by you, following the runbook.

## Can I run it on Windows?

Not in this version. Use macOS or Linux. WSL may work but is not tested.
