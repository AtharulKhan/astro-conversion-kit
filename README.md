# astro-conversion-kit

A set of Agent Skills that turn a live website into a static Astro site that matches it: the same
URLs, the same content, the same titles, descriptions, canonicals and structured data, the same
media at the same paths, every redirect the old site performs, and a design checked pixel by pixel
at 390, 768 and 1440 px. Your coding agent runs it. Plain Node scripts do everything that has to be
exact, and gates prove each part before the work moves on. It ends with a pull request, a noindexed
staging deploy and a launch runbook. WordPress is the best-supported case; anything served over
HTTP works, because the capture reads rendered HTML.

## Start

Paste this into your coding agent, with your site in place of example.com:

```
Convert https://example.com to Astro with https://github.com/ethanplusai/astro-conversion-kit
```

The agent installs the skills, asks you one message of questions (each with a stated default),
and runs to a pull request without stopping again.

To install the skills yourself first, into any agent that reads Agent Skills:

```
npx skills add ethanplusai/astro-conversion-kit
```

Or in Claude Code, from its plugin marketplace:

```
/plugin marketplace add ethanplusai/astro-conversion-kit
/plugin install astro-conversion@astro-conversion-kit
```

Or use the skills straight from a clone:

```
git clone https://github.com/ethanplusai/astro-conversion-kit
cd astro-conversion-kit
npm install
npx playwright install chromium
node skills/convert-site/scripts/preflight.mjs
```

`preflight.mjs` reports which tools the run needs (Node, git, gh, the hosting CLI, the Playwright
browser) and whether each is installed and logged in. Every script prints `--help` and runs on its
own, so any step can be run by hand:

```
node skills/capture-site/scripts/fingerprint.mjs https://example.com
node skills/capture-site/scripts/capture.mjs --help
```

[AGENTS.md](AGENTS.md) tells an agent which skill to use when.

## What happens

1. **Intake.** At most four requests fingerprint the platform; one message asks you where the
   repo and hosting go, how forms are handled, and what the agent cannot detect.
2. **Capture.** A paced, read-only crawl (sitemaps, platform APIs, links) saves every page's HTML,
   head tags, redirects, media list, fonts, feeds and screenshots into `capture/`.
3. **Plan.** `docs/plan.md`: templates, counts, the media decision, and a row for every oddity.
4. **Scaffold and baseline.** A new Astro repo on an `astro-rebuild` branch, with the capture
   frozen into `baseline/` so the gates never need the old site again.
5. **Build.** Layouts first, then pages from the captured markup, the captured CSS pruned by
   coverage, media at the original paths, forms and third-party scripts carried over by list.
6. **Gates.** Routes, redirects, SEO tags, visible text, links, media, sitemap, feeds, forms and
   scripts, checked against the baseline on every commit.
7. **Visual review.** Live and new screenshots per template at three widths, pixel-diffed, plus a
   computed-style check, until every pair passes; then every page at 390 and 1440.
8. **Launch checks.** `pre-launch` on the repo, a staging deploy, `launch-audit` against staging,
   a suggestions report, and the PR. You merge and launch; `post-launch` watches the first 30 days.

[docs/process.md](docs/process.md) says what each phase produces and what proves it done.

## What you get

- A pull request from `astro-rebuild` to `main` in a repo you own, with the gate output, counts,
  every exception and proposal, and the launch skills' "Not covered" sections quoted in full.
- A noindexed staging deploy on Vercel or Cloudflare Pages (or a local preview and a first
  runbook step to deploy, if you have no hosting account yet).
- Contact sheets: live, new and diff screenshots side by side for every template and width.
- `docs/suggestions.md`: broken links, missing alt text, duplicate titles, slow images and other
  improvements the agent found but did not make, each with evidence, effort and risk.
- `docs/LAUNCH.md`: the runbook, in order, with the exact commands for your host.
- `npm run verify` in the new repo, so the gates keep working after the old site is gone.

The default build reproduces the live site, faults included. Fixes are proposals you approve.

## Examples

Real conversions, with their contact sheets, gate output and suggestions, are added here soon.

## What it refuses

The output is static files, so the kit does not rebuild features that need a server:

- site search, comments, carts and checkout, memberships and logins, user-generated content.

These are found at intake and reported as out of scope, with the options: a third-party embed,
keeping that part on the old platform under a subdomain, or a separate project. Forms are the one
exception: they post to a third-party form endpoint you choose.

It also refuses to run on end-of-life Node, to submit forms or log in on the live site, or to
touch DNS. One site per run. Apart from the scaffold commit that init-site makes on a new or empty
repository, nothing is committed to `main`; all work goes on `astro-rebuild` and reaches `main`
through a pull request you merge.

## Security

The converted site is static HTML, CSS, images and the scripts you keep. There is no PHP and no
Node running on your server, so a PHP or Node.js runtime vulnerability has nothing to attack there.

That is not the whole story:

- The build tooling runs Node on your machine and in CI, and it has to stay patched. The kit
  refuses Node 20 and other end-of-life versions.
- Form handlers, analytics, tag managers and chat widgets are third-party scripts you choose to
  keep. Their security is their vendor's.
- TLS and security headers are handled at your host's edge. The kit ships a baseline set in
  `vercel.json` or `_headers`.
- One optional exception: on Cloudflare Pages, when media is too large for the repository, a
  small Pages Function serves it from R2. It is the only code that runs at the edge.

More in [docs/security.md](docs/security.md).

## Requirements

- Node 22.23.4 or newer on the 22 line, or 24.22.1 or newer. Node 20 is end of life and refused.
- git, and a GitHub account with `gh` logged in if you want the repo and PR created for you.
- A Vercel or Cloudflare account for staging and production. Optional for the conversion itself.
- Playwright's Chromium (`npx playwright install chromium`), for screenshots and visual review.
- macOS or Linux. Windows is not supported in this version.
- A coding agent that can run shell commands. If your agent has its own browser or can run
  subagents, the skills use them; without them every step still runs.

Further reading: [hosting](docs/hosting.md), [platforms](docs/platforms.md),
[dependencies](docs/dependencies.md), [FAQ](docs/faq.md).

## Licence

MIT. See [LICENSE](LICENSE).
