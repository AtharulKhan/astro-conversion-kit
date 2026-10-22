// The host resolvers against hand-written rule tables and a small dist.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveVercel } from '../../skills/parity-gates/scripts/lib/vercel-resolver.mjs';
import { parseRedirectsFile, resolveCloudflare } from '../../skills/parity-gates/scripts/lib/cloudflare-resolver.mjs';
import { SLASH_RULES, vercelRules } from '../../skills/parity-gates/scripts/build-redirects.mjs';

const FILES = ['index.html', 'feed/index.xml', 'about/index.html', 'news/index.html', 'news/a/index.html', 'kept/index.html', 'people/ann/index.html', 'y/index.html',
  'upgrade-guide/3.5/index.html', 'files/guide.pdf', 'files/Photo.JPG',
  'files/report.docx', 'files/Photo.Jpg', 'files/data.Qxz'];
let dist;
before(() => {
  dist = mkdtempSync(join(tmpdir(), 'resolvers-'));
  for (const file of FILES) {
    mkdirSync(dirname(join(dist, file)), { recursive: true });
    writeFileSync(join(dist, file), '<!doctype html>');
  }
});
after(() => rmSync(dist, { recursive: true, force: true }));

const cf = (text, url) => resolveCloudflare(url, { rules: parseRedirectsFile(text), dist });
const vc = (config, url, origins) => resolveVercel(url, { config, dist, origins });
const hop = (from, to, status = 301) => ({ from, to, status });

test('cloudflare: static rules win over dynamic ones whatever the file order', () => {
  const text = '/blog/* /news/:splat/ 301\n/blog/keep /kept/ 301\n';
  assert.deepEqual(cf(text, '/blog/keep').hops, [hop('/blog/keep', '/kept/')]);
  assert.deepEqual(cf(text, '/blog/a').hops, [hop('/blog/a', '/news/a/')]);
});

test('cloudflare: a placeholder matches one segment; an empty splat; no status means 302', () => {
  const text = '/team/:name /people/:name/ 301\n/old/* /news/:splat 301\n/x /y/\n';
  assert.deepEqual(cf(text, '/team/ann'), { hops: [hop('/team/ann', '/people/ann/')], final: { path: '/people/ann/', status: 200 } });
  assert.deepEqual(cf(text, '/team/a/b').hops, [], 'a placeholder does not cross a slash');
  assert.deepEqual(cf(text, '/old/').hops, [hop('/old/', '/news/')]);
  assert.deepEqual(cf(text, '/x').hops, [hop('/x', '/y/', 302)]);
  assert.deepEqual(cf(text, '/X').hops, [], 'case-sensitive');
});

test('cloudflare: the query is carried; Pages slash handling counts as a hop', () => {
  assert.deepEqual(cf('/x /y/ 301\n', '/x?utm=1').hops, [hop('/x?utm=1', '/y/?utm=1')]);
  assert.deepEqual(cf('', '/about').hops, [hop('/about', '/about/', 308)]);
  assert.deepEqual(cf('', '/about/index.html').hops, [hop('/about/index.html', '/about/', 308)]);
});

test('vercel: an exact rewrite serves its destination when no file answers; a file wins over it', () => {
  const config = { rewrites: [{ source: '/feed/', destination: '/feed/index.xml' }, { source: '/about/', destination: '/missing.xml' }] };
  assert.deepEqual(vc(config, '/feed/'), { hops: [], final: { path: '/feed/', status: 200 } });
  assert.deepEqual(vc({}, '/feed/'), { hops: [], final: { path: '/feed/', status: 404 } });
  assert.deepEqual(vc(config, '/about/'), { hops: [], final: { path: '/about/', status: 200 } });
  assert.deepEqual(vc({ rewrites: [{ source: '/gone/', destination: '/nothing.xml' }] }, '/gone/').final.status, 404);
});

test('cloudflare: a 200 line rewrites to its target without a hop', () => {
  assert.deepEqual(cf('/feed/ /feed/index.xml 200\n', '/feed/'), { hops: [], final: { path: '/feed/', status: 200 } });
  assert.deepEqual(cf('/x/ /nothing.xml 200\n', '/x/'), { hops: [], final: { path: '/x/', status: 404 } });
});

test('vercel: has and missing query conditions', () => {
  const config = {
    redirects: [
      { source: '/', has: [{ type: 'query', key: 'p', value: '1' }], destination: '/about/', statusCode: 301 },
      { source: '/m', missing: [{ type: 'query', key: 'skip' }], destination: '/y/', statusCode: 301 },
    ],
  };
  assert.deepEqual(vc(config, '/?p=1').hops, [hop('/?p=1', '/about/?p=1')]);
  assert.deepEqual(vc(config, '/?p=11').hops, [], 'the value is matched whole');
  assert.deepEqual(vc(config, '/m').hops, [hop('/m', '/y/')]);
  assert.deepEqual(vc(config, '/m?skip=1').hops, []);
});

test('vercel: inline regex, optional and one-or-more parameters, case-sensitive sources', () => {
  const config = {
    redirects: [
      { source: '/post/:id(\\d+)', destination: '/news/', statusCode: 301 },
      { source: '/opt/:x?', destination: '/o/:x?', statusCode: 302 },
      { source: '/plus/:rest+', destination: '/p/:rest+', statusCode: 301 },
      { source: '/About', destination: '/about/', statusCode: 301 },
    ],
  };
  assert.deepEqual(vc(config, '/post/12').hops, [hop('/post/12', '/news/')]);
  assert.deepEqual(vc(config, '/post/ab').hops, []);
  assert.deepEqual(vc(config, '/opt').hops, [hop('/opt', '/o', 302)]);
  assert.deepEqual(vc(config, '/opt/a').hops, [hop('/opt/a', '/o/a', 302)]);
  assert.deepEqual(vc(config, '/plus').hops, []);
  assert.deepEqual(vc(config, '/plus/a/b').hops, [hop('/plus/a/b', '/p/a/b')]);
  assert.deepEqual(vc(config, '/about').hops, [], 'no rule for the lower-case path');
});

