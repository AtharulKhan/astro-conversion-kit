# Launch: {{SITE_NAME}}

Live site: {{ORIGIN}} ({{HOST}}). Host: {{HOSTING}}. Scaffolded {{DATE}}.

## A. Needs you

Things only a person with the accounts can do. Tick each one.

- [ ] Access to the domain's DNS for {{HOST}}.
- [ ] A {{HOSTING}} project connected to this repository.
- [ ] Form endpoint and the inbox it delivers to (test with forms@example.com style addresses only).
- [ ] Analytics and tag manager access, so the same IDs carry over (see `docs/third-party.md`).
- [ ] Sign-off on every entry in `exceptions.json` and every proposal in `proposals.json`.
- [ ] Search console access for {{HOST}}.

## B. Closeout

- [ ] `npm run build && npm run verify` passes on `astro-rebuild`.
- [ ] Visual review passes (`npm run review:shoot && npm run review:diff`), or each miss is an exception.
- [ ] `npm run redirects:build` run and the output committed.
- [ ] Preview deployment: `{{DEPLOY_PREVIEW}}`
- [ ] Preview is noindex (view source: `noindex, nofollow`; robots.txt disallows all).
- [ ] Forms submit on the preview to the test address.
- [ ] Pull request from `astro-rebuild` to `main` reviewed and merged by a person.

## C. Launch day

1. Set `PUBLIC_INDEXABLE=true` for production builds only: {{ENV_COMMAND}}
2. Run `PUBLIC_INDEXABLE=true npm run build && npm run verify:release` locally; it must pass.
3. Deploy production: `{{DEPLOY_PRODUCTION}}`
4. Point DNS for {{HOST}} at {{HOSTING}}: {{DNS_NOTE}}
5. Once the certificate is issued, run `npm run verify:live`.
6. Submit `{{ORIGIN}}/sitemap.xml` in search console.
7. Keep the old host running, untouched, until section D is done.

## D. 30-day watch

- [ ] Day 1: `npm run verify:live`; check the host's 404 log for missed redirects; add rows to
      `redirects.csv` and redeploy.
- [ ] Day 3: forms received, analytics events arriving.
- [ ] Day 7: search console coverage and crawl errors.
- [ ] Day 14: compare organic traffic with the same period before launch.
- [ ] Day 30: final `npm run verify:live`; then the old host can be retired by its owner.
