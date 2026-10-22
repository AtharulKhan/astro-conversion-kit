# The phases

The order is `docs/process.md`'s. Every phase starts with `state.mjs phase <name>` and ends with
its proof. Do not start the next phase until the proof holds; if it does not, fix and rerun,
never move on with a note. `S` below is `node $KIT/skills/convert-site/scripts/state.mjs --dir
$SITE`. Commands run from `SITE`, each as its own command, not chained with `&&` where a non-zero
exit is expected (diff, styles, a gate you are fixing).

Record results as you go: `S set phases.<name>.result '<json>'` with the counts and exit codes,
and `S set counts.<key> <n>` for pages, templates, redirects, media, forms and vendors.

Before the scaffold, `SITE` holds only `capture/`, `.conversion/` (state, drafts and the media
download) and, when the repository was cloned first, `.git`, `.gitignore` and a README.
`init-site.mjs` refuses anything else, so nothing else is written there until phase 4.

## 1. intake

    mkdir -p $SITE
    S phase intake
    node $KIT/skills/convert-site/scripts/preflight.mjs --json
    node $KIT/skills/capture-site/scripts/fingerprint.mjs $LIVE

Then the one message (`intake.md`) and the answers into state.

**Proof:** `S get intake` holds every answer or default, and every gap is in `needsYou`.

## 2. capture

Follow the `capture-site` skill exactly, from `SITE`, with `KIT` paths:

    S phase capture
    node $KIT/skills/capture-site/scripts/capture.mjs $LIVE --out capture
    node $KIT/skills/capture-site/scripts/media.mjs --capture capture --download .conversion/media-cache
    node $KIT/skills/capture-site/scripts/templates.mjs --capture capture
    node $KIT/skills/capture-site/scripts/assets.mjs --capture capture
    node $KIT/skills/visual-review/scripts/shoot.mjs --base $LIVE --routes capture/templates.json --widths 390,768,1440 --out capture/screens/live
    node $KIT/skills/convert-site/scripts/css-coverage.mjs --base $LIVE --routes capture/inventory.json --out capture/css-coverage.json

Then the optional Lighthouse step, exactly as `capture-site` step 7 says: only when
`npx --no-install lighthouse --version` answers (never install it unasked), one run per
template representative into `capture/lighthouse-live/<template>`; if it is missing, write that
in the Notes. `suggest-improvements` reads `capture/lighthouse-live` and lists its performance
checks as "Not covered" without it. Last:

    node $KIT/skills/capture-site/scripts/readme.mjs --capture capture

`templates.mjs` must run before the baseline (phase 5 reads `templates.json`). The coverage run
loads every page at three widths at the default pacing: it is a capture step against the live
site and lands in `capture/`. The media download goes under `.conversion/media-cache/`, which the
scaffold's `.gitignore` keeps out of git. On exit 3 from any script, follow the skill's "On exit
3"; after two stops in a row, tell the person in one line and carry on with what was captured.

Pass `--seed <path>` for every old URL from the intake (`.htaccess`, redirect exports). Write the
`## Notes` section of `capture/README.md` by hand, as the skill says. List files under `capture/`
over 25 MB (`find capture -size +25M`) in the Notes: they are added to `.gitignore` at the
scaffold, before its commit.

**Proof:** `capture/README.md` exists with Notes; `capture/templates.json` and
`capture/css-coverage.json` exist; every URL in `inventory.json` has a status.

## 3. plan

    S phase plan

The plan phase decides; the scaffold writes. Every decision goes into state with `S decision`
(it prints `d1`, `d2`, …), and any file output stays under `.conversion/` until phase 4.

1. **Hosting**, from the intake: `S set hosting '"vercel"'` (or `"cloudflare"`).
2. **URL form**, the majority of pages answering 200 (the home page left out):

       node -e "const i=require('./capture/inventory.json').filter(r=>r.status===200&&r.path!=='/');const s=i.filter(r=>r.path.endsWith('/')).length;console.log(s>=i.length-s?'always':'never')"

   `S set trailingSlash '"always"'` (or `"never"`); the minority form becomes redirect rows.
