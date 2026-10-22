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
let fixture;

const shoot = (routes, out) =>
  run('shoot.mjs', ['--base', fixture.origin, '--routes', routes, '--widths', '1440', '--out', out, '--delay', '0', '--wait', '0']);

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

// A one-route tree holding a single home/1440.png, for comparing different images.
function tree(name, png) {
  const dir = join(ROOT, name);
  mkdirSync(join(dir, 'home'), { recursive: true });
  if (typeof png === 'string') copyFileSync(png, join(dir, 'home', '1440.png'));
  else writeFileSync(join(dir, 'home', '1440.png'), PNG.sync.write(png));
  return dir;
}

test('shooting the same pages twice diffs to 0 percent and exits 0', async () => {
  const out = join(ROOT, 'same');
  const result = await diff(A, B, out);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const rows = readDiff(out);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['heightA', 'heightB', 'pass', 'percent', 'route', 'width']);
    assert.equal(row.percent, 0);
    assert.equal(row.pass, true);
    assert.equal(row.heightA, row.heightB);
  }
  assert.ok(existsSync(join(out, 'home', '1440.png')));
});

test('home against about differs by more than 5 percent and exits 1', async () => {
  const a = tree('home-a', join(A, 'home', '1440.png'));
  const b = tree('about-as-home', join(A, 'about', '1440.png'));
  const out = join(ROOT, 'home-vs-about');
  const result = await diff(a, b, out);
  assert.equal(result.code, 1);
  const [row] = readDiff(out);
  assert.ok(row.percent > 5, `percent ${row.percent}`);
  assert.equal(row.pass, false);
});

// A whole-page 1px shift moves every glyph and image edge (about 0.9 % at 1440)
// and is a real difference; this is one component nudged by a pixel.
test('a copy with the header shifted by one pixel passes', async () => {
  const original = readPng(join(A, 'home', '1440.png'));
  const shifted = new PNG({ width: original.width, height: original.height });
  original.data.copy(shifted.data);
  const headerBytes = original.width * 80 * 4;
  original.data.copy(shifted.data, 4, 0, headerBytes - 4);
  const out = join(ROOT, 'shifted-out');
  const result = await diff(tree('unshifted', join(A, 'home', '1440.png')), tree('shifted', shifted), out);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(readDiff(out)[0].pass, true);
});

test('a height difference over 2 percent fails even when the common area matches', async () => {
  const original = readPng(join(A, 'home', '1440.png'));
  const taller = new PNG({ width: original.width, height: Math.ceil(original.height * 1.05) });
  taller.data.fill(255);
  original.data.copy(taller.data);
  const out = join(ROOT, 'taller-out');
  const result = await diff(tree('orig', join(A, 'home', '1440.png')), tree('taller', taller), out);
  assert.equal(result.code, 1);
  const [row] = readDiff(out);
  assert.equal(row.percent, 0);
  assert.equal(row.pass, false);
  assert.equal(row.heightB, taller.height);
});

test('--per-route overrides loosen the gate for that route only', async () => {
  const original = readPng(join(A, 'home', '1440.png'));
  const noisy = new PNG({ width: original.width, height: original.height });
  original.data.copy(noisy.data);
  noisy.data.fill(0, 0, original.width * 200 * 4); // black out the top 200 rows
  const overrides = join(ROOT, 'overrides.json');
  writeFileSync(overrides, JSON.stringify({ home: 100 }));
  const a = tree('override-a', join(A, 'home', '1440.png'));
  const b = tree('override-b', noisy);
  assert.equal((await diff(a, b, join(ROOT, 'override-strict'))).code, 1);
  assert.equal((await diff(a, b, join(ROOT, 'override-loose'), ['--per-route', overrides])).code, 0);
  assert.equal((await diff(a, b, join(ROOT, 'override-global'), ['--threshold', '100'])).code, 0);
});

test('a screenshot missing from --b fails, and bad usage exits 2', async () => {
  const empty = join(ROOT, 'empty');
  mkdirSync(empty, { recursive: true });
  const out = join(ROOT, 'missing-out');
  assert.equal((await diff(tree('lonely', join(A, 'home', '1440.png')), empty, out)).code, 1);
  assert.equal(readDiff(out)[0].pass, false);
  assert.equal((await run('diff.mjs', ['--a', A])).code, 2);
  assert.equal((await run('diff.mjs', ['--a', A, '--b', B, '--out', out, '--threshold', 'x'])).code, 2);
  const help = await run('diff.mjs', ['--help']);
  assert.equal(help.code, 0);
});
