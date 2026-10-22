import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { startFixture } from '../fixture/serve.mjs';
import { run, readPng, TMP } from './helpers.mjs';

const ROOT = join(TMP, 'visual-diff');
const A = join(ROOT, 'a');
const B = join(ROOT, 'b');
const ROW_KEYS = ['heightA', 'heightB', 'offset', 'pass', 'percent', 'percentUnaligned', 'reason', 'route', 'threshold', 'width'];
let fixture;

const shoot = (routes, out) =>
  run('shoot.mjs', ['--base', fixture.origin, '--routes', routes, '--widths', '390,1440', '--out', out, '--delay', '0', '--wait', '0']);

before(async () => {
  fixture = await startFixture();
  rmSync(ROOT, { recursive: true, force: true });
  for (const out of [A, B]) {
    const result = await shoot('/,/about/', out);
    assert.equal(result.code, 0, result.stderr);
  }
});
after(() => fixture.close());

const diff = (a, b, out, extra = []) => run('diff.mjs', ['--a', a, '--b', b, '--out', out, ...extra]);
const readDiff = (out) => JSON.parse(readFileSync(join(out, 'diff.json'), 'utf8'));

// A one-route tree holding a single home/<width>.png, for comparing different images.
function tree(name, png, width = 1440) {
  const dir = join(ROOT, name);
  mkdirSync(join(dir, 'home'), { recursive: true });
  const file = join(dir, 'home', `${width}.png`);
  if (typeof png === 'string') copyFileSync(png, file);
  else if (Buffer.isBuffer(png)) writeFileSync(file, png);
  else writeFileSync(file, PNG.sync.write(png));
  return dir;
}

// The whole image moved by (dx, dy); uncovered pixels are white.
function shifted(png, dx, dy) {
  const out = new PNG({ width: png.width, height: png.height });
  out.data.fill(255);
  for (let y = 0; y < png.height; y += 1) {
    const sy = y - dy;
    if (sy < 0 || sy >= png.height) continue;
    const from = Math.max(0, -dx);
    const to = Math.min(png.width, png.width - dx);
    png.data.copy(out.data, (y * png.width + from + dx) * 4, (sy * png.width + from) * 4, (sy * png.width + to) * 4);
  }
  return out;
}

async function diffHome(name, other, width, extra = []) {
  const out = join(ROOT, `${name}-out`);
  const result = await diff(tree(`${name}-a`, join(A, 'home', `${width}.png`), width), tree(`${name}-b`, other, width), out, extra);
  return { result, row: readDiff(out)[0] };
}

test('shooting the same pages twice diffs to 0 percent and exits 0', async () => {
  const out = join(ROOT, 'same');
  const result = await diff(A, B, out);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const rows = readDiff(out);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ROW_KEYS);
    assert.equal(row.percent, 0);
    assert.equal(row.pass, true);
    assert.deepEqual(row.offset, [0, 0], 'no search when aligned passes');
    assert.equal(row.heightA, row.heightB);
    assert.equal(row.threshold, 0.5);
    assert.equal(row.reason, null);
  }
  assert.ok(existsSync(join(out, 'home', '1440.png')));
});

test('home against about differs by more than 5 percent and exits 1', async () => {
  const { result, row } = await diffHome('home-vs-about', join(A, 'about', '1440.png'), 1440);
  assert.equal(result.code, 1);
  assert.ok(row.percent > 5, `percent ${row.percent}`);
  assert.equal(row.pass, false);
});

// includeAA: false does not absorb a shifted layout (a 1 px shift of the whole
// page measures well over 0.5 % aligned); the ±1 px offset search does.
for (const [dx, dy] of [[1, 0], [0, 1], [1, 1]]) {
  test(`a whole page shifted by (${dx}, ${dy}) px at 390 passes through the offset search`, async () => {
    const home = readPng(join(A, 'home', '390.png'));
    const { result, row } = await diffHome(`shift-${dx}-${dy}`, shifted(home, dx, dy), 390);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(row.pass, true);
    assert.ok(row.percentUnaligned > 0.5, `unaligned ${row.percentUnaligned}% would have failed`);
    assert.deepEqual(row.offset, [dx, dy]);
    assert.match(result.stdout, /offset/);
  });
}

