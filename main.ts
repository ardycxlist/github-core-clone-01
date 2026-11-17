// SPDX-License-Identifier: MIT
// Raven Forge — entrypoint (M2 rebuild). Starts the server on an ephemeral
// port, registers it with the environment, polls for completion, exits 0.
import { createApp } from './server.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
const envURL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const standalone = process.argv.includes('--standalone');
if (!envURL && !standalone) { console.error('MAKEFUN_ENV_URL is required (or use --standalone for local tests)'); process.exit(1); }
const server = createApp();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
const address = server.address();
if (!address || typeof address === 'string') { console.error('server did not bind a TCP port'); process.exit(1); }
const port = address.port;
console.log(JSON.stringify({ service: 'raven-forge', port }));
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  server.close(); server.closeIdleConnections();
  const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 2000); deadline.unref();
}
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
async function request(path, init = {}) {
  return fetch(`${envURL}${path}`, { ...init, signal: AbortSignal.timeout(10000) });
}
if (envURL) {
  let registered = false;
  for (let i = 0; i < 20 && !registered; i++) {
    try {
      const r = await request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port }) });
      await r.arrayBuffer();
      if (r.status === 200 || r.status === 409) registered = true;
      else if (r.status === 400 || r.status === 405) throw new Error('Invalid registration');
    } catch (e) { if (e.message === 'Invalid registration') { console.error(e.message); process.exit(1); } }
    if (!registered) await wait(Math.min(250 * 2 ** i, 2000));
  }
  if (!registered) { console.error('Registration timed out'); process.exit(1); }
  while (!stopping) {
    try { const r = await request('/done'); if (r.ok && (await r.json()).done === true) { await shutdown(); break; } } catch {}
    await wait(500);
  }
}
