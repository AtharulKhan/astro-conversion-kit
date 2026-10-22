---
name: convert-site
description: Convert a live website (WordPress first; Drupal, Webflow, Squarespace, Wix and static sites too) into a static Astro site with the same URLs, content, head tags, media, redirects and look, proven by parity gates and a pixel-level visual review, ending in one pull request, a noindexed staging deploy and a launch runbook. Use when asked to convert, rebuild, migrate or clone a site to Astro, when handed a site URL with this kit's link, to resume a conversion from .conversion/state.json, or with --apply <id> to apply one suggestion as a proposal.
---

# convert-site

The orchestrator. It asks one message of questions, then runs every other skill in order without
stopping again, and ends with a pull request the person merges and a runbook they launch from.

## The golden rules

1. **One intake message, then no stops.** Every question carries a default. Anything that later
   needs an account, a login or a token you do not have goes on the "needs you" list
   (`state.needsYou` and `docs/LAUNCH.md` section A) and the run carries on.
2. **The live site is read-only.** Only the capture scripts touch it, paced. Never submit a form
   on it, log in, or fetch a page by hand to fill a gap.
3. **The default build equals live, faults included.** Content is moved from captured markup,
   never retyped or tidied. Every oddity is a decision row that says "reproduce live by default".
   A forced difference is an exception; an improvement is a proposal (`PROPOSALS=on` only).
4. **Gates on every commit, never softened.** Never edit `baseline/` to pass (only the `keep`
   flags in `baseline/scripts.json`). A skip is not a pass; "Not covered" is never a pass.
5. **`main` gets the scaffold commit and nothing else.** All work is on `astro-rebuild`, one PR.
   Never force-push, never merge, never touch DNS, the old host or a dashboard setting.
6. **No secrets in chat or in the repository.** Never ask the person to paste a token.
   Credentials come from the environment or a CLI's own login.

## Names used below

`KIT` is the absolute path of this kit (the folder holding `skills/`, with `npm install` run).
`LIVE` is the live origin. `SITE` is the absolute path of the new site repository (default
`<current folder>/<slug>`). `WORK` is `<SITE>-work`, where the capture lives until the scaffold
exists (init-site only fills an empty folder). Run every command from `SITE` (or `WORK` before
the scaffold). Every script prints `--help`; run that rather than reading the source.

## Step 0: preflight and fingerprint (before the intake message)

    node $KIT/skills/convert-site/scripts/preflight.mjs --json
    node $KIT/skills/capture-site/scripts/fingerprint.mjs $LIVE

Install what is missing that you can install yourself, without asking: `npx playwright install
chromium` when `playwright.chromium` is false; `vercel` and `wrangler` run through `npx`. A CLI
that is present but not logged in is the person's to log in: name the command (`gh auth login`,
`npx vercel login`, `npx wrangler login`) in the intake message and check again at the scaffold.

`experience` sets how you talk, not what you do. `new`: one plain sentence per phase on what it
does and why, every term explained once, installs done silently. `some`: one line per phase.
`experienced`: commands and results only. A Shopify fingerprint is a store: stop and say so.

## Step 1: intake (the one message)

Send `references/intake.md`'s template, filled in with what preflight and the fingerprint found:
every question with its default, and the "what is missing and what happens" list. If the person
does not answer, the defaults stand. Never send a second question message.

## The phases

`references/phases.md` has every command and the proof each phase is done. At each boundary run
`node $KIT/skills/convert-site/scripts/state.mjs --dir <SITE or WORK> phase <name>`; do not
start a phase until the previous one's proof holds. Run `state.mjs` calls one at a time.

