import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, 'skills');

// Skill folders whose SKILL.md a later task writes. Remove each entry when its SKILL.md lands.
const EXPECTED_MISSING = new Set(['convert-site', 'parity-gates', 'suggest-improvements']);

const folders = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const skills = folders.filter((name) => existsSync(join(SKILLS, name, 'SKILL.md')));

// An agent product named as a word: case-sensitive, so `cursor: pointer` and `.claude/` pass, and
// not a file or flag name such as `CLAUDE.md` or `Claude-Session`.
const VENDOR_WORD = /\b(Claude|Codex|Cursor)\b(?!\.md|-)/g;
// Abbreviations whose full stop does not end a sentence.
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|cf)\.\s$/i;

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
    if ((/[.!?]\s$/.test(before) && !ABBREVIATIONS.test(before)) || /\n\s*\n$/.test(before) || /\n#+ $/.test(before) || /\n\s*[-*|] ?$/.test(before)) break;
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

test('every folder under skills/ has a SKILL.md, apart from the ones a later task writes', () => {
  for (const name of folders) {
    const has = skills.includes(name);
    if (EXPECTED_MISSING.has(name)) assert.ok(!has, `skills/${name}/SKILL.md exists: remove it from EXPECTED_MISSING`);
    else assert.ok(has, `skills/${name}/SKILL.md is missing`);
  }
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
      for (const match of text.matchAll(VENDOR_WORD)) {
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

// Each sample's vendor words, each with whether its sentence starts "If your agent".
function vendorSentences(text) {
  return [...text.matchAll(VENDOR_WORD)].map((m) => [m[0], sentenceAt(text, m.index).startsWith('If your agent')]);
}

test('the vendor-word check allows "If your agent" sentences and flags others', () => {
  assert.deepEqual(vendorSentences('Run it. If your agent is Claude Code, use its browser.'), [['Claude', true]]);
  assert.deepEqual(vendorSentences('Run it. If your agent is, e.g. Codex, use it.'), [['Codex', true]]);
  assert.deepEqual(vendorSentences('Run it. This needs Claude Code.'), [['Claude', false]]);
  assert.deepEqual(vendorSentences('Install it.\n\nCursor works too.'), [['Cursor', false]]);
});

test('the vendor-word check ignores file names, folders and CSS', () => {
  assert.deepEqual(vendorSentences('`CLAUDE.md` is a copy of `AGENTS.md`.'), []);
  assert.deepEqual(vendorSentences('Do not commit `.claude/` or a Claude.md file.'), []);
  assert.deepEqual(vendorSentences('a { cursor: pointer; }'), []);
  assert.deepEqual(vendorSentences('No `Claude-Session:` trailer.'), []);
});
