import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// These skills are copied into site repositories on their own, so every relative import in them
// must stay inside the skill.
const SKILLS = fileURLToPath(new URL('../../skills/', import.meta.url));
const SELF_CONTAINED = ['parity-gates', 'visual-review', 'convert-site'];
const CODE = /\.(?:mjs|js|cjs|ts|astro)$/;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;

function codeFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : codeFiles(full);
    return CODE.test(entry.name) ? [full] : [];
  });
}

function escapingImports(skillDir) {
  const escapes = [];
  for (const file of codeFiles(skillDir)) {
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const target = resolve(dirname(file), match[2]);
      const inside = relative(skillDir, target);
      if (inside.startsWith('..') || inside.startsWith(sep)) escapes.push(`${relative(SKILLS, file)} -> ${match[2]}`);
    }
  }
  return escapes;
}

for (const skill of SELF_CONTAINED) {
  test(`every relative import under skills/${skill}/ stays inside it`, () => {
    assert.deepEqual(escapingImports(join(SKILLS, skill)), []);
  });
}

test('the check finds an import that leaves the skill', () => {
  // capture-site imports the gate libraries, so it is the known counter-example.
  assert.ok(escapingImports(join(SKILLS, 'capture-site')).some((line) => line.includes('parity-gates/scripts/lib/')));
});
