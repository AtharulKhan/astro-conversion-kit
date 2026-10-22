import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const DOCS = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  ...(existsSync(join(ROOT, 'docs')) ? readdirSync(join(ROOT, 'docs')) : [])
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`),
];

// Kit scripts the README names that later tasks have not written yet.
// Remove each entry when its script lands; remove the set when it is empty.
const SHIPS_IN_A_LATER_TASK = new Set([
  'skills/capture-site/scripts/capture.mjs',
]);

function fencedBlocks(markdown) {
  return [...markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]);
}

// Inline links and images, outside fenced blocks, that point inside the repository.
function relativeLinks(markdown) {
  const prose = markdown.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
  return [...prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'));
}

test('the required documents exist', () => {
  for (const path of [
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'docs/process.md',
    'docs/hosting.md',
    'docs/platforms.md',
    'docs/dependencies.md',
    'docs/faq.md',
    'docs/security.md',
  ]) {
    assert.ok(existsSync(join(ROOT, path)), `${path} is missing`);
  }
});

test('CLAUDE.md is byte-equal to AGENTS.md', () => {
  assert.ok(readFileSync(join(ROOT, 'CLAUDE.md')).equals(readFileSync(join(ROOT, 'AGENTS.md'))));
});

test('README carries the paste line, both install paths and the examples heading', () => {
  const readme = read('README.md');
  assert.ok(
    readme.includes('Convert https://example.com to Astro with https://github.com/ethanplusai/astro-conversion-kit'),
    'paste line',
  );
  const blocks = fencedBlocks(readme).join('\n');
  assert.match(blocks, /^npx skills add ethanplusai\/astro-conversion-kit$/m, 'npx skills add block');
  assert.match(blocks, /^\/plugin marketplace add ethanplusai\/astro-conversion-kit$/m, 'plugin marketplace line');
  assert.match(blocks, /^\/plugin install astro-conversion/m, 'plugin install line');
  assert.match(readme, /^## Examples$/m, 'examples heading');
});

test('README stays under 200 lines', () => {
  assert.ok(read('README.md').split('\n').length < 200);
});

test('every relative link in the docs resolves', () => {
  const broken = [];
  for (const doc of DOCS) {
    for (const target of relativeLinks(read(doc))) {
      const path = decodeURIComponent(target.split('#')[0]);
      if (!path) continue;
      if (!existsSync(resolve(ROOT, dirname(doc), path))) broken.push(`${doc}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('every kit script a README command names exists or ships in a later task', () => {
  const missing = [];
  for (const block of fencedBlocks(read('README.md'))) {
    for (const [path] of block.matchAll(/(?:skills|scripts)\/[\w./-]+\.mjs/g)) {
      if (!existsSync(join(ROOT, path)) && !SHIPS_IN_A_LATER_TASK.has(path)) missing.push(path);
    }
  }
  assert.deepEqual(missing, []);
});

test('docs/dependencies.md justifies exactly the dependencies in package.json', () => {
  const deps = Object.keys(JSON.parse(read('package.json')).dependencies).sort();
  const headings = [...read('docs/dependencies.md').matchAll(/^## `?([\w@/.-]+)`?$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(headings, deps);
});
