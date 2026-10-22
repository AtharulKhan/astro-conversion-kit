// The host's compiled redirect config, found and simulated, for the gates that follow a URL
// through it (redirects, links). No side effects on import.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vercelResolver } from './vercel-resolver.mjs';
import { cloudflareResolver, parseRedirectsFile } from './cloudflare-resolver.mjs';

export const HOSTS = ['vercel', 'cloudflare'];

// The config file for a host: --config, else vercel.json, or the _redirects Astro copied into dist/.
export const configFor = (host, { config = '', dist }) => config || (host === 'cloudflare' ? join(dist, '_redirects') : 'vercel.json');

// { host, config } for the host whose config exists, given --host and --config (either may be "").
// Returns { error } when --host is unknown or both configs exist without --host, and
// { host: null } when neither exists.
export function findHost({ host = '', config = '', dist }) {
  if (host && !HOSTS.includes(host)) return { error: `--host must be vercel or cloudflare, not "${host}"` };
  if (host) return { host, config: configFor(host, { config, dist }) };
  const found = HOSTS.filter((h) => existsSync(configFor(h, { config, dist })));
  if (found.length === 2 && !config) return { error: `both ${configFor('vercel', { dist })} and ${configFor('cloudflare', { dist })} exist; pass --host` };
  if (!found.length) return { host: null, config: null };
  return { host: found[0], config: configFor(found[0], { config, dist }) };
}

// (url) => { hops, final } through the host's config file. Throws on a config it cannot read.
export function hostResolver({ host, config, dist, origins = [], explain = false }) {
  return host === 'vercel'
    ? vercelResolver({ config: JSON.parse(readFileSync(config, 'utf8')), dist, origins, explain })
    : cloudflareResolver({ rules: parseRedirectsFile(readFileSync(config, 'utf8')), dist, origins, explain });
}