test('a whole page shifted by 2 px fails: the search never goes past 1 px', async () => {
  const home = readPng(join(A, 'home', '390.png'));
  const { result, row } = await diffHome('shift-0-2', shifted(home, 0, 2), 390);
  assert.equal(result.code, 1);
  assert.equal(row.pass, false);
  assert.ok(Math.abs(row.offset[0]) <= 1 && Math.abs(row.offset[1]) <= 1);
});

test('a cascade (everything below row 300 pushed down 1 px) passes', async () => {
  const home = readPng(join(A, 'home', '390.png'));
  const cascade = new PNG({ width: home.width, height: home.height });
  home.data.copy(cascade.data);
  const rowBytes = home.width * 4;
  home.data.copy(cascade.data, 301 * rowBytes, 300 * rowBytes, home.data.length - rowBytes);
  const { result, row } = await diffHome('cascade', cascade, 390);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(row.pass, true);
});

test('a height difference over 2 percent fails even when the common area matches', async () => {
  const original = readPng(join(A, 'home', '1440.png'));
  const taller = new PNG({ width: original.width, height: Math.ceil(original.height * 1.05) });
  taller.data.fill(255);
  original.data.copy(taller.data);
  const { result, row } = await diffHome('taller', taller, 1440);
  assert.equal(result.code, 1);
  assert.equal(row.percent, 0);
  assert.equal(row.pass, false);
  assert.equal(row.heightB, taller.height);
});

function blackedOut() {
  const original = readPng(join(A, 'home', '1440.png'));
  const noisy = new PNG({ width: original.width, height: original.height });
  original.data.copy(noisy.data);
  noisy.data.fill(0, 0, original.width * 200 * 4); // black out the top 200 rows
  return noisy;
}

test('--per-route overrides with a reason loosen the gate and are reported', async () => {
  const overrides = join(ROOT, 'overrides.json');
  writeFileSync(overrides, JSON.stringify({ home: { threshold: 100, reason: 'hero video differs per load' } }));
  assert.equal((await diffHome('strict', blackedOut(), 1440)).result.code, 1);
  const { result, row } = await diffHome('loose', blackedOut(), 1440, ['--per-route', overrides]);
  assert.equal(result.code, 0);
  assert.equal(row.threshold, 100);
  assert.equal(row.reason, 'hero video differs per load');
  assert.match(result.stdout, /threshold 100%: hero video differs per load/);
  assert.equal((await diffHome('global', blackedOut(), 1440, ['--threshold', '100'])).result.code, 0);
});

test('per-route overrides without a reason or with a non-numeric threshold exit 2', async () => {
  const a = tree('bad-override-a', join(A, 'home', '1440.png'));
  for (const value of [null, 3, { threshold: 3 }, { threshold: null, reason: 'x' }, { threshold: '3', reason: 'x' }, { threshold: 3, reason: '' }]) {
    const overrides = join(ROOT, 'bad-overrides.json');
    writeFileSync(overrides, JSON.stringify({ home: value }));
    const result = await diff(a, a, join(ROOT, 'bad-override-out'), ['--per-route', overrides]);
    assert.equal(result.code, 2, JSON.stringify(value));
  }
});

test('a corrupt PNG becomes a failed row, not a crash', async () => {
  const { result, row } = await diffHome('corrupt', Buffer.from('not a png'), 1440);
  assert.equal(result.code, 1);
  assert.equal(row.pass, false);
  assert.match(row.error, /cannot read/);
});

test('a screenshot missing from --b fails, and bad usage exits 2', async () => {
  const empty = join(ROOT, 'empty');
  mkdirSync(empty, { recursive: true });
  const out = join(ROOT, 'missing-out');
  assert.equal((await diff(tree('lonely', join(A, 'home', '1440.png')), empty, out)).code, 1);
  const [row] = readDiff(out);
  assert.equal(row.pass, false);
  assert.match(row.error, /missing/);
  assert.equal((await run('diff.mjs', ['--a', A])).code, 2);
  assert.equal((await run('diff.mjs', ['--a', A, '--b', B, '--out', out, '--threshold', 'x'])).code, 2);
  const help = await run('diff.mjs', ['--help']);
  assert.equal(help.code, 0);
});
