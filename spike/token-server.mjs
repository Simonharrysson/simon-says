// Local helper for index.html: serves the page and mints single-use realtime tokens.
// node spike/token-server.mjs  ->  http://localhost:8787
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mintToken } from './key.mjs';

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/token') {
    try { res.end(JSON.stringify({ token: await mintToken(Number(u.searchParams.get('max')) || undefined) })); }
    catch (e) { res.statusCode = 500; res.end(String(e.message)); }
  } else res.setHeader('content-type', 'text/html'), res.end(readFileSync(new URL('./index.html', import.meta.url)));
}).listen(8787, '127.0.0.1', () => console.log('http://localhost:8787'));
