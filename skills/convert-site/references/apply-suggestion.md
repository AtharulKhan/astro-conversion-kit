# Applying a suggestion: --apply <id>

`convert-site --apply <id>` turns one suggestion from `suggestions.json` into a proposal: it
ships only in a `PROPOSALS=on` build until a person approves it. It never runs as part of a
conversion, and it never changes the default build.

## Before you start

- Run from `SITE`, with `suggestions.json`, `baseline/` and `capture/` present.
- `<id>` is a check id from `suggestions.json` (for example `http-links`, `render-blocking-scripts`).
  Collect every item with that id; with `--path <path>` only the item for that page.
- An item with `applyable: false` is not applied mechanically: say so, and offer to write the
  proposal by hand with the person's wording (alt text, copy, which duplicate page to keep).
- The working branch: `astro-rebuild` while its PR is open, otherwise `main`'s latest. Create
  `apply/<id>` from it. Never commit to `main`.

## The flow

1. **Read the item.** From `suggestions.json` take each matching item's `path`, `element`,
   `evidence`, `why`, `effort`, `risk` and `pages[]` (grouped items list every page they apply
   to; use `pages[]`, not the short evidence, for the full set).
2. **Write the proposal entries.** One per page and field it changes, in `proposals.json`, the
   gates' record shape:

       { "path": "/about/", "field": "link", "from": "http://partner.example.com/",
         "to": "https://partner.example.com/", "reason": "suggestion http-links: <why>",
         "approvedBy": "proposed", "date": "<today>" }

   `field` is one of the gates' fields (`title`, `description`, `canonical`, `robots`, `lang`,
   `h1`, `h2`, `text`, `og`, `jsonLd`, `link`, `redirect`, `media`). A change no gate field
   covers (`async` on a script tag, a header) needs no entry but still goes behind the switch.
3. **Make the change behind the switch.** In the layout or route that renders it, use
   `proposalOn(path, field)` from `src/lib/exceptions.mjs` (or `PROPOSALS_ON` from
   `src/lib/site.mjs` for a site-wide change) so the default build renders exactly what it did
   before and a `PROPOSALS=on` build renders the improvement. Never edit `baseline/` or
   `src/content/` text directly.
4. **One commit** on `apply/<id>`: `feat(proposal): <id>`, with the entries and the change.
5. **Gates, both ways.** `npm run build` then `npm run verify` must pass unchanged (the default
   build did not move). Then `PROPOSALS=on npm run build` and `npm run verify:proposals` must
   pass. Any failure is fixed on the branch.
6. **The sheet.** Serve the `PROPOSALS=on` build, shoot the affected pages
   (`npm run review:shoot -- --base http://localhost:4321 --routes <pages> --widths 390,1440 --out review/new-<id> --delay 0`),
   diff against `capture/screens/live-all`, build `review/<id>.html`, and look: the visible
   change must be the intended one and nothing else.
7. **Hand it over.** Push `apply/<id>` and open a PR into the working branch (`gh pr create`),
   with the item's evidence, the entries, both gate outputs and the sheet's result. Record it:
   `S decision '{"topic":"apply <id>","choice":"proposed","default":"reproduce live","reason":"…","costIfWrong":"…"}'`.

## When the person approves

The approved entries move from `proposals.json` to `exceptions.json` with the person's name in
`approvedBy`, and the switch in the code is replaced by the change itself, in one commit
`feat: apply <id>`. The default build now carries it, and `npm run verify` passes because the
exceptions say so.
