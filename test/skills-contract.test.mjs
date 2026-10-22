import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, 'skills');

// Skills whose SKILL.md has been written. Add each one as its task lands.
const EXPECTED = ['capture-site', 'visual-review'];

const skills = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS, entry.name, 'SKILL.md')))
  .map((entry) => entry.name)
  .sort();

const skillText = (name) => readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');

// SKILL.md plus any references/*.md: every file an agent reads as part of the skill.
function skillDocs(name) {
  const refs = join(SKILLS, name, 'references');
  const files = [join(SKILLS, name, 'SKILL.md')];
  if (existsSync(refs)) {
    for (const file of readdirSync(refs).filter((f) => f.endsWith('.md')).sort()) files.push(join(refs, file));
  }
  return files.map((file) => ({ file: file.slice(ROOT.length + 1), text: readFileSync(file, 'utf8') }));
}

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-z-]+):\s*(.*)$/);
    if (field) fields[field[1]] = field[2].trim();
  }
  return fields;
}

// The sentence around position `at`: back to the previous sentence end, blank line or heading mark.
function sentenceAt(text, at) {
  let start = at;
  while (start > 0) {
    const before = text.slice(0, start);
    if (/[.!?]\s$/.test(before) || /\n\s*\n$/.test(before) || /\n#+ $/.test(before) || /\n\s*[-*|] ?$/.test(before)) break;
    start -= 1;
  }
  return text.slice(start, at + 40).replace(/^[\s#*>`|-]+/, '');
}

// Script paths a SKILL.md names: scripts/<x>.mjs in this skill, or skills/<other>/scripts/<x>.mjs
// (also written ../<other>/scripts/<x>.mjs) in another one.
function namedScripts(name, text) {
  const found = new Set();
  for (const match of text.matchAll(/(?:(?:skills\/|\.\.\/)([\w-]+)\/)?scripts\/([\w./-]+?\.mjs)\b/g)) {
    found.add(join(match[1] ?? name, 'scripts', match[2]));
  }
  return [...found].sort();
}

test('every expected skill has a SKILL.md', () => {
  for (const name of EXPECTED) assert.ok(skills.includes(name), `skills/${name}/SKILL.md is missing`);
});

for (const name of skills) {
  test(`${name}: frontmatter name matches the folder and the description is 100 to 1024 characters`, () => {
    const fields = frontmatter(skillText(name));
    assert.ok(fields, 'SKILL.md starts with a --- frontmatter block');
    assert.equal(fields.name, name);
    assert.ok(fields.description, 'description is set');
    const length = fields.description.length;
    assert.ok(length >= 100 && length <= 1024, `description is ${length} characters`);
  });

  test(`${name}: no agent product is named as a requirement`, () => {
    for (const { file, text } of skillDocs(name)) {
      assert.doesNotMatch(text, /superpowers/i, `${file} names superpowers`);
      assert.doesNotMatch(text, /mcp__/, `${file} names an mcp__ tool`);
      for (const match of text.matchAll(/\b(Claude|Codex|Cursor)\b/gi)) {
        const sentence = sentenceAt(text, match.index);
        assert.ok(
          sentence.startsWith('If your agent'),
          `${file} names ${match[0]} outside a sentence starting "If your agent": ${sentence}`,
        );
      }
    }
  });

  test(`${name}: every script the SKILL.md names exists and answers --help with exit 0`, () => {
    for (const path of namedScripts(name, skillText(name))) {
      const file = join(SKILLS, path);
      assert.ok(existsSync(file), `skills/${path} does not exist`);
      // execFileSync throws on a non-zero exit, which fails the test with the script's output.
      const out = execFileSync(process.execPath, [file, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.match(out, /usage/i, `skills/${path} --help prints a usage line`);
    }
  });
}

test('the sentence check accepts "If your agent" sentences and rejects others', () => {
  const ok = 'Run it. If your agent is Claude Code, use its browser.';
  const bad = 'Run it. This needs Claude Code.';
  assert.ok(sentenceAt(ok, ok.indexOf('Claude')).startsWith('If your agent'));
  assert.ok(!sentenceAt(bad, bad.indexOf('Claude')).startsWith('If your agent'));
});