3. **Media**:

       node $KIT/skills/convert-site/scripts/media-plan.mjs --media capture/media.json --host <hosting> --out .conversion/media-plan.json

   Exit 2 with "media paths share no folder": choose the prefix that holds most files, pass
   `--prefix`, and record a decision. Mode `store` with no store credentials in the environment
   (`BLOB_READ_WRITE_TOKEN`, or `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET`): rerun with `--mode live-temporary`, record the decision, and add the needs-you
   item "create the store, upload, regenerate rewrites; live-temporary must be gone before DNS
   moves".
4. **Templates**, from `capture/templates.json`: a split or merge that looks wrong is a decision.
5. **Oddities**, one decision each, default "reproduce live": a missing or second H1, a dead
   tag, a broken internal link, a redirect chain, a sitemap URL that 404s, a slug claimed twice
   (category base), a shortcode printed as text, an `http://` canonical, mixed content, a
   noindex page in the sitemap, a font loaded from a font service, theme scripts (`build-rules.md`).
6. **Out-of-scope features** (search, comments, store, logins) with the options.

For example:

    S decision '{"topic":"missing h1 on /services/","choice":"reproduce live","default":"reproduce live","reason":"parity; the fix is a proposal","costIfWrong":"none for launch; SEO stays as it is today"}'

