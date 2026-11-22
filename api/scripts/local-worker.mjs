// Starts the real Worker in workerd on this computer (wrangler dev --local, nothing is deployed) with a throwaway database,
// applies schema.sql and adds one made-up signed-in user. Works on Windows, macOS and Linux (no bash, curl or sha256sum).
//   import { startLocalWorker } from './local-worker.mjs'
//   node scripts/local-worker.mjs [--port 8787] [--origin http://localhost:8080]   (prints {"base","token"}, runs until stopped)
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerJs = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const wrangler = (args, opts = {}) => execFileSync(process.execPath, [wranglerJs, ...args], { cwd: root, stdio: 'pipe', encoding: 'utf8', ...opts });

export async function startLocalWorker({ port = 8799, origin } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mycellar-local-'));
  wrangler(['d1', 'execute', 'mycellar', '--local', '--persist-to', dir, '--file=schema.sql']);
  const args = [wranglerJs, 'dev', '--local', '--port', String(port), '--persist-to', dir];
  if (origin) args.push('--var', `ALLOWED_ORIGINS:${origin}`);
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const stop = () => {
    try { if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGTERM'); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  const base = `http://localhost:${port}`;
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try { await fetch(base + '/me'); up = true; } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  if (!up) { stop(); throw new Error('the local Worker did not start:\n' + log.slice(-1500)); }
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const t = '2026-11-21T00:00:00.000000Z';
  wrangler(['d1', 'execute', 'mycellar', '--local', '--persist-to', dir, '--command',
    `INSERT INTO users (id,email,name,created_at) VALUES ('u1','tester@example.test','','${t}'); INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES ('${hash}','u1','${t}','2099-01-01T00:00:00.000000Z');`]);
  return { base, token, stop };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2); const get = k => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const w = await startLocalWorker({ port: Number(get('port')) || 8787, origin: get('origin') });
  console.log(JSON.stringify({ base: w.base, token: w.token }));
  process.on('SIGTERM', () => { w.stop(); process.exit(0); });
  process.on('SIGINT', () => { w.stop(); process.exit(0); });
  await new Promise(() => {});
}
