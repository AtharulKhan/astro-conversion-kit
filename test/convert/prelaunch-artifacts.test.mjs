import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactEvidence, capturedFile } from '../../skills/convert-site/scripts/lib/prelaunch-artifacts.mjs';

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-proof-'));
  const env = { dir, dist: join(dir, 'dist') };
  const put = (path, text) => { const file = join(dir, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
  try { run(env, put); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const check = (id, detail, values) => ({ id, detail, evidence: values.map((value) => ({ value })) });

test('vendor comments require complete evidence, captured bytes and an unambiguous full-line comment', () => fixture((env, put) => {
  const source = '(function(){\n // TODO: legacy bookkeeping\n // document the `init` hook\n})();\n';
  put('public/vendor.js', source);
  const base = { assetBytes: () => Buffer.from(source) };
  const finding = check('placeholders.copy', '1 placeholder string in 1 file', ['public/vendor.js:2 — TODO']);
  const proof = (f = finding, b = base) => artifactEvidence(f, env, b, 'd1');
  assert.equal(proof().ok, true);
  assert.equal(artifactEvidence(finding, env, base, null), undefined);
  assert.equal(proof({ ...finding, detail: '2 placeholder strings in 1 file' }).ok, false);
  put('public/vendor.js', source + '// changed\n');
  assert.equal(proof().ok, false, 'changing captured bytes is not accepted');
  for (const text of ['var value = "TODO";\n', 'const value = `\n// TODO\n`;\n', 'var value = "x\\\n// TODO";\n']) {
    put('public/vendor.js', text);
    assert.equal(proof(finding, { assetBytes: () => Buffer.from(text) }).ok, false, text);
  }
  assert.equal(capturedFile(env.dir, '../outside.js'), null);
}));

test('external calculator hosts require exact iframe src parity on the same captured page', () => fixture((env, put) => {
  const src = 'https://calculator.example.vercel.app/calc?theme=dark';
  const html = `<main>\n<iframe src="${src}"></iframe>\n</main>`;
  put('dist/calc/index.html', html);
  const base = { html: (path) => path === '/calc/' ? html : null };
  const finding = check('placeholders.dev-host', '1 development host reference in 1 file', ['dist/calc/index.html:2 — .vercel.app']);
  const proof = (f = finding, b = base) => artifactEvidence(f, env, b, 'd2');
  assert.equal(proof().ok, true);
  assert.equal(proof(finding, { html: () => '<main></main>' }).ok, false);
  put('dist/calc/index.html', html.replace('theme=dark', 'theme=light'));
  assert.equal(proof().ok, false, 'matching hostname alone is not evidence');
  put('dist/calc/index.html', `<main>\n<script>var x="${src}"</script>\n</main>`);
  assert.equal(proof().ok, false, 'a script destination is not a captured iframe');
  put('dist/calc/index.html', html);
  assert.equal(proof({ ...finding, detail: '21 development host references in 21 files' }).ok, false, 'truncated evidence blocks');
  assert.equal(proof(check(finding.id, finding.detail, ['../outside.html:2 — .vercel.app'])).ok, false);
}));

test('feed file rewrites require exact 200 configuration, safe ordering and captured XML bytes', () => fixture((env, put) => {
  const xml = '<rss><channel><title>Captured feed</title></channel></rss>';
  put('dist/feed/index.xml', xml);
  put('dist/_redirects', '/feed/ /feed/index.xml 200\n');
  const base = { feedBytes: (path) => path === '/feed/' ? Buffer.from(xml) : null };
  const value = 'the redirect /feed/ -> /feed/index.xml uses the never form against a always policy';
  const finding = check('framework.trailing-slash', value, [value]);
  const proof = (f = finding) => artifactEvidence(f, env, base, 'd3');
  assert.equal(proof().ok, true);
  put('dist/_redirects', '/feed/ /feed/index.xml 301\n');
  assert.equal(proof().ok, false, 'an HTML redirect is not the feed rewrite');
  put('dist/_redirects', '/* /elsewhere/ 301\n/feed/ /feed/index.xml 200\n');
  assert.equal(proof().ok, false, 'an earlier wildcard might intercept the feed');
  put('dist/_redirects', '/feed/ /feed/index.xml 200\n');
  put('dist/feed/index.xml', xml + '<changed/>');
  assert.equal(proof().ok, false);
  assert.equal(proof({ ...finding, detail: value + '; unlisted finding' }).ok, false);
}));
