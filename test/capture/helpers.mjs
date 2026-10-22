// A tiny one-off HTTP server for tests that need a non-WordPress site.
// startStub(routes) -> { origin, requests[], close() }; routes maps "path?query" to
// { status, headers, body } or a function (origin) -> that shape. Unknown paths are 404.
import { createServer } from 'node:http';

export function startStub(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const origin = `http://${req.headers.host}`;
    const entry = routes[req.url];
    const response = typeof entry === 'function' ? entry(origin) : entry;
    const { status = 200, headers = {}, body = '' } = response ?? { status: 404, body: 'Not Found' };
    res.writeHead(status, { 'Content-Type': 'text/html; charset=UTF-8', ...headers });
    res.end(body);
  });
  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      resolveStart({
        origin: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () =>
          new Promise((resolveClose) => {
            server.closeAllConnections();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