Draft the plan in `.conversion/plan.md` from the capture, never from memory: the templates table,
counts from `inventory.json`, `media.json` and `redirects.json`, the media decision with its
numbers and reasons, the redirect source, the forms table (`inventory.json` forms), the analytics
IDs (`capture/scripts.json`) and the out-of-scope features. Exceptions and proposals follow
SKILL.md, "Decisions, exceptions, proposals". Then send the one status message (SKILL.md, "The
one message after the plan") and carry on.

**Proof:** every template, count, oddity and out-of-scope feature has a decision in `S get
decisions` and a line in the draft.

## 4. scaffold

    S phase scaffold

With `gh` logged in and no repo yet, `gh repo create <owner>/<slug> --private` (an empty repo).
Then, from the folder that holds `SITE`, with the plan's choices:

    node $KIT/skills/convert-site/scripts/init-site.mjs --dir $SITE --origin $LIVE --name "<site name>" --host <hosting> --trailing-slash <always|never> --repo https://github.com/<owner>/<slug>.git

`init-site` keeps `capture/` and `.conversion/` and makes the one scaffold commit on `main`,
capture included (screenshots, Lighthouse reports and the media download stay ignored), then
switches to `astro-rebuild`. If a capture file over 25 MB was listed in phase 2, add it to
`.gitignore` before running `init-site`. If `npm install` fails inside it, follow the next step
it prints, which includes `git add -A`: the capture is meant to be in that commit.

Right after, on `astro-rebuild`:

1. `docs/plan.md` from `.conversion/plan.md`, and its Decisions table filled from
   `S get decisions`, one row per decision:

       | Id | Date | Topic | Choice | Default | Reason | Cost if wrong |

   This table is the one decision ledger. Every later decision adds a row here.
2. `mv .conversion/media-plan.json docs/media-plan.json` (the media gate reads it there).
3. Commit `docs: conversion plan`, then `git push -u origin main`, so the PR has a base.

Never commit to `main` again.

**Proof:** `npm run build` exits 0; `git log main --oneline` shows exactly one commit; you are
on `astro-rebuild`.

## 5. baseline

    S phase baseline
    npm run baseline
    node $KIT/skills/parity-gates/scripts/build-baseline.mjs --out baseline --check

`npm run baseline` also writes `redirects.csv` (from, to, status, source, note). Commit
`chore: baseline from capture`. From here `baseline/` is never edited, apart from the `keep`
flags in `baseline/scripts.json` (`third-party.md`).

**Proof:** the `--check` run exits 0.

## 6. build

    S phase build

Read `build-rules.md`, `forms.md`, `third-party.md` and your host file first. In this order:

1. Media (`build-rules.md`, "Media") and fonts; for `store`, upload now (host file).
2. CSS: `node $KIT/skills/convert-site/scripts/css-prune.mjs --css capture/css --coverage capture/css-coverage.json --out src/styles/site.css --report .conversion/css-prune-report.json`.
   Exit 1 means a stylesheet had no coverage and was kept whole: record a decision.
3. One layout per template, with the header, navigation and footer as components.
4. The representative page of each template, its content moved from the captured markup.
5. Forms (`forms.md`) and third-party scripts (`third-party.md`).
6. Redirects: `npm run redirects:build`.

**Gates on every template commit.** `npm run verify` stops at the first failing gate, and links,
redirects and sitemaps are expected to fail until every page exists. So during the template work
run the path-scoped gates one by one, with `P` set once to the comma list of the
representatives:

    P="/,/about/,/blog/,/hello-world/"
    npm run build
    node scripts/verify/forms.mjs --paths "$P" --endpoint <endpoint> --honeypot _gotcha --thank-you /thank-you/
    node scripts/verify/headers.mjs --paths "$P"
    node scripts/verify/media.mjs --paths "$P"
    node scripts/verify/routes.mjs --paths "$P"
    node scripts/verify/scripts.mjs --paths "$P"
    node scripts/verify/seo.mjs --paths "$P"
    node scripts/verify/text.mjs --paths "$P"

Add `--allow-extra /thank-you/` to the routes gate when that page is new (`forms.md`). Each of
the seven must exit 0 before the commit (`feat: <template> template`). `links`,
`redirects` and `sitemaps` are not run yet; they run in phase 7.

**Design lock.** When every template is built, follow the `visual-review` skill's loop on the
template set: shoot new at 390, 768 and 1440, diff against `capture/screens/live`, styles, sheet,
look, write down every difference, fix from `capture/`, repeat. Never reshoot live to get a
match. The proof is `npm run review:diff -- --a capture/screens/live --b review/new --out
review/diff` and `npm run review:styles -- …` exiting 0 for the template set. From here a fix goes
in the template, never in one page.

**Rollout.** Every remaining page through its template's route, from captured markup
(`build-rules.md`), plus sitemaps, feeds, the 404 page and robots. With subagents, one
implementer per template.

**Proof:** `npm run build` passes with every route built, and the seven path-scoped gates pass
for every path.

## 7. gates

    S phase gates
    npm run build
    npm run verify -- --endpoint <endpoint> --honeypot _gotcha --thank-you /thank-you/

The form flags go on the command line every time, as the `parity-gates` skill shows; add
`--allow-extra /thank-you/` when that page is new (`forms.md`). With `proposals.json` entries,
also `PROPOSALS=on npm run build` and `npm run verify:proposals -- <the same flags>`, then rebuild
without it. Keep the plain-text `npm run verify` output for the PR, skip lines included.

Then the release build, which compares robots exactly (a page that lost its own live noindex
passes the staging comparison, never this one), and rebuild staging:

    PUBLIC_INDEXABLE=true npm run build
    npm run verify:release -- <the same flags>
    npm run build

**Proof:** `npm run verify` exits 0 on the full build, `npm run verify:release` on the
`PUBLIC_INDEXABLE=true` build (and `verify:proposals` when there are proposals). No PR is opened
before this holds.

## 8. visual

    S phase visual

The template set is locked (phase 6); rerun its loop once on the full build to confirm it still
passes. Then the `visual-review` reference, step 7: shoot live once more into
`capture/screens/live-all` (a capture step, default pacing), shoot new into `review/new-all`,
diff into `review/diff-all`, sheet into `review/all.html`, look, fix the template, repeat.
Rerun the phase 7 gates after every fix.

**Proof:** `review:diff` exits 0 for the template set at three widths and for
`capture/screens/live-all` against `review/new-all`.

## 9. components (optional)

Only when the intake said "components" or the person asked: `components-optional.md`. Otherwise
`S phase components` then `S set phases.components.result '"skipped: off by default"'`.

## 10. prelaunch

    S phase prelaunch
    git add -A
    git commit -m "chore: state before pre-launch"
    git push -u origin astro-rebuild
    PUBLIC_INDEXABLE=true node $KIT/skills/pre-launch/scripts/pre-launch.mjs --dir $SITE --production-url $LIVE --predecessor-url $LIVE --ignore-dir capture --out $SITE/review/pre-launch

pre-launch fails a tree with uncommitted changes or no upstream, and `state.json` changes with
every `S` call, so commit and push first. It runs `npm run build` itself: `PUBLIC_INDEXABLE=true`
makes that the production build it is meant to gate (without it, the staging build's robots.txt
blocks everything and fails the robots check). Without a `gh` login there is no remote to push
to; `hygiene.pushed` then fails until the person pushes, and that is a needs-you line.

Triage as the `pre-launch` skill says; every failure blocks and is fixed on the branch. The one
allowed failure is `placeholders.form-id` while the form id is on the needs-you list (`forms.md`);
the PR is then opened as a draft. Never pass `--confirm`: the human checklist ids (`forms`,
`analytics`, `hosting`, `payments`, `legal`, `gsc-baseline`, `dns`, `signoff`, `rollback`) go to
`docs/LAUNCH.md` section A for the person.

Then the staging deploy (host file), and:

    npm run verify:live -- --base <staging url> --expect-noindex
    node $KIT/skills/launch-audit/scripts/launch-audit.mjs --url <staging url> --staging --old-url $LIVE --out $SITE/review/launch-audit

On Vercel add `--bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"` to `verify:live` when that variable is
set in your environment; with media in a store add `--media-manifest media-manifest.json`. Copy
the audit's `baseline.json` and `redirects.csv` to `docs/launch/audit-baseline.json` and
`docs/launch/audit-redirects.csv` (the cutover reads them). Fix every audit blocker on the
branch, or list it in the PR with why it cannot be fixed. Then the one test submission
(`forms.md`).

**Proof:** `pre-launch` exits 0 (or fails only on `placeholders.form-id`); `verify-live` exits 0
or its gap is listed; every audit blocker is fixed or listed.

## 11. suggestions

    S phase suggestions

Collect `gates.json` now, from the build as it stands after every fix (one JSON document per
gate, gathered into an array):

    npm run build
    npm run --silent verify -- --json --endpoint <endpoint> --honeypot _gotcha --thank-you /thank-you/ > .conversion/gates.out
    node -e "const fs=require('fs');const t=fs.readFileSync('.conversion/gates.out','utf8');const d=t.split(/^(?=\{$)/m).map(s=>s.replace(/^All \d+ gates passed\s*$/m,'').trim()).filter(Boolean).map(JSON.parse);fs.writeFileSync('.conversion/gates.json',JSON.stringify(d,null,2)+'\n')"
    node $KIT/skills/suggest-improvements/scripts/suggest.mjs --capture capture --baseline baseline --review review --gates .conversion/gates.json --out docs/suggestions.md --json suggestions.json

Then add the "From the review" section by hand, as the `suggest-improvements` skill says. Apply
nothing.

**Proof:** `docs/suggestions.md` exists, ends with "From the review", and its Not covered list is
copied for the PR.

## 12. pr

    S phase pr

Write `docs/LAUNCH.md` (`runbook.md`), the PR body (SKILL.md), commit `docs: launch runbook`,
then `npm run build` and the full phase 7 gates once more, push `astro-rebuild` and open the PR
(`--draft` while `placeholders.form-id` fails). Finish with the final report.

**Proof:** the PR exists (or its body is in `.conversion/pr-body.md` with "open the PR" on the
needs-you list) and quotes the gate output and every "Not covered" section verbatim.
`S set phases.pr.result '{"pr":"<url>","draft":<true|false>}'`.
