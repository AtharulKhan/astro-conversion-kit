// Exceptions: documented, approved differences from the live site that the gates accept.
// Proposals: improvements that ship only in a PROPOSALS=on build until someone approves them.
// Static JSON imports so the bundler inlines both files into the build.
import exceptionList from '../../exceptions.json' with { type: 'json' };
import proposalList from '../../proposals.json' with { type: 'json' };
import { PROPOSALS_ON } from './site.mjs';

export const exceptions = exceptionList;
// Empty unless this build runs with PROPOSALS=on.
export const proposals = PROPOSALS_ON ? proposalList : [];

// The exception recorded for one gate on one path, or undefined.
export function exceptionFor(path, gate) {
  return exceptions.find((entry) => entry.path === path && entry.gate === gate);
}

// True when proposals are on for this build and one with this id exists.
export function proposalOn(id) {
  return proposals.some((entry) => entry.id === id);
}
