#!/usr/bin/env node
// Preflight: what this machine has (Node, git, gh, vercel, wrangler, Playwright chromium)
// and a rough read of how experienced the person running the conversion is.
// Login probes report a boolean only: their output is inspected, never printed or stored.
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, isSupportedNodeVersion } from '../../../scripts/lib/node-version.mjs';

const HELP = `Usage: node preflight.mjs [--json] [--home <dir>] [--path-env <PATH>]

Reports the tools a conversion needs and whether each CLI is logged in:
  node      version and whether it is supported
  git, gh, vercel, wrangler
            present, version, loggedIn (gh auth status, vercel whoami,
            wrangler whoami; git has no login and reports null)
  playwright chromium installed or not
  experience new | some | experienced, from two signals: at least 10 git
            repositories directly under the parent of the current directory,
            and gh being logged in (both: experienced, either: some)

Options:
  --json             print the report as JSON
  --home <dir>       scan <dir> for repositories and dotfiles instead of the
                     parent of the current directory and the home directory
  --path-env <PATH>  look up and run the CLIs with this PATH instead of $PATH

Each probe times out after 10 s. Tokens and login output are never printed.
Test hook: PREFLIGHT_PROBE_TIMEOUT_MS=<ms> overrides the 10 s probe timeout.
Exit codes: 0 report printed, 2 usage error.`;

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const timeoutOverride = Number.parseInt(process.env.PREFLIGHT_PROBE_TIMEOUT_MS ?? '', 10);
const PROBE_TIMEOUT_MS = timeoutOverride > 0 ? timeoutOverride : DEFAULT_PROBE_TIMEOUT_MS;
const MAX_OUTPUT = 64 * 1024;
const REPOS_FOR_EXPERIENCED = 10;
const TOOLS = {
  git: null,
  gh: ['auth', 'status'],
  vercel: ['whoami'],
  wrangler: ['whoami'],
};
const NOT_LOGGED_IN_RE = /not (?:logged in|authenticated)|unauthenticated|please (?:run )?(?:\S+ )?login/i;
const DOTFILES = ['.gitconfig', '.ssh', '.npmrc', '.nvm', join('.config', 'gh')];

function parseArgs(argv) {
  const opts = { json: false, home: null, pathEnv: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--home' || arg === '--path-env') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--home') opts.home = value;
      else opts.pathEnv = value;
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function findBinary(name, pathEnv) {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return null;
}

// Runs a command with a hard timeout. The child gets its own process group so a
// hung CLI and anything it started are killed together. Output stays in memory.
function probe(file, args, pathEnv) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };
    let child;
    try {
      child = spawn(file, args, {
        env: { ...process.env, PATH: pathEnv, NO_COLOR: '1', GH_PROMPT_DISABLED: '1', CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch {
      resolve({ code: null, output: '' });
      return;
    }
    const collect = (chunk) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      finish(null);
    }, PROBE_TIMEOUT_MS);
  });
}

async function checkTool(name, loginArgs, pathEnv) {
  const file = findBinary(name, pathEnv);
  if (!file) return { present: false, version: null, loggedIn: loginArgs ? false : null };
  const versionRun = await probe(file, ['--version'], pathEnv);
  const version = versionRun.output.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  if (!loginArgs) return { present: true, version, loggedIn: null };
  const login = await probe(file, loginArgs, pathEnv);
  const loggedIn = login.code === 0 && !NOT_LOGGED_IN_RE.test(login.output);
  return { present: true, version, loggedIn };
}

async function hasChromium() {
  try {
    const { chromium } = await import('playwright');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

// Directories directly under root that contain .git (a directory, or a file for worktrees).
function countRepos(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, '.git'))).length;
}

function countDotfiles(home) {
  return DOTFILES.filter((name) => existsSync(join(home, name))).length;
}

export async function preflight({ home = null, pathEnv = process.env.PATH ?? '' } = {}) {
  const names = Object.keys(TOOLS);
  const [results, chromium] = await Promise.all([
    Promise.all(names.map((name) => checkTool(name, TOOLS[name], pathEnv))),
    hasChromium(),
  ]);
  const tools = Object.fromEntries(names.map((name, i) => [name, results[i]]));
  const signals = {
    repos: countRepos(home ?? dirname(process.cwd())),
    ghAuth: tools.gh.loggedIn === true,
    dotfiles: countDotfiles(home ?? homedir()),
  };
  const manyRepos = signals.repos >= REPOS_FOR_EXPERIENCED;
  let experience = 'new';
  if (manyRepos && signals.ghAuth) experience = 'experienced';
  else if (manyRepos || signals.ghAuth) experience = 'some';
  return {
    node: { version: process.versions.node, ok: isSupportedNodeVersion(process.versions.node) },
    tools,
    playwright: { chromium },
    experience,
    signals,
  };
}

function formatReport(report) {
  const lines = [`Node      ${report.node.version}  ${report.node.ok ? 'ok' : 'unsupported'}`];
  for (const [name, tool] of Object.entries(report.tools)) {
    let login = '';
    if (tool.loggedIn === true) login = 'logged in';
    else if (tool.loggedIn === false) login = 'not logged in';
    const detail = tool.present ? `${tool.version ?? 'unknown'}  ${login}`.trim() : 'missing';
    lines.push(`${name.padEnd(10)}${detail}`);
  }
  lines.push(`Playwright chromium: ${report.playwright.chromium ? 'installed' : 'missing'}`);
  const { repos, ghAuth, dotfiles } = report.signals;
  lines.push(
    `Experience: ${report.experience} (git repos nearby: ${repos}, gh logged in: ${ghAuth ? 'yes' : 'no'}, dotfiles: ${dotfiles})`,
  );
  return lines.join('\n');
}

async function main(argv) {
  assertNodeVersion();
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`preflight: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const report = await preflight({ home: opts.home, pathEnv: opts.pathEnv ?? process.env.PATH ?? '' });
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
