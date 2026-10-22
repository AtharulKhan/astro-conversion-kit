# The phases

Every phase starts with `state.mjs phase <name>` and ends with its proof. Do not start the next
phase until the proof holds; if it does not, fix and rerun, never move on with a note. `S` below
is `node $KIT/skills/convert-site/scripts/state.mjs --dir $SITE` (`--dir $WORK` before the
scaffold). Commands run from `SITE` (or `WORK`), each as its own command, not chained with `&&`
where a non-zero exit is expected (diff, styles).

Record results as you go: `S set phases.<name>.result '<json>'` with the counts and exit codes,
and `S set counts.<key> <n>` for pages, templates, redirects, media, forms and vendors.

## 1. intake

    mkdir -p $WORK
    S phase intake
    node $KIT/skills/convert-site/scripts/preflight.mjs --json
    node $KIT/skills/capture-site/scripts/fingerprint.mjs $LIVE

Then the one message (`intake.md`) and the answers into state.

**Proof:** `S get intake` holds every answer or default, and every gap is in `needsYou`.

## 2. capture

Follow the `capture-site` skill exactly, from `WORK`, with `KIT` paths:

    S phase capture
    node $KIT/skills/capture-site/scripts/capture.mjs $LIVE --out capture
    node $KIT/skills/capture-site/scripts/media.mjs --capture capture --download media-cache
    node $KIT/skills/capture-site/scripts/templates.mjs --capture capture
    node $KIT/skills/capture-site/scripts/assets.mjs --capture capture
    node $KIT/skills/visual-review/scripts/shoot.mjs --base $LIVE --routes capture/templates.json --widths 390,768,1440 --out capture/screens/live
    node $KIT/skills/convert-site/scripts/css-coverage.mjs --base $LIVE --routes capture/inventory.json --out capture/css-coverage.json
    node $KIT/skills/capture-site/scripts/readme.mjs --capture capture

`templates.mjs` must run before the baseline (phase 5 reads `templates.json`). The coverage run
loads every page at three widths at the default pacing: it is a capture step against the live
site and lands in `capture/`. On exit 3 from any of them, follow the skill's "On exit 3"; after
two stops in a row, tell the person in one line and carry on with what was captured.

Pass `--seed <path>` for every old URL from the intake (`.htaccess`, redirect exports). Write the
`## Notes` section of `capture/README.md` by hand, as the skill says.

**Proof:** `capture/README.md` exists with Notes; `capture/templates.json` and
`capture/css-coverage.json` exist; every URL in `inventory.json` has a status.

## 3. scaffold

The URL form the live site uses most (pages answering 200, the home page left out):

    node -e "const i=require('./capture/inventory.json').filter(r=>r.status===200&&r.path!=='/');const s=i.filter(r=>r.path.endsWith('/')).length;console.log(s>=i.length-s?'always':'never')"

With `gh` logged in and no repo yet, `gh repo create <owner>/<slug> --private` (an empty repo).
Then, from the folder that will hold `SITE`:

    node $KIT/skills/convert-site/scripts/init-site.mjs --dir $SITE --origin $LIVE --name "<site name>" --host vercel --trailing-slash always --repo https://github.com/<owner>/<slug>.git

That makes the one commit on `main` and switches to `astro-rebuild`. Then move the capture in and
make the first branch commit:

    mv $WORK/capture $WORK/media-cache $WORK/.conversion $SITE/
    S phase scaffold

Add the preview noindex header the headers gate needs (`hosting-vercel.md` or
`hosting-cloudflare.md`, "Indexing"). Before committing, list files under `capture/` over 25 MB (`find capture -size +25M`); add each
to `.gitignore` and name it in the capture Notes. `capture/screens/` and `media-cache/` are
already ignored. Then `git add -A` and `git commit -m "chore: capture of <host>"`. Push `main`
now (`git push -u origin main`) so the PR has a base. Remove the empty `WORK` folder.

**Proof:** `npm run build` exits 0; `git log main --oneline` shows exactly one commit; you are
on `astro-rebuild`. Never commit to `main` again.

## 4. plan

    S phase plan
    node $KIT/skills/convert-site/scripts/media-plan.mjs --media capture/media.json --host vercel --out docs/media-plan.json