| # | Phase (`<name>`) | What happens | Done when |
|---|---|---|---|
| 1 | `intake` | Preflight, fingerprint, the one message | Answered, or defaults stand |
| 2 | `capture` | Capture into `WORK`: capture, media, templates, assets, live shots, CSS coverage | `capture/README.md` written with Notes; every URL saved or recorded with its status |
| 3 | `scaffold` | Repo, `init-site.mjs`, move `WORK` in, commit the capture on `astro-rebuild` | `npm run build` passes on the empty site; `main` holds one commit |
| 4 | `plan` | `docs/plan.md`, `docs/DECISIONS.md`, `media-plan.mjs` | Every template, count, oddity and out-of-scope feature has a row |
| 5 | `baseline` | `templates.mjs` already ran, then `npm run baseline` | `build-baseline.mjs --check` exits 0 |
| 6 | `templates` | Layouts, header, nav, footer, one representative page per template, CSS pruned, media, fonts, forms, scripts, redirects | `npm run verify -- --paths <representatives>` exits 0 |
| 7 | `design-lock` | Visual review of every template at 390, 768, 1440 | `review:diff` and `review:styles` exit 0 for the template set |
| 8 | `rollout` | Every page from captured markup | `npm run verify` exits 0 on the full build |
| 9 | `visual-all` | Every page at 390 and 1440 | `review:diff` exits 0 for the full set |
| 10 | `components` | Optional, off by default (`references/components-optional.md`) | Gates and diffs still pass, one separate commit |
| 11 | `prelaunch` | `pre-launch`, staging deploy, `verify-live`, `launch-audit`, one test submission | `pre-launch` exits 0 (or fails only on a needs-you placeholder); audit blockers fixed or listed |
| 12 | `suggestions` | `suggest-improvements` with `gates.json` and `review/` | `docs/suggestions.md` with its "From the review" section |
| 13 | `pr` | Runbook, push, PR, final report | The PR quotes gate output and every "Not covered" section |

The skills each phase uses, with their own rules: `capture-site` (2), `parity-gates` (5 to 8),
`visual-review` (7, 9), `pre-launch` and `launch-audit` (11), `suggest-improvements` (12),
`post-launch` (in the runbook). Read each skill's SKILL.md before its phase.

## The build, in one paragraph

`references/build-rules.md` is binding. Layouts and the shared header, navigation and footer are
always components; content blocks are the captured markup, moved by a script. Media at its
original paths, fonts self-hosted, CSS by coverage pruning (`css-coverage.mjs` then
`css-prune.mjs`), never a rewrite. Forms per `references/forms.md`, third-party scripts per
`references/third-party.md`. `redirects.csv` is the single redirect source: a new redirect is a
row whose `source` is `decision` and whose `note` names the decision id, then `npm run
redirects:build`; never hand-edit the generated rules. The design is locked on the templates
(visual-review) before the rollout to every page.

## Decisions, exceptions, proposals

- **Decision.** Anything the live site does oddly, and every default you apply, gets
  `state.mjs decision '{"topic":…,"choice":…,"default":…,"reason":…,"costIfWrong":…}'` (it
  prints the id) and a row in `docs/DECISIONS.md`, the ledger of every decision in the run: id,
  date, topic, choice, default, reason, cost if wrong. Plan-phase decisions also go in
  `docs/plan.md`'s Decisions table, same columns. The default is always "reproduce live".
- **Exception** (`exceptions.json`, `{ path, field, from, to, reason, approvedBy, date }`): a
  difference the static build cannot avoid. `approvedBy` is `"default, <decision id>"` until a
  person signs it off in the PR.
- **Proposal** (`proposals.json`, the same shape, `approvedBy: "proposed"`): an improvement. It
  ships only when `PROPOSALS=on`; `npm run verify:proposals` gates it. When a person approves
  one, the entry moves to `exceptions.json` with their name in `approvedBy`.

## Hosting

