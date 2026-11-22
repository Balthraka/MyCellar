// Runs the real Worker in workerd (local only, nothing is deployed) at the compatibility_date in wrangler.toml, with a throwaway
// local database, and checks the main behaviours. Works on Windows too.   Usage: npm run smoke
import { startLocalWorker } from './local-worker.mjs';

const w = await startLocalWorker({ port: 8799 });
let fail = 0;
const A = { Authorization: 'Bearer ' + w.token };
async function check(want, what, path, init = {}) {
  const r = await fetch(w.base + path, init);
  if (r.status === want) console.log('ok   ' + what); else { console.log(`FAIL ${what} (wanted ${want}, got ${r.status})`); fail = 1; }
}
try {
  await check(401, 'no token', '/cellar');
  await check(403, 'unlisted origin', '/cellar', { headers: { Origin: 'https://evil.example' } });
  await check(204, 'preflight from the app origin', '/cellar', { method: 'OPTIONS', headers: { Origin: 'https://YOUR-NAME.github.io' } });
  await check(404, 'undecodable path', '/drinks/%', { headers: A });
  await check(200, 'GET /me', '/me', { headers: A });
  await check(200, 'PUT drink', '/drinks/d1', { method: 'PUT', headers: A, body: '{"drink":{"id":"d1","type":"wine","name":"Smoke","stock":[{"id":"s1","location":"x","quantity":1,"status":"in_stock"}]},"version":null}' });
  await check(200, 'GET /cellar', '/cellar', { headers: A });
  await check(409, 'stale edit', '/drinks/d1', { method: 'PUT', headers: A, body: '{"drink":{"id":"d1","type":"wine","name":"Smoke2","stock":[]},"version":7}' });
  await check(503, 'lookup without an AI binding in local mode answers 503, not a crash', '/lookup', { method: 'POST', headers: A, body: '{"type":"wine","name":"Margaux"}' });
  await check(200, 'logout', '/me/logout', { method: 'POST', headers: A });
  await check(401, 'after logout', '/me', { headers: A });
} finally { w.stop(); }
process.exit(fail);
