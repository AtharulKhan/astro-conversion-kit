// Built to dist/robots.txt. Blocks everything until a release build sets PUBLIC_INDEXABLE=true.
// Replace the indexable body with the live site's robots.txt from capture/ when it differs.
import { INDEXABLE, ORIGIN } from '../lib/site.mjs';

export function GET() {
  const body = INDEXABLE
    ? `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