Vercel by default, Cloudflare Pages on request: `references/hosting-vercel.md` and
`references/hosting-cloudflare.md`. Every non-release build is noindexed; only the launch build
sets `PUBLIC_INDEXABLE=true`. The media decision comes from `media-plan.mjs`: `repo`, `store`
(upload with `media-upload.mjs`), or `live-temporary` (staging only, with its warning, and the
runbook item "create the store, upload, regenerate rewrites; live-temporary must be gone before
DNS moves").

## Splitting the work

If your agent can run subagents, use one implementer per template (phase 6), per template's
rollout (phase 8) or per gate fix, never two on the same file. Every brief carries absolute paths
(`KIT`, `SITE`, the capture files, the layout to write) and the rule set of `build-rules.md`;
review their commits before the next phase. Without subagents, do the same work in the same order,
one template at a time. Either way, `state.mjs` writes run one after another, never in parallel.

## The one message after the plan

After phase 4, send one short status (not a question): platform, page and template counts, the
media decision, out-of-scope features and the options, the decisions taken by default, and the
needs-you list so far. Then carry on without waiting.

## The pull request (phase 13)

Push `main` (the scaffold) and `astro-rebuild`, then `gh pr create --base main --head
astro-rebuild --title "Astro rebuild of <host>" --body-file .conversion/pr-body.md`. Without a
`gh` login, the body stays in that file and "push and open the PR" goes on the needs-you list.
The body, in this order:

    ## What changed       one paragraph: platform, what was converted, host, media mode
    ## Counts             pages, templates, redirects, media files and size, forms, vendors kept/dropped
    ## Exceptions applied every exceptions.json entry: path, field, reason, decision id
    ## Proposals open     every proposals.json entry: id, path, what, why (ships only with PROPOSALS=on)
    ## Decisions          link to docs/DECISIONS.md, and every non-default choice
    ## Gate output        `npm run verify` output, verbatim, in a code block, with every skip line
    ## Visual review      template and full-set results, every override with its reason,
                          every bannerClosed and heightMismatch; the contact sheet is review/index.html
                          and review/all.html (local, regenerate with npm run review:sheet)
    ## Staging            the staging URL, verify-live result, the launch-audit blockers and their state
    ## Suggestions        counts per category, the medium and high risk items, the applyable ids
    ## Not covered        pre-launch's and launch-audit's "Not covered" sections, verbatim, each
                          under its own heading; then capture-site's, visual-review's and suggestions'
    ## Waiting on you     every state.needsYou item, in runbook order

## The final report (to the person)

Lead with the PR link, then: what was converted (counts), gates and visual review in one line
each, the staging URL, the needs-you list under **Waiting on you** read from
`state.mjs --dir $SITE get needsYou` (each item with the exact command or click, in runbook
order), then every "Not covered" section verbatim. Say "PR open, waiting on your merge", never
"done" or "live". Then stop.

## Resuming

In a new session, read `node $KIT/skills/convert-site/scripts/state.mjs --dir $SITE get` (or
`--dir $WORK` before the scaffold) and continue from `phase`: rerun that phase's proof first; if
it holds, start the next phase. The capture resumes with `--resume`. Never repeat the intake.

## Applying a suggestion later

`convert-site --apply <id>`: `references/apply-suggestion.md`. Never in the conversion run itself.

## References

| File | Covers |
|---|---|
| `references/intake.md` | The one message: questions, defaults, what is missing and what happens |
| `references/phases.md` | Every phase: exact commands, the proof it is done, what to record |
| `references/build-rules.md` | How layouts, content, CSS, media, fonts, lazy images and redirects are built |
| `references/forms.md` | Formspree wiring, field names, honeypot, thank-you, the one test submission |
| `references/third-party.md` | The `keep` allowlist in `baseline/scripts.json` and `docs/third-party.md` |
| `references/hosting-vercel.md` | Project, previews, indexing, Blob media, protection bypass |
| `references/hosting-cloudflare.md` | Pages project, `_redirects`, `_headers`, R2 media function, query redirects |
| `references/runbook.md` | `docs/LAUNCH.md`: A needs you, B closeout, C launch day, D 30-day watch |
| `references/components-optional.md` | The optional component pass |
| `references/apply-suggestion.md` | `--apply <id>`: proposal entry, branch commit, gates, sheet |
