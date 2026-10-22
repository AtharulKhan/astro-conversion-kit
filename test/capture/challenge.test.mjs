import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChallenge } from '../../skills/capture-site/scripts/lib/challenge.mjs';

const html = { 'content-type': 'text/html; charset=UTF-8' };
const page = (title) => `<!doctype html><html><head><title>${title}</title></head><body>${'<p>Text.</p>'.repeat(300)}</body></html>`;

// The page SiteGround answered on every request of a real run: 202, under 200 bytes.
const SITEGROUND = '<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F&y=ipr:203.0.113.7:1761100000.000"></meta></head></html>';

test('a SiteGround 202 that refreshes to /.well-known/sgcaptcha/ is a challenge', () => {
  const found = detectChallenge({ status: 202, headers: html, body: SITEGROUND });
  assert.equal(found.provider, 'SiteGround');
  assert.match(found.cause, /202/);
  assert.match(found.cause, /\/\.well-known\/sgcaptcha\//);
});

test('a SiteGround JS redirect, a redirect hop to the captcha, or landing on it is a challenge too', () => {
  const script = '<html><body><script>window.location.href="/.well-known/sgcaptcha/?r=%2F";</script></body></html>';
  assert.equal(detectChallenge({ status: 503, headers: html, body: script }).provider, 'SiteGround');
  const hop = detectChallenge({ status: 302, headers: { location: '/.well-known/sgcaptcha/?r=%2Fabout%2F' }, body: '' });
  assert.equal(hop.provider, 'SiteGround');
  assert.match(hop.cause, /302/);
  const landed = detectChallenge({ status: 200, headers: html, body: page('Robot Challenge Screen'), finalUrl: 'https://example.com/.well-known/sgcaptcha/?r=%2F' });
  assert.equal(landed.provider, 'SiteGround');
});

test('Cloudflare: the cf-mitigated header, or challenge-platform markup on a 403 or 503', () => {
  const header = detectChallenge({ status: 403, headers: { ...html, 'cf-mitigated': 'challenge' }, body: page('Just a moment...') });
  assert.equal(header.provider, 'Cloudflare');
  assert.match(header.cause, /cf-mitigated: challenge/);
  const markup = `<html><head><title>Just a moment...</title></head><body>${'x'.repeat(4000)}<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=1"></script></body></html>`;
  const found = detectChallenge({ status: 503, headers: html, body: markup });
  assert.equal(found.provider, 'Cloudflare');
  assert.match(found.cause, /\/cdn-cgi\/challenge-platform\//);
});

test('generic: a tiny page on 202, 403 or 503 that redirects to a challenge path', () => {
  const meta = '<html><head><meta http-equiv="refresh" content="1; url=/bot-check/?return=/"></head></html>';
  const found = detectChallenge({ status: 403, headers: html, body: meta });
  assert.equal(found.provider, null);
  assert.match(found.cause, /403.*\/bot-check\//);
  const js = '<html><script>location.replace("/captcha?next=%2F")</script></html>';
  assert.match(detectChallenge({ status: 202, headers: html, body: js }).cause, /\/captcha/);
});

test('a success status with a tiny body and no title, or a challenge title, is a challenge', () => {
  const tiny = detectChallenge({ status: 200, headers: html, body: '<html><body><script src="/x.js"></script></body></html>' });
  assert.equal(tiny.provider, null);
  assert.match(tiny.cause, /200 with a \d+-byte page and no title/);
  const titled = detectChallenge({ status: 200, headers: html, body: '<html><head><title>Just a moment...</title></head></html>' });
  assert.match(titled.cause, /titled "Just a moment\.\.\."/);
});

test('ordinary answers are not challenges', () => {
  assert.equal(detectChallenge({ status: 200, headers: html, body: page('Home | Acme') }), null);
  assert.equal(detectChallenge({ status: 200, headers: html, body: '<html><head><title>Acme</title></head><body>Hi</body></html>' }), null);
  assert.equal(detectChallenge({ status: 200, headers: html, body: page('Just a moment...') }), null, 'a large page with that title is content');
  assert.equal(detectChallenge({ status: 404, headers: html, body: '<html><body>gone</body></html>' }), null);
  assert.equal(detectChallenge({ status: 403, headers: html, body: '<html><body>Forbidden</body></html>' }), null);
  assert.equal(detectChallenge({ status: 429, headers: { 'content-type': 'text/plain' }, body: 'Too Many Requests' }), null);
  assert.equal(detectChallenge({ status: 503, headers: { 'content-type': 'text/plain' }, body: 'Status 503' }), null);
  assert.equal(detectChallenge({ status: 301, headers: { location: '/about/' }, body: '' }), null);
  assert.equal(detectChallenge({ status: 200, headers: { 'content-type': 'application/xml' }, body: '<urlset></urlset>' }), null);
  assert.equal(detectChallenge({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *' }), null);
  assert.equal(detectChallenge({ status: 0, headers: {}, body: '' }), null);
  assert.equal(detectChallenge({ status: 'too-large', headers: html, body: '' }), null);
});

test('known signatures are "signature"; the tiny-page rule alone is "heuristic"', () => {
  assert.equal(detectChallenge({ status: 202, headers: html, body: SITEGROUND }).kind, 'signature');
  assert.equal(detectChallenge({ status: 403, headers: { ...html, 'cf-mitigated': 'challenge' }, body: '' }).kind, 'signature');
  assert.equal(detectChallenge({ status: 200, headers: html, body: '<html><body></body></html>' }).kind, 'heuristic');
});

test('Cloudflare Bot Fight Mode script alone on a real 403 or 503 is not a challenge; challenge markers are', () => {
  const jsd = '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>';
  const real = (status) => ({ status, headers: html, body: `<html><head><title>Forbidden | Acme</title></head><body>No.${jsd}</body></html>` });
  assert.equal(detectChallenge(real(403)), null);
  assert.equal(detectChallenge(real(503)), null);
  const orchestrate = '<html><body><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=1"></script></body></html>';
  assert.equal(detectChallenge({ status: 403, headers: html, body: orchestrate }).provider, 'Cloudflare');
  const titled = `<html><head><title>Just a moment...</title></head><body>${jsd}</body></html>`;
  assert.equal(detectChallenge({ status: 503, headers: html, body: titled }).provider, 'Cloudflare');
  assert.equal(detectChallenge({ status: 403, headers: { ...html, 'cf-mitigated': 'challenge' }, body: real(403).body }).provider, 'Cloudflare');
});
