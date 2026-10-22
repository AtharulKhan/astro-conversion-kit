// Runs a parity gate script as a child process: runGate('routes', args, { env, cwd }) for
// skills/parity-gates/scripts/verify/routes.mjs. Resolves to { code, stdout, stderr }.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const gateScript = (name) => fileURLToPath(new URL(`../../../skills/parity-gates/scripts/verify/${name}.mjs`, import.meta.url));

export async function runGate(name, args = [], { env = {}, cwd } = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [gateScript(name), ...args], {
      cwd,
      env: { ...process.env, PROPOSALS: '', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}
