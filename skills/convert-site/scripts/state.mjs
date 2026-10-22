#!/usr/bin/env node
// Run state for a conversion: reads and writes <site>/.conversion/state.json.
// This file is copied into every scaffolded site as scripts/state.mjs, next to
// scripts/lib/node-version.mjs, so it imports only from its own skill.
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';

const HELP = `Usage: node state.mjs --dir <site> <command>

Commands:
  get [key]             print the whole state, or one value, as JSON
  set <key> <json>      set a value; <json> is parsed as JSON ('"vercel"', 13, {...})
  phase <name>          start a phase: stamps its startedAt and the previous
                        phase's finishedAt (re-entering the current phase is a no-op)
  decision '<json>'     append a decision {topic, choice, default, reason,
                        costIfWrong}; id and date are filled in; prints the id

Keys may be dotted paths, e.g. counts.pages or phases.capture.result.
State lives in <site>/.conversion/state.json and is written atomically.
Each write command reads, changes and rewrites the file without a lock, so
run state.mjs calls one after another, never in parallel.
Exit codes: 0 success, 2 usage error or unreadable or unwritable state file.`;

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const DECISION_FIELDS = ['topic', 'choice', 'default', 'reason', 'costIfWrong'];

class UsageError extends Error {}

function freshState(now) {
  return {
    version: 1,
    site: null,
    repo: null,
    hosting: null,
    startedAt: now,
    phase: null,
    phases: {},
    decisions: [],
    counts: {},
    needsYou: [],
  };
}

function statePath(dir) {
  return join(dir, '.conversion', 'state.json');
}

export function readState(dir, now = new Date().toISOString()) {
  let text;
  try {
    text = readFileSync(statePath(dir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return freshState(now);
    throw new UsageError(`cannot read ${statePath(dir)}: ${error.message}`);
  }
  let state;
  try {
    state = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${statePath(dir)} is not valid JSON (${error.message}); fix or remove it`);
  }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new UsageError(`${statePath(dir)} does not hold a JSON object; fix or remove it`);
  }
  return state;
}

// Write to a temp file in the same directory, then rename over the real file.
export function writeState(dir, state) {
  const target = statePath(dir);
  mkdirSync(join(dir, '.conversion'), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function splitKey(key) {
  const parts = key.split('.');
  if (parts.some((part) => part === '' || FORBIDDEN_KEYS.has(part))) {
    throw new UsageError(`invalid key: ${key}`);
  }
  return parts;
}

function getPath(state, key) {
  let value = state;
  for (const part of splitKey(key)) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return null;
    value = value[part];
  }
  return value;
}

function setPath(state, key, value) {
  const parts = splitKey(key);
  let node = state;
  for (const part of parts.slice(0, -1)) {
    if (node[part] === null || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${what} is not valid JSON: ${text}`);
  }
}

export function startPhase(state, name, now) {
  if (!name || FORBIDDEN_KEYS.has(name)) throw new UsageError(`invalid phase name: ${name}`);
  if (state.phase === name) return state;
  state.phases ??= {};
  const previous = state.phases[state.phase];
  if (previous && !previous.finishedAt) previous.finishedAt = now;
  state.phases[name] = { startedAt: now, finishedAt: null, result: null };
  state.phase = name;
  return state;
}

export function addDecision(state, input, now) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new UsageError('decision must be a JSON object');
  }
  for (const field of ['topic', 'choice']) {
    if (input[field] === undefined) throw new UsageError(`decision needs "${field}"`);
  }
  state.decisions ??= [];
  const decision = { id: input.id ?? `d${state.decisions.length + 1}` };
  for (const field of DECISION_FIELDS) decision[field] = input[field] ?? null;
  decision.date = input.date ?? now.slice(0, 10);
  state.decisions.push(decision);
  return decision;
}

function parseArgs(argv) {
  const rest = [];
  let dir = null;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--help' || argv[i] === '-h') help = true;
    else if (argv[i] === '--dir') {
      dir = argv[i + 1];
      if (dir === undefined) throw new UsageError('--dir needs a value');
      i += 1;
    } else rest.push(argv[i]);
  }
  return { dir, help, command: rest[0], args: rest.slice(1) };
}

function run({ dir, command, args }) {
  if (!dir) throw new UsageError('--dir <site> is required');
  const now = new Date().toISOString();
  const arity = { get: [0, 1], set: [2, 2], phase: [1, 1], decision: [1, 1] }[command];
  if (!arity) throw new UsageError(command ? `unknown command: ${command}` : 'a command is required');
  if (args.length < arity[0] || args.length > arity[1]) throw new UsageError(`wrong arguments for ${command}`);
  const state = readState(dir, now);

  if (command === 'get') {
    const value = args.length ? getPath(state, args[0]) : state;
    console.log(typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : JSON.stringify(value));
    return;
  }
  if (command === 'set') {
    setPath(state, args[0], parseJson(args[1], 'value'));
  } else if (command === 'phase') {
    startPhase(state, args[0], now);
  } else {
    console.log(addDecision(state, parseJson(args[0], 'decision'), now).id);
  }
  writeState(dir, state);
}

function main(argv) {
  assertNodeVersion();
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      console.log(HELP);
      return 0;
    }
    run(opts);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) console.error(`state: ${error.message}\n\n${HELP}`);
    else console.error(`state: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