Exit 2 with "media paths share no folder": choose the prefix that holds most files, pass
`--prefix`, and record a decision. Mode `store` with no store credentials in the environment
(`BLOB_READ_WRITE_TOKEN`, or `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET`): rerun with `--mode live-temporary`, record the decision, and add the needs-you item
"create the store, upload, regenerate rewrites; live-temporary must be gone before DNS moves".

Fill `docs/plan.md` from the capture, never from memory: the templates table from
`templates.json`, counts from `inventory.json`, `media.json` and `redirects.json`, the media
decision with its numbers and reasons, the redirect source, the forms table (`inventory.json`
forms), the analytics IDs (`capture/scripts.json`), out-of-scope features, and one row per
oddity. The oddities to look for: a missing or second H1, a dead tag, a broken internal link, a
redirect chain, a sitemap URL that 404s, a slug claimed twice (category base), a shortcode
printed as text, an `http://` canonical, mixed content, a noindex page in the sitemap.

Every oddity and every default you apply is a decision:

    S decision '{"topic":"missing h1 on /services/","choice":"reproduce live","default":"reproduce live","reason":"parity; the fix is a proposal","costIfWrong":"none for launch; SEO stays as it is today"}'

Copy the printed id into a row of `docs/DECISIONS.md` and, for plan-phase decisions, the Decisions
table of `docs/plan.md`. Both use the same columns:

    | Id | Date | Topic | Choice | Default | Reason | Cost if wrong |

A difference the build cannot avoid becomes an `exceptions.json` entry (`{ path, field, from,
to, reason, approvedBy, date }`, `approvedBy` `"default, <decision id>"`); an improvement becomes
a `proposals.json` entry of the same shape with `"approvedBy": "proposed"`. When a person
approves a proposal, the entry moves to `exceptions.json` with their name in `approvedBy`.

