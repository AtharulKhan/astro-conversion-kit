// The fixture site's baseline for the gate tests: capture -> media -> templates -> build-baseline,
// run once per directory and cached for the test file. buildFixtureBaseline(dir) resolves to the
// baseline folder (<dir>/baseline); the capture is in <dir>/capture and redirects.csv in <dir>.
// The capture seeds /old-services and /about so the baseline has a redirect chain and a slash
// redirect besides the shortlinks. buildFixtureBaseline(dir, { exclude }) captures with
// --exclude <exclude> (a comma-separated prefix list) instead.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../../fixture/serve.mjs';

const exec = promisify(execFile);
const script = (path) => fileURLToPath(new URL(`../../../skills/${path}`, import.meta.url));
const cache = new Map();

async function run(path, args) {
  try {
    await exec(process.execPath, [script(path), ...args]);
  } catch (error) {
    throw new Error(`${path} exited ${error.code}: ${error.stderr || error.message}`);
  }
}

async function build(dir, { exclude = null } = {}) {
  const capture = join(dir, 'capture');
  const baseline = join(dir, 'baseline');
  // Async child processes: the fixture server runs in this process and must keep answering.
  const fixture = await startFixture();
  try {
    await run('capture-site/scripts/capture.mjs', [
      fixture.origin, '--out', capture, '--delay', '0', '--no-wayback', '--seed', '/old-services', '--seed', '/about',
      ...(exclude ? ['--exclude', exclude] : []),
    ]);
    await run('capture-site/scripts/media.mjs', ['--capture', capture, '--delay', '0']);
    await run('capture-site/scripts/templates.mjs', ['--capture', capture]);
  } finally {
    await fixture.close();
  }
  await run('parity-gates/scripts/build-baseline.mjs', ['--capture', capture, '--out', baseline]);
  return baseline;
}

export function buildFixtureBaseline(dir, options = {}) {
  if (!cache.has(dir)) cache.set(dir, build(dir, options));
  return cache.get(dir);
}
