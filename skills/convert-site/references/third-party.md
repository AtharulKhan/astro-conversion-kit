# Third-party scripts

Analytics, tag managers, pixels, chat widgets, maps, video and consent tools are carried over by
list, not by judgment. The list is `baseline/scripts.json`; the scripts gate holds the build to it.

## The allowlist

`baseline/scripts.json` is `{ "<vendor>": { id, ids[], pages[], keep } }`, built from the capture
by `npm run baseline`. Every vendor starts with `keep: true`: the default build loads exactly what
live loaded, on the same pages, with the same IDs. `keep` is the only field anyone edits in
`baseline/`.

To drop a vendor:

1. Record the decision (`state.mjs decision`, topic `drop <vendor>`, with the reason and the cost
   if wrong) and its row in the Decisions table of `docs/plan.md`.
2. Set its `keep` to `false` in `baseline/scripts.json`.
3. Remove its tags from the layouts and content, rebuild, and run `npm run verify`: the scripts
   gate now fails if the vendor still loads anywhere.

Reasons that justify a drop by default (each still a decision row the person sees in the PR):

- **The person said so at intake.**
- **A Universal Analytics `UA-` id.** The service stopped collecting in 2023 and `pre-launch`
  fails `placeholders.analytics-id` on the pattern. Drop it; a GA4 tag on the same pages stays.
- **A vendor with no id** that loads nothing (`dead-analytics` in the suggestions) stays by
  default; it is a suggestion, not a drop.

Never add a vendor the live site did not have, and never change an ID. A new tag is a proposal.

## How kept scripts are built

Copy each tag from the captured page where it appears, in the same place (`<head>` or end of
`<body>`), with the same attributes (`async`, `defer`, `data-*`). A tag on every page goes in the
layout; a tag on some pages only goes on those pages, per its `pages[]`. Consent tools keep their
order before the tags they gate.

## docs/third-party.md

The human table, generated from `baseline/scripts.json` and never written from memory. Rewrite it
whenever a `keep` flag changes, one row per vendor:

| Service | Kind | Where it loads | ID or URL | Carried over as | Status |
|---|---|---|---|---|---|
| ga4 | analytics | 13 pages (all) | G-FIXTURE1 | same tag in `Base.astro` | kept as is |
| gtm | tag manager | 13 pages (all) | GTM-… | same snippet in `Base.astro` | kept as is |
| (vendor) | (kind) | n pages, first three | id | where it lives now | removed, d7 |

Add the form endpoint (`forms.md`) and any font service (`build-rules.md`) as rows too, with what
replaced them. The PR's counts line quotes vendors kept and dropped from this table.