Commit `docs: conversion plan`. Then send the one status message (SKILL.md, "The one message
after the plan") and carry on.

**Proof:** every template, count, oddity and out-of-scope feature has a row with a decision id.

## 5. baseline

    S phase baseline
    npm run baseline
    node $KIT/skills/parity-gates/scripts/build-baseline.mjs --out baseline --check

`npm run baseline` also writes `redirects.csv` (from, to, status, source, note). Commit
`chore: baseline from capture`. From here `baseline/` is never edited, apart from the `keep`
flags in `baseline/scripts.json` (`third-party.md`).

**Proof:** the `--check` run exits 0.

## 6. templates

    S phase templates

Read `build-rules.md`, `forms.md`, `third-party.md` and your host file first. In this order:

1. Media (`build-rules.md`, "Media") and fonts; for `store`, upload now (host file).
2. CSS: `node $KIT/skills/convert-site/scripts/css-prune.mjs --css capture/css --coverage capture/css-coverage.json --out src/styles/site.css --report .conversion/css-prune-report.json`.
   Exit 1 means a stylesheet had no coverage and was kept whole: record it in the plan.
3. One layout per template, with the header, navigation and footer as components.
4. The representative page of each template, its content moved from the captured markup.
5. Forms and third-party scripts, then the gate flags in `package.json` (`forms.md`).
6. Redirects: `npm run redirects:build`.

Gates on every commit, scoped to what is built (comma list of the representatives):

    npm run build
    npm run verify -- --paths /,/about/,/blog/,/hello-world/

A redirects or sitemaps failure that names a page not built yet (a redirect target, a sitemap
entry) is the one failure expected before the rollout; every other failure is fixed before the
commit, and the full gates in phase 8 allow none.

**Proof:** that `verify` exits 0 apart from not-yet-built pages, and `npm run build` is clean.
Commit per template (`feat: <template> template`).

## 7. design-lock

    S phase design-lock

Follow the `visual-review` skill's loop on the template set: shoot new at 390, 768 and 1440,
diff against `capture/screens/live`, styles, sheet, look, write down every difference, fix from
`capture/`, repeat. Never reshoot live to get a match.

**Proof:** `npm run review:diff -- --a capture/screens/live --b review/new --out review/diff`
exits 0, and `npm run review:styles -- …` exits 0 for the template set. The design is now locked:
later fixes go in the template, never per page.

## 8. rollout

    S phase rollout

Every remaining page through its template's route, from captured markup (`build-rules.md`), plus
sitemaps, feeds, the 404 page and robots. With subagents, one implementer per template. Then the
full gates:

    npm run build
    npm run verify

Collect `gates.json` for the suggestions (one JSON document per gate, gathered into an array):

    npm run --silent verify -- --json > .conversion/gates.out
    node -e "const fs=require('fs');const t=fs.readFileSync('.conversion/gates.out','utf8');const d=t.split(/^(?=\{$)/m).map(s=>s.replace(/^All \d+ gates passed\s*$/m,'').trim()).filter(Boolean).map(JSON.parse);fs.writeFileSync('.conversion/gates.json',JSON.stringify(d,null,2)+'\n')"

Keep the plain-text `npm run verify` output for the PR, skip lines included.

**Proof:** `npm run verify` exits 0 on the full build, and `npm run verify:proposals` exits 0
when `proposals.json` has entries.

## 9. visual-all

    S phase visual-all

The `visual-review` reference, step 7: shoot live once more into `capture/screens/live-all`
(a capture step, default pacing), shoot new into `review/new-all`, diff into `review/diff-all`,
sheet into `review/all.html`, look, fix the template, repeat.

**Proof:** `review:diff` exits 0 for `capture/screens/live-all` against `review/new-all`.

## 10. components (optional)

Only when the intake said "components" or the person asked. `components-optional.md`.
Otherwise run `S phase components` then `S set phases.components.result '"skipped: off by default"'`.

## 11. prelaunch

    S phase prelaunch
    node $KIT/skills/pre-launch/scripts/pre-launch.mjs --dir $SITE --production-url $LIVE --predecessor-url $LIVE --ignore-dir capture --out $SITE/review/pre-launch

Triage as the `pre-launch` skill says; every failure blocks and is fixed on the branch. The one
allowed failure is `placeholders.form-id` while the form id is on the needs-you list; say so in
the PR. Never pass `--confirm`: the human checklist ids (`forms`, `analytics`, `hosting`,
`payments`, `legal`, `gsc-baseline`, `dns`, `signoff`, `rollback`) go to `docs/LAUNCH.md`
section A for the person.

Then the staging deploy (host file), and:

    npm run verify:live -- --base <staging url> --expect-noindex
    node $KIT/skills/launch-audit/scripts/launch-audit.mjs --url <staging url> --staging --old-url $LIVE --out $SITE/review/launch-audit

On Vercel add `--bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"` to `verify:live` when that variable is
set in your environment; with media in a store add `--media-manifest media-manifest.json`. Copy
the audit's `baseline.json` and `redirects.csv` to `docs/launch/audit-baseline.json` and
`docs/launch/audit-redirects.csv` (the cutover reads them). Fix every audit blocker on the
branch, or list it in the PR with why it cannot be fixed. Then the one test submission
(`forms.md`).

**Proof:** `pre-launch` exits 0 (or fails only on the needs-you placeholder); `verify-live` exits
0 or its gap is listed; every audit blocker is fixed or listed.

## 12. suggestions

    S phase suggestions
    node $KIT/skills/suggest-improvements/scripts/suggest.mjs --capture capture --baseline baseline --review review --gates .conversion/gates.json --out docs/suggestions.md --json suggestions.json

Then add the "From the review" section by hand, as the `suggest-improvements` skill says. Apply
nothing.

**Proof:** `docs/suggestions.md` exists, ends with "From the review", and its Not covered list is
copied for the PR.

## 13. pr

    S phase pr

Write `docs/LAUNCH.md` (`runbook.md`), the PR body (SKILL.md), commit `docs: launch runbook`,
then `npm run build`, `npm run verify` once more, push and open the PR. Finish with the final
report.

**Proof:** the PR exists (or its body is in `.conversion/pr-body.md` with "open the PR" on the
needs-you list) and quotes the gate output and every "Not covered" section verbatim.
`S set phases.pr.result '{"pr":"<url>"}'`.
