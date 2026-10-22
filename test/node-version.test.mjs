import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNodeVersion, NODE_VERSION_MESSAGE } from '../scripts/lib/node-version.mjs';

function withStubbedExit(fn) {
  const realExit = process.exit;
  const realError = console.error;
  const calls = [];
  const messages = [];
  process.exit = (code) => {
    calls.push(code);
    throw new Error('exit stub');
  };
  console.error = (msg) => messages.push(String(msg));
  try {
    fn();
  } catch (err) {
    if (err.message !== 'exit stub') throw err;
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
  return { calls, messages };
}

for (const version of ['22.23.4', '22.30.0', '24.22.1', '26.0.0']) {
  test(`accepts Node ${version}`, () => {
    const { calls } = withStubbedExit(() => assertNodeVersion(version));
    assert.deepEqual(calls, []);
  });
}

for (const version of ['20.20.0', '22.23.3', '23.5.0', '24.21.0']) {
  test(`rejects Node ${version} with exit 2`, () => {
    const { calls, messages } = withStubbedExit(() => assertNodeVersion(version));
    assert.deepEqual(calls, [2]);
    assert.ok(messages.some((m) => m.includes(NODE_VERSION_MESSAGE)));
  });
}

test('the message names the minimum version and why', () => {
  assert.equal(
    NODE_VERSION_MESSAGE,
    'Node 22.23.4 or newer is required (Node 20 is end of life and unpatched)',
  );
});

test('defaults to the running Node version', () => {
  const { calls } = withStubbedExit(() => assertNodeVersion());
  assert.deepEqual(calls, []);
});
