// Exceptions: documented, approved differences from the live site that the gates accept.
// Proposals: improvements that ship only in a PROPOSALS=on build until someone approves them.
// Static JSON imports so the bundler inlines both files into the build.
import exceptionList from '../../exceptions.json' with { type: 'json' };
import proposalList from '../../proposals.json' with { type: 'json' };
import { PROPOSALS_ON } from './site.mjs';

export const exceptions = exceptionList;
// Empty unless this build runs with PROPOSALS=on.
export const proposals = PROPOSALS_ON ? proposalList : [];

// Both files hold the gates' record shape: { path, field, from, to, reason, approvedBy, date }.

// The exception recorded for one field on one path, or undefined.
export function exceptionFor(path, field) {
  return exceptions.find((entry) => entry.path === path && entry.field === field);
}

// The proposal for one field on one path when this build runs with PROPOSALS=on, or undefined.
export function proposalOn(path, field) {
  return proposals.find((entry) => entry.path === path && entry.field === field);
}
