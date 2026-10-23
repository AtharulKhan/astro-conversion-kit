// The per-host limiter in lib/http.mjs: requests in flight, spacing between starts, backoff on
// 429 and 503, recovery, and the slow-answer rule. Every test runs on its own fixture (its own
// host:port), so no limiter state is shared between tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';
import {
  DEFAULT_CONCURRENCY, DEFAULT_DELAY_MS, fetchPaced, pacing, POLITE_DELAY_MS, resetBlocked,
} from '../../skills/capture-site/scripts/lib/http.mjs';

const exec = promisify(execFile);
const script = (name) => fileURLToPath(new URL(`../../skills/capture-site/scripts/${name}`, import.meta.url));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function withFixture(options, body) {
  const site = await startFixture(options);
  try {
    await body(site);
  } finally {
    resetBlocked();
    await site.close();
  }
}

// n requests to the home page at once, timing when each one started (server side).
async function burst(site, n, options) {
  const get = (path) => fetchPaced(`${site.origin}${path}`, { trusted: [site.origin], ...options });
  return Promise.all(Array.from({ length: n }, () => get('/')));
}

test('the defaults are 400 ms between starts and 4 in flight; polite is 2500 ms', () => {
  assert.equal(DEFAULT_DELAY_MS, 400);
  assert.equal(DEFAULT_CONCURRENCY, 4);
  assert.equal(POLITE_DELAY_MS, 2500);
});

test('at most `concurrency` requests are in flight on one host', async () => {
  await withFixture({ delayMs: 80 }, async (site) => {
    const answers = await burst(site, 10, { delayMs: 0, concurrency: 3 });
    assert.ok(answers.every((r) => r.status === 200));
    assert.equal(site.stats.maxInFlight, 3);
  });
});

test('concurrency 1 serialises the requests', async () => {
  await withFixture({ delayMs: 30 }, async (site) => {
    await burst(site, 5, { delayMs: 0, concurrency: 1 });
    assert.equal(site.stats.maxInFlight, 1);
  });
});

test('delayMs spaces the request starts on a host, however many may be in flight', async () => {
  await withFixture({}, async (site) => {
    const started = Date.now();
    await burst(site, 4, { delayMs: 100, concurrency: 4 });
    const took = Date.now() - started;
    assert.ok(took >= 290, `4 starts 100 ms apart took ${took} ms`);
  });
});

test('a 429 doubles the delay and drops the host to one request in flight', async () => {
  await withFixture({ delayMs: 40, alwaysStatus: { '/busy/': 429 } }, async (site) => {
    const opts = { trusted: [site.origin], delayMs: 60, concurrency: 4, windowMs: 10_000 };
    const busy = await fetchPaced(`${site.origin}/busy/`, opts);
    assert.equal(busy.status, 429);
    site.stats.reset();
    const started = Date.now();
    await burst(site, 4, opts);
    const took = Date.now() - started;
    assert.equal(site.stats.maxInFlight, 1, 'one at a time after a 429');
    assert.ok(took >= 4 * 120 - 20, `4 requests at the doubled 120 ms took ${took} ms`);
  });
});

test('a 503 backs off the same way', async () => {
  await withFixture({ delayMs: 30, alwaysStatus: { '/down/': 503 } }, async (site) => {
    const opts = { trusted: [site.origin], delayMs: 0, concurrency: 4, windowMs: 10_000 };
    await fetchPaced(`${site.origin}/down/`, opts);
    site.stats.reset();
    await burst(site, 4, opts);
    assert.equal(site.stats.maxInFlight, 1);
  });
});

test('after a backoff the host recovers one step per window of clean answers, back to the defaults', async () => {
  await withFixture({ delayMs: 60, alwaysStatus: { '/busy/': 429 } }, async (site) => {
    const opts = { trusted: [site.origin], delayMs: 0, concurrency: 4, windowMs: 600 };
    await fetchPaced(`${site.origin}/busy/`, opts);
    site.stats.reset();
    await burst(site, 4, opts);
    assert.equal(site.stats.maxInFlight, 1, 'still inside the window');
    // One clean answer after each window raises the limit by one: 1 -> 2 -> 3 -> 4.
    for (let step = 2; step <= 4; step += 1) {
      await sleep(620);
      await fetchPaced(`${site.origin}/`, opts);
      site.stats.reset();
      await burst(site, 8, opts);
      assert.equal(site.stats.maxInFlight, step, `step ${step}`);
    }
  });
});

