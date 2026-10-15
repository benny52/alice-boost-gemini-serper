import http from 'node:http';
import { pathToFileURL } from 'node:url';
import handler from './api/index.js';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32 * 1024) reject(Object.assign(new Error('BODY_TOO_LARGE'), { status: 413 }));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (bytes > 32 * 1024) return;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('INVALID_JSON'), { status: 400 })); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('REQUEST_ABORTED')));
  });
}

export function createLocalServer() {
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (new URL(req.url, 'http://localhost').pathname !== '/api') return send(404, { error: 'Not found' });
    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      let statusCode = 200;
      await handler({ method: req.method, body }, {
        status(code) { statusCode = code; return this; },
        json(value) { send(statusCode, value); return value; },
        setHeader(name, value) { res.setHeader(name, value); }
      });
    } catch (error) {
      send(error.status || 500, { error: error.status === 400 ? 'Invalid JSON' : error.status === 413 ? 'Request too large' : 'Local server error' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be between 0 and 65535');
  const server = createLocalServer();
  server.listen(port, '127.0.0.1', () => console.log(`AliceBoost: http://127.0.0.1:${server.address().port}/api`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
