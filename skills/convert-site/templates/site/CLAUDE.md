# Working in this repository

This is a static Astro rebuild of {{ORIGIN}} ({{SITE_NAME}}), made with astro-conversion-kit.
The goal is parity: the same URLs, content, head tags and look as the live site. Not a redesign.

## Branch
- All conversion work happens on `astro-rebuild`. `main` holds only the scaffold until launch.
- Never commit to `main` directly. Never force-push.

## Source of truth
- Build only from `capture/`: the saved HTML, CSS, media and URL inventory of the live site.
- Do not retype content. Copy text, headings, alt text, titles, descriptions and JSON-LD from the
  captured HTML with a script or by moving the markup; never paraphrase or tidy it.
- Do not fetch the live site again unless a capture step asks for it. It is read-only.
- If something is missing from `capture/`, re-run the capture into a fresh folder and diff instead of
  guessing; the committed capture stays as it was.

## Gates on every commit
Run before each commit and fix every failure first:

```
npm run build
npm run verify
```

- `npm run verify` checks the build in `dist/` against `baseline/` (URLs, status, titles,
  descriptions, canonicals, headings, links, media, redirects).
- `npm run review:shoot`, `review:diff`, `review:styles` and `review:sheet` produce the visual
  review under `review/` (not committed). Pixel diff passes at 0.5 % or less per page and width.

## Exceptions and proposals
- `exceptions.json`: a difference from the live site that is accepted on purpose (a broken embed
  that cannot work statically, a form that now posts elsewhere). Each entry names the path, the
  field and the reason. The gates skip exactly that check on exactly that path. Add one only when
  the difference is unavoidable, and say why.
- `proposals.json`: an improvement over the live site (a fixed typo, a missing alt text). It ships
  only in a `PROPOSALS=on` build (`npm run verify:proposals`) until a person approves it. A
  proposal is never applied to the default build. It carries `"approvedBy": "proposed"`; when a
  person approves it, the entry moves to `exceptions.json` with their name in `approvedBy`.
- Both files hold the same record shape: `{ path, field, from, to, reason, approvedBy, date }`.
- Never edit `baseline/` to make a gate pass.

## Indexing switch
- Every build is `noindex, nofollow` with a blocking robots.txt unless `PUBLIC_INDEXABLE=true`.
- Only the launch build sets it (`npm run verify:release` checks that build). Never set it in a
  preview deployment or commit it to a config file.

## Hosting
- Target: {{HOSTING}}. Redirects come from `redirects.csv` through `npm run redirects:build`;
  do not hand-edit the generated redirect rules.

## Files
- `docs/plan.md`: templates found, counts, decisions. Update it when a decision changes.
- `docs/third-party.md`: every external script, embed and form endpoint, and what replaces it.
- `docs/LAUNCH.md`: what a person must do, the closeout, launch day and the 30-day watch.

## Secrets
- No keys, tokens or real email addresses in the repo. Use `.env` (ignored) and `.env.example`.
- Test form submissions go to a placeholder address such as forms@example.com.
