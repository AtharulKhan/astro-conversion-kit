# Security

What converting to static output changes, and what it does not.

## What goes away

A converted site is HTML, CSS, fonts, images and whatever client-side scripts you keep, served as
files. There is no PHP, no Node, no database and no admin login on the server. The one optional
exception is on Cloudflare Pages when media is too large for the repository: a Pages Function of
about twenty lines, running on Cloudflare's Workers runtime, reads media from R2. It only reads
objects by path and has no other inputs. That removes the
classes of attack that need them:

- Remote code execution through the language runtime (PHP or Node.js vulnerabilities in the
  request path).
- Plugin and theme vulnerabilities, which are most of the published WordPress advisories.
- SQL injection, because there is no database.
- Brute-forced or phished admin logins, because there is no admin.
- Unpatched installs: a static file does not go out of date the way a CMS does.

## What stays

**The build tooling runs Node.** Astro, the gates and the visual review run on your machine and in
CI. Their dependencies are code you execute, and Node itself gets security releases. Keep Node on a
supported line and update dependencies. The kit refuses to run on end-of-life Node (Node 20 and
older, and Node 22 or 24 releases older than the minimums in `package.json`) and pins its own
dependencies to exact versions. The converted site pins the same versions; run `npm audit` and
update them as you would any project. A compromised build machine can still ship a compromised
site.

**Third-party scripts are your choice.** Form endpoints, analytics, tag managers, pixels, chat
widgets and embeds run in your visitors' browsers with the same access as your own code. The kit
carries over exactly the ones the live site had, lists each in `docs/third-party.md` with a keep or
drop decision, and the gates fail if anything else appears. Whether those vendors are trustworthy
is a decision the kit cannot make for you. A tag manager in particular can load anything its
account holders add later.

**Forms leave your site.** Submissions go to the third-party endpoint you chose at intake. Its
spam handling, data retention and where the data is stored are that vendor's. The kit keeps the
honeypot field and the field names, and the one test submission goes only to the address you gave.

**The host's edge handles TLS and headers.** Certificates, HTTPS redirects and HTTP/2 or HTTP/3 are
the host's job. The kit ships a baseline set of headers in `vercel.json` or `_headers`:
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and
`X-Frame-Options: SAMEORIGIN`. It does not ship a Content-Security-Policy or HSTS, because a wrong
CSP breaks the third-party scripts you kept and HSTS is hard to undo; add them deliberately once
the site is live. Vercel sends Strict-Transport-Security on its domains by default; the kit itself
adds none. `post-launch` checks the headers the live host actually sends.

**Accounts still matter.** Whoever controls your Git host, hosting account, DNS registrar and media
store controls the site. Turn on two-factor authentication on all of them.

**The old site is still there until you remove it.** Converting does not patch it. Until DNS moves
and the old host is switched off, it is as exposed as it was. The runbook keeps it running through
the 30-day watch; plan its shutdown, and do not leave it reachable on another hostname.

## What the kit does with credentials

It never asks for a password or token in chat and never writes one to a repository. Hosting and
Git access go through the CLIs' own logins (`gh`, `vercel`, `wrangler`). Media store credentials
are read from environment variables at upload time. Preflight reports whether a CLI is logged in
without printing any token.

## Reporting a problem in the kit

Open an issue on the repository for anything that is not sensitive. For a vulnerability, use
GitHub's private vulnerability reporting on the repository instead of a public issue.
