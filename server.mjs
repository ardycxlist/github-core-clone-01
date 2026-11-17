// Raven Forge — server (M2 rebuild).
// HTTP routing, bearer/Basic auth, request/body limits, JSON errors.
// GraphQL and MCP handlers are loaded if present (M3 drops graphql.mjs /
// mcp.mjs in); until then those routes answer 501, not 404.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Store } from './store.mjs';
import { handleGit } from './git.mjs';

let handleGraphQL = null, handleMCP = null;
try { ({ handleGraphQL } = await import('./graphql.mjs')); } catch { /* M3 supplies graphql.mjs */ }
try { ({ handleMCP } = await import('./mcp.mjs')); } catch { /* M3 supplies mcp.mjs */ }

const MAX_BODY = 64 * 1024 * 1024;
export function sendJSON(res, status, body, headers = {}, serialized = undefined) {
  const text = serialized ?? (body === null || body === undefined ? '' : JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}
export function createApp({ token = process.env.MAKEFUN_SHOP_TOKEN, login = process.env.FORGE_LOGIN ?? '', store = new Store(login) } = {}) {
  if (!token) throw new Error('MAKEFUN_SHOP_TOKEN must be set');
  const auth = Buffer.from(`Bearer ${token}`);
  let requestID = 0;
  const server = createServer({ keepAliveTimeout: 65000, headersTimeout: 25000, requestTimeout: 30000 }, (req, res) => {
    res.setHeader('x-github-request-id', `RAVEN:${(++requestID).toString(16).padStart(12, '0')}`);
    res.setHeader('x-content-type-options', 'nosniff');
    res.sendDate = false;
    let url;
    try { url = new URL(req.url, 'http://forge'); } catch { return sendJSON(res, 400, { message: 'Invalid request URL' }); }
    const path = url.pathname;
    if (!store.baseUrl) { const host = req.socket.localAddress ?? '127.0.0.1'; store.baseUrl = `http://${host.includes(':') ? '[' + host + ']' : host}:${req.socket.localPort}`; }
    if (path === '/healthz' && req.method === 'GET') return sendJSON(res, 200, { ok: true });
    // Duplicate Authorization headers arrive as an array; only the first counts.
    const authHeader = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : (req.headers.authorization ?? '');
    const received = Buffer.from(authHeader);
    let authenticated = received.length === auth.length && timingSafeEqual(received, auth);
    // Native Git also uses HTTP Basic. Accept only a password equal to the bearer credential.
    if (!authenticated && received.toString().startsWith('Basic ')) {
      const decoded = Buffer.from(received.toString().slice(6), 'base64').toString();
      const candidate = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
      const expected = Buffer.from(token);
      authenticated = decoded.includes(':') && candidate.length === expected.length && timingSafeEqual(candidate, expected);
    }
    if (!authenticated) { req.resume(); return sendJSON(res, 401, { message: 'Bad credentials' }, { 'www-authenticate': 'Bearer realm="Raven Forge"' }); }
    try { decodeURIComponent(path); } catch { req.resume(); return sendJSON(res, 400, { message: 'Invalid URL encoding' }); }
    const chunks = []; let size = 0, aborted = false;
    req.on('error', () => { aborted = true; });
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { if (!aborted) sendJSON(res, 413, { message: 'Request body too large' }); aborted = true; chunks.length = 0; return; }
      if (!aborted) chunks.push(chunk);
    });
    req.on('end', async () => {
      if (aborted) return;
      const raw = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      try {
        const gm = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gm) {
          const repo = store.getRepo(decodeURIComponent(gm[1]), decodeURIComponent(gm[2]));
          if (!repo) return sendJSON(res, 404, { message: 'Repository not found' });
          return await handleGit(req, res, raw, repo.git);
        }
        let body = {};
        if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJSON(res, 400, path === '/mcp' ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } : { message: 'Malformed JSON' }); } }
        if (path === '/api/graphql') {
          if (req.method !== 'POST') return sendJSON(res, 405, { message: 'Method not allowed' }, { allow: 'POST' });
          if (!handleGraphQL) return sendJSON(res, 501, { message: 'GraphQL not implemented yet' });
          return sendJSON(res, 200, await handleGraphQL(body, store));
        }
        if (path === '/mcp') {
          if (req.method !== 'POST') return sendJSON(res, 405, { message: 'Method not allowed' }, { allow: 'POST' });
          if (!handleMCP) return sendJSON(res, 501, { message: 'MCP not implemented yet' });
          const r = await handleMCP(body, store); return sendJSON(res, r.status, r.body, r.headers);
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (body === null || Array.isArray(body) || typeof body !== 'object') return sendJSON(res, 400, { message: 'JSON body must be an object' });
          const r = store.rest(req.method, path, body, url.searchParams);
          return sendJSON(res, r.status, r.body, r.headers, r.serialized);
        }
        return sendJSON(res, 404, { message: 'Not Found' });
      } catch (e) {
        if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
        const status = Number.isInteger(e.status) ? e.status : 500;
        if (status === 500) console.error('[request]', e.stack ?? String(e));
        return sendJSON(res, status, { message: status === 500 ? 'Internal Server Error' : e.message });
      }
    });
  });
  server.on('clientError', (_err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  server.store = store;
  return server;
}
