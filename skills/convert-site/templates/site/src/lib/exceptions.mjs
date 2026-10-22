// Exceptions: documented, approved differences from the live site that the gates accept.
// Proposals: improvements that ship only in a PROPOSALS=on build until someone approves them.
import { readFileSync } from 'node:fs';
import { PROPOSALS_ON } from './site.mjs';

function load(name) {
  return JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8'));
}

export const exceptions = load('exceptions.json');
export const proposals = load('proposals.json');

// The exception recorded for one gate on one path, or undefined.
export function exceptionFor(path, gate) {
  return exceptions.find((entry) => entry.path === path && entry.gate === gate);
}

// True when the proposal with this id exists and proposals are switched on for this build.
export function proposalOn(id) {
  return PROPOSALS_ON && proposals.some((entry) => entry.id === id);
}
