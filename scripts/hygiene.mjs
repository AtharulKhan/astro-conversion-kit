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

// Banned names are assembled from parts so this file does not trip its own check.
const j = (...parts) => parts.join('');
const PERS = j('pers', 'ist');
const EVER = j('ever', 'green');
const BANNED_NAME_RES = [
  // Unambiguous names: anywhere, any case.
  new RegExp(`${j('plas', 'tix')}|${j('higher', 'pay')}`, 'gi'),
  // Ordinary English words: only as capitalised whole words ...
  new RegExp(`\\b(?:${j('P', 'ersist')}|${j('E', 'vergreen')})\\b`, 'g'),
  // ... or in their domain, handle and compound forms.
  new RegExp(
    [
      `${PERS}-?marketing`,
      `${PERS}\\.(?:com|io|ai|net|org)\\b`,
      `@${PERS}(?![a-z])`,
      `${EVER}-?private-?care`,
    ].join('|'),
    'gi',
  ),
];
// The first domain label must start with a letter, so version pins like pkg@1.2.3 are not emails.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL_DOMAIN = 'example.com';
const ALLOWED_EMAILS = new Set(['git@github.com']);
// Retina image names such as logo@2x.png look like emails; the final label gives them away.
const FILE_EXTENSION_TLDS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif']);
const TRAILER_RE = new RegExp(`^(${[j('Co', '-Authored-By'), 'Claude-Session', 'Signed-off-by'].join('|')}):`, 'im');
const ALLOWED_ENV_FILES = new Set(['.env.example', '.env.sample']);

class GitError extends Error {}

function bannedNames(line) {
  return BANNED_NAME_RES.flatMap((re) => [...line.matchAll(re)].map((match) => match[0]));
}

function isForbiddenEmail(email) {
  if (ALLOWED_EMAILS.has(email.toLowerCase())) return false;
  const domain = email.split('@')[1].toLowerCase();
  if (domain === ALLOWED_EMAIL_DOMAIN) return false;
  return !FILE_EXTENSION_TLDS.has(domain.split('.').pop());
}

export function pathProblem(path) {
  const segments = path.split('/');
  const base = segments[segments.length - 1];
  if (path.startsWith('.superpowers/')) return 'planning folder .superpowers/';
  if (path.startsWith('.agents/')) return 'session folder .agents/';
  if (path.startsWith('docs/superpowers/')) return 'planning folder docs/superpowers/';
  if (segments.includes('node_modules')) return 'node_modules';
  if (base.startsWith('.env') && !ALLOWED_ENV_FILES.has(base)) return 'environment file';
  if (/\.png$/i.test(base) && !path.startsWith('docs/examples/')) return '*.png outside docs/examples/';
  return null;
}

export function contentProblems(text) {
  const problems = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const [email] of line.matchAll(EMAIL_RE)) {
      if (isForbiddenEmail(email)) problems.push(`line ${index + 1}: email ${email}`);
    }
    for (const name of bannedNames(line)) {
      problems.push(`line ${index + 1}: banned name "${name}"`);
    }
  });
  return problems;
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new GitError(`git ${args.join(' ')} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

function hasCommits(dir) {
  try {
    git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

function commitMessages(dir) {
  if (!hasCommits(dir)) return [];
  return git(dir, ['log', '--format=%H%x00%B%x1e'])
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
    const trailer = body.match(TRAILER_RE);
    if (trailer) problems.push(`commit ${hash}: message has a ${trailer[1]} trailer`);
    for (const name of new Set(bannedNames(body))) {
      problems.push(`commit ${hash}: message contains banned name "${name}"`);
    }
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
  let dir;
  try {
    // Anchor at the repo root so path rules like docs/superpowers/ apply to a subdirectory --dir.
    dir = git(resolve(args.dir), ['rev-parse', '--show-toplevel']).trim();
  } catch {
    console.error(`Not a git repository: ${resolve(args.dir)}`);
    process.exit(2);
  }
  let result;
  try {
    result = checkRepo(dir);
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    console.error(err.message);
    process.exit(2);
  }
  const { problems, fileCount, commitCount } = result;
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
