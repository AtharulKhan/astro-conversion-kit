# Exceptions, proposals and decisions

The default build equals the live site, flaws included. A gate failure has one of three answers:
fix the build, record an exception, or record a proposal. Editing `baseline/` is never one of
them.

## Reproduce live by default

Every oddity on the live site (a missing or doubled H1, a typo, a dead analytics tag, a broken
link, an empty meta description, a redirect chain) is reproduced as it is. You do not decide to
improve it. You record it as a decision row whose choice is "reproduce live by default", with
the fix it would take, so a person can choose it later as a proposal.

Decision rows go in the site's decisions table (`docs/plan.md`, "Decisions"), one per decision,
with these six fields:

| Field | Holds |
|---|---|
| id | `D1`, `D2`, ... in order; never reused. A `decision` row in `redirects.csv` puts it in `note` |
| topic | What the decision is about, with the path: "/about/ has two H1s" |
| choice | What the build does: "reproduce live by default", or what it does instead |
| default | What the build would do without a decision (live as it is) |
| reason | Why this choice; for a departure from live, the evidence or the person who asked |
| cost if wrong | What breaks or is lost if the choice is wrong, and how it would be noticed |

Example: `D4 | /services/ links to /old-quote/, which 404s on live | reproduce live by default |
keep the broken link | parity; fixing it is a content change | a visitor still hits a 404; fix:
proposal to link /contact/`.

## Exceptions: `exceptions.json`

A difference the build cannot avoid or the person has approved (a form that now posts to a new
endpoint, an embed that cannot work statically, a redirect retargeted at the person's request).
The gates apply it to the baseline before comparing, on exactly that path and field.

## Proposals: `proposals.json`

An improvement over live (a fixed typo, a missing alt text, a shorter redirect). It never ships in
the default build. The build applies it only when it runs with `PROPOSALS=on` (in a scaffolded
site, `src/lib/exceptions.mjs` exposes `proposalOn(id)` for that), and the gates load
`proposals.json` after `exceptions.json` only when `PROPOSALS=on` is set: `npm run
verify:proposals`. So both builds are gated: the default against live plus exceptions, the
proposals build against live plus exceptions plus proposals. When a person approves a proposal,
the change moves into the default build and its entry moves to `exceptions.json`.

## The record

Both files are a JSON array of records with the same shape:

    { "path": "/about/", "field": "title", "from": "About Us | Example", "to": "About | Example",
      "reason": "client asked for the shorter title", "approvedBy": "client", "date": "2026-10-22" }

Every key is required and non-empty except `from` and `to`, which may be `""`. Extra keys (a
proposal's `id`) are ignored by the gates. A record that breaks these rules, a file that is not a
JSON array, or a `--exceptions`/`--proposals` path that does not exist makes the gate exit 2; only
the default `exceptions.json` and `proposals.json` may be missing.

`field` is one of these, and the gate that reads it:

| field | Gate | path | from / to |
|---|---|---|---|
| `title`, `description`, `canonical`, `robots`, `lang` | seo | the page | the baseline value / the built value |
| `h1`, `h2` | seo | the page | one heading / its replacement, or the whole array / the whole new array |
| `og` | seo | the page | one og value / its replacement, or the whole og object / the whole new object |
| `jsonLd` | seo | the page | one `@type` / its replacement, or the whole array of types / the new array |
| `text` | text | the page | a phrase in the captured text (or all of it) / its replacement |
| `link` | links | the page | the live href (recorded, not compared) / the built href the gate reports as broken |
| `redirect` | redirects | the redirect source | the baseline target / the new target |
| `media` | media | the media path | the baseline bytes (a number) / the built bytes, or `""` for a file the build drops |

`routes`, `sitemaps`, `forms`, `scripts` and `headers` take no exceptions. An extra built path is
`--allow-extra`; a dropped vendor is `keep: false` in `baseline/scripts.json`; forms are set by
`--endpoint`, `--honeypot` and `--thank-you`.

## How a record matches

`from` is replaced by `to` wherever it equals the whole value, an array item or an object value;
for `text`, also wherever it appears as a phrase inside the text. Then the gate compares.

- **Added scalar:** `from: ""` records a value the build adds where live had none (a description
  on a page that had none). **Removed scalar:** `to: ""` records a value the build drops.
- **Removed array item:** `from: "Old heading", to: ""` drops that heading.
- **Added array item or og key:** `from: ""` cannot do it, because there is no empty item or
  key to replace. Approve it with the whole array or object: `from` equal to the baseline's
  (`["About Us"]`, or the full og object as `seo.json` records it), `to` the full new one
  (`["About Us", "Our crew"]`).
- **Media bytes** are numbers: `"from": 13713`, not `"13713"`.

## A record that cannot be used fails the gate

The exceptions file is the record of what was approved, so a gate never ignores an entry
silently. Each of these is a failure with `field: "exception"`:

- `no longer matches the baseline`: `from` matches nothing on that path (the baseline value
  changed, or the record was wrong). Fix or delete the record.
- `no longer matches the build` (links): the built page no longer has that broken href.
- `path not checked`: the record's path is within `--paths` but the gate does not check it (a
  page that is not in the baseline, a `text` record on a path the text gate skips). Correct the
  path or the field.

A stale exception is fixed in `exceptions.json`, never by changing the build back to match it.
