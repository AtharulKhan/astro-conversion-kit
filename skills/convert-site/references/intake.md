# Intake: the one message

Send this once, after preflight and the fingerprint, and never send a second question message.
If your environment cannot wait for a reply (a non-interactive run), apply every default and
go. Estimate the crawl at 2.5 s per page plus 2.5 s per media file.
Fill every `<...>` from what you found; delete a question only when you already know the answer,
and say what you found instead. Keep each default exactly as stated, so a person who answers
"go" gets a predictable run. For an `experience: new` person, add one plain sentence under the
opening explaining what a repository, a staging deploy and a pull request are.

## The template

    I'm about to convert <LIVE> (<platform>, found <n sitemap URLs / REST pages>) into a static
    Astro site that matches it: same URLs, content, titles, media and look, proven by checks
    against a saved copy of the live site. The live site is only read, slowly (one request every
    2.5 seconds); nothing on it changes. I'll ask everything now and then work through to a pull
    request without stopping. Answer only what you want to change; every line has a default.

    1. Repository. Default: a new private GitHub repo <gh user>/<slug>, in <folder>/<slug>.
       <If gh is not logged in: "Run `gh auth login` in a terminal if you want me to create it;
       otherwise the repo stays on this machine and pushing it is on your list.">
    2. Hosting. Default: Vercel. Or Cloudflare Pages. <Logged in: "You're logged in to <cli>, so
       I'll create a project and a noindexed staging deploy." Not logged in: "Run `npx vercel
       login` (or `npx wrangler login`) if you want a staging deploy; otherwise you get a local
       preview and the deploy is on your list.">
    3. Forms (<n> found: <pages>). Default: they post to Formspree, with the same fields. If you
       prefer another form service, name it. (I'll ask for the form id when I wire the forms;
       nothing waits on it.)
    4. Test address. One test submission goes to the address you give here, once, from the
       staging copy; never to an address found on the site. Default: none, and no test is sent.
    5. Analytics and tags. Found: <GA4 G-..., GTM-..., others>. Default: every one carries
       over unchanged. Name any to drop, or IDs I could not see (server-side, consent tools).
    6. Redirects. Default: every redirect the crawl finds. If you have an old .htaccess, a
       redirect plugin export or a list of old URLs, send the file.
    7. Pages that must not change, or must be left out. Default: none; every page converts.
    8. Out of scope (needs a server): <search / comments / store / logins found, or "none
       found">. Default: the markup is reproduced as it is, the feature stops working, and the
       plan lists the options (a third-party embed, keeping it on the old platform under a
       subdomain, a separate project) for you to choose later.
    9. Large media. <Only when the capture is likely over the limits: "The media library looks
       large."> Default: media stays in the repo if under 300 MB, every file under 25 MB and
       under 10,000 files; otherwise it goes to <Vercel Blob / Cloudflare R2> if store
       credentials are in this machine's environment, else staging borrows it from the live
       site until you create the store.
    10. Components. Default: off. Say "components" if you want repeated blocks (cards, calls
        to action) turned into Astro components after everything matches.

    What is missing and what happens:
    <one line per gap, from the list below>

    Reply with any changes, or just "go". The crawl takes about <estimate> for <n> pages, and
    after it I'll send one status message and keep going; I won't ask anything else.

## What is missing and what happens

Include each line that applies, worded for this run. Each becomes a `state.needsYou` item and a
`docs/LAUNCH.md` section A line if it is still missing when the phase that needs it comes.

| Missing | What happens |
|---|---|
| `gh` not logged in | The repo stays local; "create the repo, push `main` and `astro-rebuild`, open the PR from `.conversion/pr-body.md`" goes on your list |
| Hosting CLI not logged in | No staging deploy; `npm run preview` locally; the staging audit and `verify-live` are "Not covered"; "deploy staging" goes on your list |
| No form id yet (asked at the forms step, never here) | Forms post to `https://formspree.io/f/REPLACE`; `pre-launch` fails on `placeholders.form-id` until you give the id; the PR opens as a draft; "create the form, send me the id" goes on your list |
| No test address | No test submission; the `forms` launch check waits on you |
| No store credentials and media over the limits | Media is served from the live site on staging only (`live-temporary`); "create the store, upload, regenerate rewrites" goes on your list and must be done before DNS moves |
| Vercel preview protection on | `launch-audit` and `verify-live` cannot reach staging and are "Not covered" until you open the preview or give a bypass secret through the environment |
| Cloudflare query redirects (`?p=` shortlinks) | Created by you as Single Redirects from `cloudflare-query-redirects.csv` |
| Search Console access | The baseline export before DNS moves is yours (`gsc-baseline`) |
| DNS access | The cutover is yours; the runbook names the two records to change |

## Recording the answers

Write each answer, or the default that stood, to state before the capture starts. The state
lives in `$SITE/.conversion/` from the start; `init-site.mjs` scaffolds around it later:

    node $KIT/skills/convert-site/scripts/state.mjs --dir $SITE set site '"<LIVE>"'
    node $KIT/skills/convert-site/scripts/state.mjs --dir $SITE set hosting '"vercel"'
    node $KIT/skills/convert-site/scripts/state.mjs --dir $SITE set repo '"<owner>/<slug>"'
    node $KIT/skills/convert-site/scripts/state.mjs --dir $SITE set intake '{"forms":{"service":"formspree"},"testAddress":"you@example.com","analytics":["G-..."],"keepPages":[],"components":false}'

Every default you applied is also a decision (`state.mjs decision`), so the PR shows it. Add each
missing item to `needsYou` as `{ "item": "...", "command": "...", "before": "<phase or DNS>" }`:
read the array with `state.mjs get needsYou`, append, and write it back with `set needsYou`.

## Exceptions and proposals, said once

For `new` and `some` people, add one sentence each to the message: the default build copies the
live site exactly, faults included; a difference the static build cannot avoid is an exception
they sign off in the PR; an improvement is a proposal that ships only when they approve it. The
rule itself is in SKILL.md, "Decisions, exceptions, proposals".
