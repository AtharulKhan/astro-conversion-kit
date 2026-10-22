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
const ROW_KEYS = ['decision', 'heightA', 'heightB', 'heightMismatch', 'offset', 'pass', 'percent', 'percentUnaligned', 'reason', 'route', 'threshold', 'width'];
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

const diff = (a, b, out, extra = [], options = {}) => run('diff.mjs', ['--a', a, '--b', b, '--out', out, ...extra], options);
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
    assert.equal(row.heightMismatch, false);
    assert.equal(row.threshold, 0.5);
    assert.equal(row.reason, null);
    assert.equal(row.decision, null);
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

// The page with only its top `rows` rows, as when the new build lost its footer.
function cropped(png, rows) {
  const out = new PNG({ width: png.width, height: rows });
  png.data.copy(out.data, 0, 0, png.width * rows * 4);
  return out;
}

test('the extra rows of a taller page count as differing pixels and are painted red in the diff image', async () => {
  const original = readPng(join(A, 'home', '1440.png'));
  const taller = new PNG({ width: original.width, height: Math.ceil(original.height * 1.05) });
  taller.data.fill(255);
  original.data.copy(taller.data);
  const { result, row } = await diffHome('taller', taller, 1440);
  assert.equal(result.code, 1);
  const extra = taller.height - original.height;
  assert.equal(row.percent, Math.round((extra / taller.height) * 100 * 1000) / 1000);
  assert.equal(row.pass, false);
  assert.equal(row.heightB, taller.height);
  assert.equal(row.heightMismatch, true);
  assert.match(result.stdout, new RegExp(`${extra} rows on one side only`));
  const image = readPng(join(ROOT, 'taller-out', 'home', '1440.png'));
  assert.equal(image.height, taller.height);
  const last = (image.height - 1) * image.width * 4;
  assert.deepEqual([...image.data.subarray(last, last + 4)], [255, 0, 0, 255]);
});

test('a missing footer 1 percent of the page tall fails, though the rows both sides have match', async () => {
  const original = readPng(join(A, 'home', '1440.png'));
  const short = cropped(original, original.height - Math.ceil(original.height * 0.01));
  const { result, row } = await diffHome('no-footer', short, 1440);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(row.pass, false);
  assert.ok(row.percent >= 1, `percent ${row.percent}`);
  assert.equal(row.heightMismatch, true);
});

test('a height difference of a few rows is counted, and passes when the count stays under the threshold', async () => {
  const original = readPng(join(A, 'home', '1440.png'));
  const { result, row } = await diffHome('few-rows', cropped(original, original.height - 3), 1440);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(row.pass, true);
  assert.ok(row.percent > 0 && row.percent <= 0.5, `percent ${row.percent}`);
  assert.equal(row.heightMismatch, true);
});

// The home page with a magenta band across `fraction` of its rows: a difference of that size.
function banded(fraction) {
  const original = readPng(join(A, 'home', '1440.png'));
  const noisy = new PNG({ width: original.width, height: original.height });
  original.data.copy(noisy.data);
  const rows = Math.ceil(original.height * fraction);
  for (let i = 0; i < original.width * rows * 4; i += 4) noisy.data.set([255, 0, 255, 255], i);
  return noisy;
}

const OVERRIDE = { id: 'd12', threshold: 2, reason: 'hero video differs per load' };

test('--overrides entries with a decision id and a reason loosen the gate to at most 2 % and are reported', async () => {
  const overrides = join(ROOT, 'overrides.json');
  writeFileSync(overrides, JSON.stringify({ home: OVERRIDE }));
  assert.equal((await diffHome('strict', banded(0.01), 1440)).result.code, 1);
  const { result, row } = await diffHome('loose', banded(0.01), 1440, ['--overrides', overrides]);
  assert.equal(result.code, 0, result.stdout);
  assert.ok(row.percent > 0.5 && row.percent <= 2, `percent ${row.percent}`);
  assert.equal(row.threshold, 2);
  assert.equal(row.reason, 'hero video differs per load');
  assert.equal(row.decision, 'd12');
  assert.match(result.stdout, /threshold 2% \(d12\): hero video differs per load/);
  assert.equal((await diffHome('global', banded(0.01), 1440, ['--threshold', '2'])).result.code, 0);
});

test('the overrides file defaults to docs/visual-overrides.json in the folder diff runs from', async () => {
  const site = join(ROOT, 'site');
  mkdirSync(join(site, 'docs'), { recursive: true });
  writeFileSync(join(site, 'docs', 'visual-overrides.json'), JSON.stringify({ home: OVERRIDE }));
  const out = join(ROOT, 'default-overrides-out');
  const a = tree('default-overrides-a', join(A, 'home', '1440.png'));
  const result = await diff(a, tree('default-overrides-b', banded(0.01)), out, [], { cwd: site });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(readDiff(out)[0].decision, 'd12');
  rmSync(join(site, 'docs', 'visual-overrides.json'));
  assert.equal((await diff(a, a, out, [], { cwd: site })).code, 0, 'no file there means no overrides');
  assert.equal((await diff(a, a, out, ['--overrides', join(site, 'docs', 'visual-overrides.json')])).code, 2, 'a named file must exist');
});

test('an override without an id or a reason, a non-numeric threshold, or a threshold over 2 % exits 2', async () => {
  const a = tree('bad-override-a', join(A, 'home', '1440.png'));
  for (const value of [
    null, 3, { threshold: 1, reason: 'x' }, { id: '', threshold: 1, reason: 'x' }, { id: 'd1', threshold: 1 },
    { id: 'd1', threshold: null, reason: 'x' }, { id: 'd1', threshold: '1', reason: 'x' }, { id: 'd1', threshold: 1, reason: '' },
    { id: 'd1', threshold: 2.5, reason: 'x' }, { id: 'd1', threshold: 100, reason: 'x' }, { id: 'd1', threshold: -1, reason: 'x' },
  ]) {
    const overrides = join(ROOT, 'bad-overrides.json');
    writeFileSync(overrides, JSON.stringify({ home: value }));
    const result = await diff(a, a, join(ROOT, 'bad-override-out'), ['--overrides', overrides]);
    assert.equal(result.code, 2, JSON.stringify(value));
  }
  const old = await diff(a, a, join(ROOT, 'bad-override-out'), ['--per-route', join(ROOT, 'bad-overrides.json')]);
  assert.equal(old.code, 2, '--per-route is gone');
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
