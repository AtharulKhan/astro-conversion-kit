// File-name slug for a site path: `/` -> `home`, `/a/b/` -> `a__b`, `/?p=7` -> `_q_p-7`.
// Lowercase, only [a-z0-9_-], at most 120 characters (a long path keeps a hash of the whole
// path at the end so two long paths do not collide).
import { createHash } from 'node:crypto';

export const MAX_SLUG = 120;

export function slugFor(path) {
  const raw = String(path ?? '/');
  const queryAt = raw.indexOf('?');
  const pathname = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const query = queryAt === -1 ? '' : raw.slice(queryAt + 1);
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

  const segments = pathname.split('/').filter(Boolean).map(clean);
  let slug = segments.join('__');
  if (query) slug += `_q_${clean(query)}`;
  if (!slug) slug = 'home';
  if (slug.length <= MAX_SLUG) return slug;
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return `${slug.slice(0, MAX_SLUG - hash.length - 1)}-${hash}`;
}