test('vercel: cleanUrls redirects', () => {
  const config = { cleanUrls: true };
  assert.deepEqual(vc(config, '/about.html').hops, [hop('/about.html', '/about', 308)]);
  assert.deepEqual(vc(config, '/news/index').hops, [hop('/news/index', '/news', 308)]);
  assert.deepEqual(vc(config, '/index.html').hops, [hop('/index.html', '/', 308)]);
  assert.deepEqual(vc({ cleanUrls: true, trailingSlash: true }, '/about.html').hops, [hop('/about.html', '/about/', 308)]);
});

test('vercel: external targets end the chain; own-origin targets continue', () => {
  const config = {
    redirects: [
      { source: '/out', destination: 'https://elsewhere.example.com/x', statusCode: 302 },
      { source: '/home', destination: 'https://www.example.com/about/', statusCode: 301 },
    ],
  };
  assert.deepEqual(vc(config, '/out'), {
    hops: [hop('/out', 'https://elsewhere.example.com/x', 302)],
    final: { path: 'https://elsewhere.example.com/x', status: null },
  });
  assert.deepEqual(vc(config, '/home', ['https://www.example.com']), {
    hops: [hop('/home', 'https://www.example.com/about/')],
    final: { path: '/about/', status: 200 },
  });
});

test('vercel: loops end with status "loop", including a query rule to its own path', () => {
  const pingPong = { redirects: [{ source: '/a', destination: '/b', statusCode: 301 }, { source: '/b', destination: '/a', statusCode: 301 }] };
  const loop = vc(pingPong, '/a');
  assert.equal(loop.final.status, 'loop');
  assert.deepEqual(loop.hops, [hop('/a', '/b'), hop('/b', '/a')]);
  const self = { redirects: [{ source: '/', has: [{ type: 'query', key: 'p', value: '2' }], destination: '/', statusCode: 301 }] };
  assert.deepEqual(vc(self, '/?p=2'), { hops: [hop('/?p=2', '/?p=2')], final: { path: '/?p=2', status: 'loop' } });
  // A chain that never repeats still stops at the hop limit.
  const endless = { redirects: [{ source: '/n/:k', destination: '/n/:k/x', statusCode: 301 }, { source: '/n/:k/:rest+', destination: '/n/:k-:rest', statusCode: 301 }] };
  assert.equal(vc(endless, '/n/a').final.status, 'loop');
});

// A version-numbered page such as /upgrade-guide/3.5/ is not a file: ".5" is no static-file extension.
test('vercel: the compiled slash rules leave a dotted page alone and only treat real file extensions as files', () => {
  const always = { redirects: vercelRules([], 'always') };
  assert.deepEqual(vc(always, '/upgrade-guide/3.5/'), { hops: [], final: { path: '/upgrade-guide/3.5/', status: 200 } });
  assert.deepEqual(vc(always, '/upgrade-guide/3.5').hops, [hop('/upgrade-guide/3.5', '/upgrade-guide/3.5/', 308)]);
  assert.deepEqual(vc(always, '/files/guide.pdf'), { hops: [], final: { path: '/files/guide.pdf', status: 200 } });
  assert.deepEqual(vc(always, '/files/Photo.JPG').hops, []);
  assert.deepEqual(vc(always, '/files/guide.pdf/').hops, [hop('/files/guide.pdf/', '/files/guide.pdf', 308)]);
  assert.deepEqual(vc(always, '/about').hops, [hop('/about', '/about/', 308)]);
  assert.deepEqual(vc(always, '/.well-known/x').hops, []);
  assert.ok(SLASH_RULES.always.every((r) => !r.source.includes('\\w')), 'no "any word after a dot" extension test');
});

test('cloudflare: Pages serves a dotted page at its slashed URL without a hop', () => {
  assert.deepEqual(cf('', '/upgrade-guide/3.5/'), { hops: [], final: { path: '/upgrade-guide/3.5/', status: 200 } });
  assert.deepEqual(cf('', '/upgrade-guide/3.5').hops, [hop('/upgrade-guide/3.5', '/upgrade-guide/3.5/', 308)]);
  assert.deepEqual(cf('', '/files/guide.pdf').hops, []);
});

test('vercel: office, media and archive types count as files in any letter case; a found extension is added', () => {
  const always = { redirects: vercelRules([], 'always') };
  for (const file of ['/files/report.docx', '/files/Photo.Jpg']) assert.deepEqual(vc(always, file).hops, [], file);
  // Not in the base list: redirected unless the compiler found the extension in the site's files.
  assert.deepEqual(vc(always, '/files/data.Qxz').hops, [hop('/files/data.Qxz', '/files/data.Qxz/', 308)]);
  const found = { redirects: vercelRules([], 'always', ['Qxz']) };
  assert.deepEqual(vc(found, '/files/data.Qxz').hops, []);
  assert.deepEqual(vc(found, '/upgrade-guide/3.5').hops, [hop('/upgrade-guide/3.5', '/upgrade-guide/3.5/', 308)]);
});
