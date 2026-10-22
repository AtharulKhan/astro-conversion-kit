# Forms

A static site cannot receive a form, so every form posts to a third-party endpoint chosen at
intake. Formspree is the default; any endpoint that accepts a plain HTML `POST` works the same way.
The live site's form is never submitted.

## What stays the same

The forms gate compares each built form with `baseline/forms.json`: the same field names (every
named `input`, `select` and `textarea`, without buttons), the same method. Keep the captured form
markup, labels, classes and order exactly; change only:

- `action` to the endpoint (`https://formspree.io/f/<form id>`), `method="POST"`;
- add the honeypot and thank-you fields below.

The platform's hidden fields (nonces, `_wpcf7*`, `form_id`) are part of the captured field set, so
they stay, harmless, as captured. Dropping one is an exception with a reason.

## Honeypot

Keep the live honeypot field (the fixture's is `website`) where it was. Add Formspree's own,
hidden from people and from assistive technology:

    <input type="text" name="_gotcha" tabindex="-1" autocomplete="off" style="display:none" aria-hidden="true">

The gate allows a honeypot the live form did not have when it is named with `--honeypot`.

## Thank-you page

Every form leads to one thank-you page, through a hidden field:

    <input type="hidden" name="_next" value="/thank-you/">

The gate compares the field's value with `--thank-you` as a string, so both carry the same path.
Check during the one test submission that the endpoint lands on it; if the endpoint needs an
absolute URL there, the gate is wrong about this endpoint: say so and fix the gate, never the
value alone.

Use the live site's thank-you URL when it has one (it is a captured page and already built).
When it has none, build `/thank-you/` from the site's plain page template with a one-line
message, add it to the routes gate with `--allow-extra /thank-you/`, and record a decision. A
redirect after submission depends on the endpoint's plan; note on the needs-you list if the
chosen plan does not honour `_next`.

## The gate flags

Add the flags to the three verify scripts in the site's `package.json`, so every `npm run verify`
carries them:

    "verify": "node scripts/verify/run-all.mjs --endpoint https://formspree.io/f/<id> --honeypot _gotcha --thank-you /thank-you/",

(the same flags on `verify:proposals` and `verify:release`, plus `--allow-extra /thank-you/`
when that page is new). With several endpoints, one form
id per form, the gate takes one `--endpoint`: use one form id for all, or record an exception per
extra form. Without a form id at intake the endpoint is `https://formspree.io/f/REPLACE`, and
`pre-launch` fails `placeholders.form-id` on purpose until the person gives the id.

## The one test submission

Once, after the staging deploy, and only when the intake gave a test address:

1. Open the staging contact page (with Playwright, or your agent's own browser).
2. Fill each field with an obvious test value (`Conversion test`, the intake test address in the
   email field, `Test submission from the staging copy` as the message), leave the honeypots
   empty, and submit once.
3. Record it: `S set forms.testSentAt '"<ISO time>"'` and the page you used.

Never submit on the live site, never to an address found on the site, never more than once per
run. A new Formspree form sends a confirmation email to its owner on the first submission; that
is the person's to click. Whether the message arrived is the person's to confirm: it is the
`forms` item of the pre-launch checklist, in `docs/LAUNCH.md` section A. Never confirm it.
