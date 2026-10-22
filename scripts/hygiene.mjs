#!/usr/bin/env node
// Repo hygiene check: scans files tracked by git and every commit message.
// Exit 0 clean, 1 problems found, 2 usage or environment error.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';

const HELP = `Usage: node scripts/hygiene.mjs --dir <repo>

Checks the files git tracks in <repo> and every commit message for:
  - email addresses other than *@example.com
  - client or agency names that must never ship
  - planning and local folders (.superpowers/, .agents/, docs/superpowers/),
    node_modules, .env files, and *.png outside docs/examples/
  - commit messages carrying attribution or sign-off trailers

Exit codes: 0 clean, 1 problems found (listed on stdout), 2 usage error.`;

// Assembled from parts so this file does not trip its own check.
const BANNED_NAMES = [['pers', 'ist'], ['plas', 'tix'], ['ever', 'green'], ['higher', 'pay']].map(
  (parts) => parts.join(''),
);
// A banned name at the start of a word, except ordinary English words built on it.
const BANNED_NAME_RE = new RegExp(
  `\\b(?:${BANNED_NAMES.join('|')})(?!(?:ent|ently|ence|ences)\\b)`,
  'gi',
);
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL_DOMAIN = 'example.com';
const BANNED_TRAILERS = [['Co', 'Authored', 'By'].join('-'), 'Claude-Session', 'Signed-off-by'];
const TRAILER_RE = new RegExp(BANNED_TRAILERS.join('|'), 'i');

export function pathProblem(path) {
  const segments = path.split('/');
  const base = segments[segments.length - 1];
  if (path.startsWith('.superpowers/')) return 'planning folder .superpowers/';
  if (path.startsWith('.agents/')) return 'session folder .agents/';
  if (path.startsWith('docs/superpowers/')) return 'planning folder docs/superpowers/';
  if (segments.includes('node_modules')) return 'node_modules';
  if (base.startsWith('.env')) return 'environment file';
  if (/\.png$/i.test(base) && !path.startsWith('docs/examples/')) return '*.png outside docs/examples/';
  return null;
}

export function contentProblems(text) {
  const problems = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(EMAIL_RE)) {
      const domain = match[0].split('@')[1].toLowerCase();
      if (domain !== ALLOWED_EMAIL_DOMAIN) {
        problems.push(`line ${index + 1}: email ${match[0]}`);
      }
    }
    for (const match of line.matchAll(BANNED_NAME_RE)) {
      problems.push(`line ${index + 1}: banned name "${match[0]}"`);
    }
  });
  return problems;
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commitMessages(dir) {
  let log;
  try {
    log = git(dir, ['log', '--format=%H%x00%B%x1e']);
  } catch {
    return []; // no commits yet
  }
  return log
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.includes('\0'))
    .map((record) => {
      const [hash, body] = record.split('\0');
      return { hash, body };
    });
}

export function checkRepo(dir) {
  const problems = [];
  const files = git(dir, ['ls-files', '-z']).split('\0').filter(Boolean);
  for (const path of files) {
    const reason = pathProblem(path);
    if (reason) problems.push(`file ${path}: ${reason}`);
    const absolute = resolve(dir, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    const buffer = readFileSync(absolute);
    if (isBinary(buffer)) continue;
    for (const problem of contentProblems(buffer.toString('utf8'))) {
      problems.push(`file ${path}: ${problem}`);
    }
  }
  const commits = commitMessages(dir);
  for (const { hash, body } of commits) {
    const match = body.match(TRAILER_RE);
    if (match) problems.push(`commit ${hash}: message contains ${match[0]}`);
  }
  return { problems, fileCount: files.length, commitCount: commits.length };
}

function parseArgs(argv) {
  const args = { dir: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--dir') args.dir = argv[++i] ?? null;
    else if (arg.startsWith('--dir=')) args.dir = arg.slice('--dir='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  assertNodeVersion();
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (!args.dir) {
    console.error(`--dir is required\n\n${HELP}`);
    process.exit(2);
  }
  const dir = resolve(args.dir);
  try {
    git(dir, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    console.error(`Not a git repository: ${dir}`);
    process.exit(2);
  }
  const { problems, fileCount, commitCount } = checkRepo(dir);
  if (problems.length > 0) {
    console.log(`Hygiene failed: ${problems.length} problem(s)`);
    for (const problem of problems) console.log(`  ${problem}`);
    process.exit(1);
  }
  console.log(`Hygiene OK: ${fileCount} tracked files and ${commitCount} commits checked`);
  process.exit(0);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