test('a 429 during recovery starts the window again from one in flight', async () => {
  await withFixture({ delayMs: 60, alwaysStatus: { '/busy/': 429 } }, async (site) => {
    const opts = { trusted: [site.origin], delayMs: 0, concurrency: 4, windowMs: 600 };
    await fetchPaced(`${site.origin}/busy/`, opts);
    await sleep(620);
    await fetchPaced(`${site.origin}/`, opts);
    await fetchPaced(`${site.origin}/busy/`, opts);
    site.stats.reset();
    await burst(site, 6, opts);
    assert.equal(site.stats.maxInFlight, 1);
  });
});

test('an answer slower than slowMs halves the concurrency once', async () => {
  await withFixture({ delayMs: 30, pathDelays: { '/slow/': 150 } }, async (site) => {
    const opts = { trusted: [site.origin], delayMs: 0, concurrency: 4, slowMs: 100 };
    await fetchPaced(`${site.origin}/slow/`, opts);
    site.stats.reset();
    await burst(site, 8, opts);
    assert.equal(site.stats.maxInFlight, 2, 'halved from 4');
    await fetchPaced(`${site.origin}/slow/`, opts);
    site.stats.reset();
    await burst(site, 8, opts);
    assert.equal(site.stats.maxInFlight, 2, 'only once');
  });
});

test('403 and network errors still count toward the consecutive blocks, and do not back off', async () => {
  await withFixture({ delayMs: 30, alwaysStatus: { '/no/': 403 } }, async (site) => {
    const { http } = await import('../../skills/capture-site/scripts/lib/http.mjs');
    const opts = { trusted: [site.origin], delayMs: 0, concurrency: 4 };
    resetBlocked();
    await fetchPaced(`${site.origin}/no/`, opts);
    await fetchPaced(`${site.origin}/no/`, opts);
    assert.equal(http.blocked, 2);
    site.stats.reset();
    await burst(site, 8, opts);
    assert.equal(http.blocked, 0);
    assert.equal(site.stats.maxInFlight, 4, 'a 403 is not a reason to slow down');
  });
});

test('pacing: --polite is 2500 ms and one in flight; --delay and --concurrency override either', () => {
  assert.deepEqual(pacing({}), { delayMs: 400, concurrency: 4 });
  assert.deepEqual(pacing({}, { delay: 400, inFlight: 6 }), { delayMs: 400, concurrency: 6 });
  assert.deepEqual(pacing({ polite: true }), { delayMs: 2500, concurrency: 1 });
  assert.deepEqual(pacing({ polite: true, delayMs: 0 }), { delayMs: 0, concurrency: 1 });
  assert.deepEqual(pacing({ polite: true, concurrency: 2 }), { delayMs: 2500, concurrency: 2 });
  assert.deepEqual(pacing({ delayMs: 0, concurrency: 8 }), { delayMs: 0, concurrency: 8 });
});

test('--polite serialises capture, media and assets; every one prints the pacing options', async () => {
  const site = await startFixture({ delayMs: 15 });
  const work = mkdtempSync(join(tmpdir(), 'limiter-polite-test-'));
  try {
    const cap = join(work, 'capture');
    await exec(process.execPath, [script('capture.mjs'), site.origin, '--out', cap, '--polite', '--delay', '0', '--no-wayback']);
    await exec(process.execPath, [script('media.mjs'), '--capture', cap, '--download', join(work, 'media'), '--polite', '--delay', '0']);
    await exec(process.execPath, [script('assets.mjs'), '--capture', cap, '--polite', '--delay', '0']);
    assert.ok(site.requests.length > 30);
    assert.equal(site.stats.maxInFlight, 1, 'one request at a time');
    for (const name of ['capture.mjs', 'media.mjs', 'assets.mjs']) {
      const { stdout } = await exec(process.execPath, [script(name), '--help']);
      assert.match(stdout, /--polite/, name);
      assert.match(stdout, /--concurrency <n>/, name);
      assert.match(stdout, /2500 ms apart/, name);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
    await site.close();
  }
});

test('--concurrency must be a whole number of at least 1', async () => {
  for (const args of [['capture.mjs', 'http://example.com', '--out', 'x'], ['media.mjs', '--capture', 'x'], ['assets.mjs', '--capture', 'x']]) {
    await assert.rejects(exec(process.execPath, [script(args[0]), ...args.slice(1), '--concurrency', '0']), (err) => err.code === 2, args[0]);
  }
});
