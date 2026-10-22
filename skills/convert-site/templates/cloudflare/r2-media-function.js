// Cloudflare Pages Function: serves media from an R2 bucket at its original site path.
// Copy to functions/<media prefix>/[[path]].js in the site repository (for example
// functions/wp-content/uploads/[[path]].js) and bind the bucket as MEDIA in the Pages project.
// The object key is the site path without its leading slash, as media-upload.mjs writes it.
// Used only when media is over the repository threshold; everything else stays static files.

const CACHE = 'public, max-age=31536000, immutable';
// _headers does not apply to a Function's responses, so the function sets nosniff itself.
const NOSNIFF = { 'x-content-type-options': 'nosniff' };

function notFound() {
  return new Response('Not Found', { status: 404, headers: NOSNIFF });
}

function objectKey(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.slice(1));
  } catch (err) {
    if (err instanceof URIError) return null;
    throw err;
  }
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD', ...NOSNIFF } });
  }
  const key = objectKey(request.url);
  if (key === null) return notFound();
  const object = await env.MEDIA.get(key);
  if (!object) return notFound();

  const headers = new Headers({ 'cache-control': CACHE, 'content-length': String(object.size), ...NOSNIFF });
  if (object.httpMetadata?.contentType) headers.set('content-type', object.httpMetadata.contentType);
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}
