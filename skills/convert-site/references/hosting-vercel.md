# Hosting on Vercel

The default host. The site is a static project with no adapter; `vercel.json` carries the headers,
the URL mode, the redirects (from `redirects.csv`) and, when media is not in the repo, one rewrite.
The kit's `docs/hosting.md` explains the background; this file is what you run.

You create and link the project, connect it to its repository and deploy previews. You never
change project settings in the dashboard, never add a domain, and never set an environment
variable other than the one the runbook names for launch day.

## Project and staging deploy (phase 10, prelaunch)

Only when `preflight.mjs` reports `vercel.loggedIn: true`. From `SITE`, in this order, with
`<team>` the Vercel team from the intake (`S get intake.vercelScope`); for the personal account
(the default, `null`) leave `--scope <team>` out:

    npx vercel link --yes --project <slug> --scope <team>
    npx vercel git connect https://github.com/<owner>/<slug>.git
    npx vercel deploy --yes

`vercel link` creates the project in that scope when it does not exist; it writes `.vercel/`,
which must stay out of git (add `.vercel` to `.gitignore` if it is not there). On an account in
several teams, `link --yes` without `--scope` fails: never guess a team. `vercel git connect`
links the project to the GitHub repository, so the person's merge to `main` deploys from Git
(the same link as Project Settings, Git, in the dashboard); it needs the repository pushed and
the Vercel GitHub app allowed on that owner. `vercel deploy --yes` is the staging deploy: it
prints the preview URL, the staging URL. The CLI uploads the repository minus `.vercelignore`,
which the scaffold writes with `/.conversion/` (run state and the media download), `/review/`
and the ignored `/capture/screens/` and `/capture/lighthouse-live/`; `capture/` itself is
uploaded, because the build reads it. Record the URL: `S set staging '"<url>"'`. Previews build
without `PUBLIC_INDEXABLE`, so they are noindexed.

When a step fails, record its needs-you line and go on as the next paragraph says for the
steps after it:

- `link` fails (scope missing or wrong, no access): "`npx vercel teams ls`, then
  `npx vercel link --yes --project <slug> --scope <team>`, `npx vercel git connect <repo url>`
  and `npx vercel deploy --yes`"; no deploy.
- `git connect` fails (no remote yet, or the GitHub app cannot see the repository): "connect the
  Vercel project to <owner>/<slug>: `npx vercel git connect <repo url>`, or Project Settings,
  Git, in the dashboard"; the staging deploy still runs from the CLI.

Not logged in, or no deploy: `npm run build` and `npm run preview` locally, the staging audit
and `verify-live` go under "Not covered", and "log in (`npx vercel login`), then
`npx vercel link --yes --project <slug> --scope <team>`, `npx vercel git connect <repo url>`
and `npx vercel deploy --yes`" goes on the needs-you list.

## Indexing

Staging builds leave `PUBLIC_INDEXABLE` unset, so `Base.astro` puts `noindex, nofollow` on every
page and robots.txt blocks everything. Vercel adds an `X-Robots-Tag: noindex` header to preview
deployments itself, so nothing is added to `vercel.json` for staging. Production is the build
with `PUBLIC_INDEXABLE=true`, set for the Production environment only, on launch day, by the
person: `npx vercel env add PUBLIC_INDEXABLE production` with the value `true`. Never for Preview.

## Redirects

`npm run redirects:build` writes the `redirects` array of `vercel.json` (with explicit
`statusCode`, never `permanent`, and the slash rules last). More than about 1,800 routes warns:
Vercel's limit is 2,048 rules across redirects, rewrites and headers; beyond it, the runbook
points the person to the project's bulk redirects.

## Media outside the repo

**Store (Blob).** With `BLOB_READ_WRITE_TOKEN` in the environment (never in chat, never in a
file in the repo):

    node $KIT/skills/convert-site/scripts/media-upload.mjs --store blob --dir .conversion/media-cache --manifest media-manifest.json --prefix /wp-content/uploads/ --media capture/media.json

Rerun until it exits 0 (it resumes). Commit `media-manifest.json`. `.conversion/media-cache/` is
the capture's download, on the machine that ran the capture; it stays out of git. Then write the
rewrite, with the store origin taken from any `url` in the manifest:

    node --input-type=module -e "import { rewriteConfig } from '$KIT/skills/convert-site/scripts/media-plan.mjs'; console.log(JSON.stringify(rewriteConfig('store', '<store origin>', '/wp-content/uploads/', { store: 'blob' })))"

and add the printed object to `vercel.json` `"rewrites"`. The media gate reads the manifest in
`store` mode; `verify:live` takes `--media-manifest media-manifest.json`.

**Live-temporary.** No token: the plan says `live-temporary`, and the rewrite points at the live
site (staging only):

    node --input-type=module -e "import { rewriteConfig } from '$KIT/skills/convert-site/scripts/media-plan.mjs'; console.log(JSON.stringify(rewriteConfig('live-temporary', '$LIVE', '/wp-content/uploads/')))"

The media gate counts every file as skipped (not a pass). The needs-you item: create a public Blob
store, put its token in the environment, run the upload above, rerun `media-plan.mjs` without
`--mode` (`--out docs/media-plan.json`), replace the rewrite with the store one, and rerun the
gates. Live-temporary must be gone
before DNS moves: when the old host goes, the media goes with it.

In both modes, nothing under the media prefix goes in `public/` (a file there would win over the
rewrite).

## Deployment protection

Vercel protects previews by default, so `launch-audit` and `verify-live` see a login page. When
`VERCEL_AUTOMATION_BYPASS_SECRET` is set in your environment, pass it to `verify-live` with
`--bypass`; `launch-audit` cannot send it. Otherwise both go under "Not covered" with the reason,
and the needs-you list says: "open the preview for the audit (it stays noindexed) or keep it
protected and accept the gap". You never change the protection setting yourself.

## Production (the person, on launch day)

`npx vercel deploy --prod` from `main` after the merge, or the project's Git integration if the
person connected it. Then the domain: `npx vercel domains add <domain>` and the records it
prints. Both are runbook steps, not yours.
