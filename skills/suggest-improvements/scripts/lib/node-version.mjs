// Every script calls assertNodeVersion() before doing anything else.
// Supported: 22.x from 22.23.4, and 24.22.1 or newer (24.x and later majors).

export const NODE_VERSION_MESSAGE =
  'Node 22.23.4 or newer is required (Node 20 is end of life and unpatched)';

function parse(version) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

function atLeast(actual, minimum) {
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}

export function isSupportedNodeVersion(version) {
  const parsed = parse(version);
  const [major] = parsed;
  if (major === 22) return atLeast(parsed, [22, 23, 4]);
  if (major >= 24) return atLeast(parsed, [24, 22, 1]);
  return false;
}

export function assertNodeVersion(version = process.versions.node) {
  if (isSupportedNodeVersion(version)) return;
  console.error(`${NODE_VERSION_MESSAGE}; this is Node ${version}.`);
  process.exit(2);
}
