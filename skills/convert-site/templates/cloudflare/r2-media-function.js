// Cloudflare Pages Function: serves media from an R2 bucket at its original site path.
// Copy to functions/<media prefix>/[[path]].js in the site repository (for example
// functions/wp-content/uploads/[[path]].js) and bind the bucket as MEDIA in the Pages project.
// The object key is the site path without its leading slash, as media-upload.mjs writes it.
// Used only when media is over the repository threshold; everything else stays static files.

const CACHE = 'public, max-age=31536000, immutable';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
  const object = await env.MEDIA.get(key);
  if (!object) return new Response('Not Found', { status: 404 });

  const headers = new Headers({ 'cache-control': CACHE, 'content-length': String(object.size) });
  if (object.httpMetadata?.contentType) headers.set('content-type', object.httpMetadata.contentType);
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}
