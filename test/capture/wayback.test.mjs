import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { cdxUrl, waybackPaths } from '../../skills/capture-site/scripts/lib/wayback.mjs';
import { fetchPaced } from '../../skills/capture-site/scripts/lib/http.mjs';

// Never contacts web.archive.org: every test passes a stubbed fetch.
const cdx = (originals, status = 200) => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify([['original'], ...originals.map((o) => [o])]) };
  };
  return { fetch, calls };
};

test('the CDX query asks for unique 200 URLs on the whole host', () => {
  assert.equal(
    cdxUrl('example.com'),
    'http://web.archive.org/cdx/search/cdx?url=example.com/*&output=json&fl=original&collapse=urlkey&filter=statuscode:200',
  );
});

test('waybackPaths writes exactly the paths the inventory does not have', async () => {
  const { fetch, calls } = cdx([
    'http://example.com/',
    'https://www.example.com/about/',
    'http://example.com:80/old-team/',
    'http://www.example.com/2019/05/summer-sale/?utm_source=x',
    'http://example.com/old-team/',
    'http://example.com/wp-content/uploads/2019/05/sale.jpg',
    'http://example.com/wp-admin/post.php',
    'http://example.com/wp-json/wp/v2/pages',
    'http://other.example.org/elsewhere/',
  ]);
  const out = mkdtempSync(join(tmpdir(), 'wayback-test-'));
  try {
    const paths = await waybackPaths('example.com', { fetch, known: ['/', '/about/'], out });
    assert.deepEqual(paths, ['/2019/05/summer-sale/', '/old-team/']);
    assert.equal(readFileSync(join(out, 'wayback-unverified.txt'), 'utf8'), '/2019/05/summer-sale/\n/old-team/\n');
    assert.equal(calls.length, 1);
    assert.equal(calls[0], cdxUrl('example.com'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the CDX request follows a redirect and allows a slow answer', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith('/cdx/search/cdx')) {
      res.writeHead(301, { Location: req.url.replace('/cdx/search/cdx', '/listing') });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([['original'], ['http://example.com/'], ['http://example.com/gone/']]));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const options = [];
  const fetch = (url, opts) => {
    options.push(opts);
    return fetchPaced(url, { ...opts, delayMs: 0 });
  };
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/cdx/search/cdx`;
    assert.deepEqual(await waybackPaths('example.com', { fetch, endpoint, known: ['/'] }), ['/gone/']);
    assert.equal(seen.length, 2);
    assert.ok(seen[1].startsWith('/listing?url=example.com/*'));
    assert.deepEqual(options, [{ redirect: 'follow', timeoutMs: 120_000 }]);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test('an empty CDX answer is no paths; a failed one throws', async () => {
  const empty = async () => ({ status: 200, headers: {}, body: '' });
  assert.deepEqual(await waybackPaths('example.com', { fetch: empty }), []);
  await assert.rejects(waybackPaths('example.com', { fetch: cdx([], 503).fetch }), /503/);
  const down = async () => ({ status: 0, headers: {}, body: '', error: 'ECONNREFUSED' });
  await assert.rejects(waybackPaths('example.com', { fetch: down }), /ECONNREFUSED/);
  const garbage = async () => ({ status: 200, headers: {}, body: '<html>' });
  await assert.rejects(waybackPaths('example.com', { fetch: garbage }), /JSON/);
});
