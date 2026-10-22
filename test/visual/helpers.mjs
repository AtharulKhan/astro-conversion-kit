// Shared helpers for the visual-review tests.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCRIPTS = join(ROOT, 'skills', 'visual-review', 'scripts');
export const TMP = join(ROOT, 'test', 'tmp');

// Runs a script asynchronously so the in-process fixture server keeps answering.
export function run(script, args) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [join(SCRIPTS, script), ...args], (error, stdout, stderr) => {
      resolvePromise({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

export const readPng = (file) => PNG.sync.read(readFileSync(file));
