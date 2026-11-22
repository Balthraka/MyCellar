// Test harness: the real Worker code (handle) running against a real D1 database from
// Miniflare (workerd's SQLite), with a fake Google. All data is made up.
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { app } from '../src/index.js';
import { KeyCache } from '../core/index.js';

// Personal Microsoft accounts' tenant id (what the core's `consumers` check expects).
export const MS_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const b64url = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

export const GOOGLE_CLIENT_ID = 'test-google-client.apps.googleusercontent.com';
export const MS_CLIENT_ID = 'test-ms-client-id';
// Miniflare 4 (newest stable, workerd 2026-08-06) cannot start a Worker with a later date, and here only D1 runs inside
// workerd; the Worker code itself runs in Node. The real runtime at the wrangler.toml date is checked by scripts/smoke-local.mjs.
const COMPAT_DATE = /^compatibility_date\s*=\s*"([^"]+)"/m.exec(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'))[1];
export const COMPAT = COMPAT_DATE;
export const ORIGIN = 'https://app.example.test';

export const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const schema = schemaSql
  .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  .split(/;\s*\n/).map(s => s.trim()).filter(Boolean);

// ── instrumented D1: counts queries, rows read/written, bound params ────────────────
export function instrument(db) {
  const log = { queries: 0, rowsRead: 0, rowsWritten: 0, maxParams: 0, sql: new Map() };
  const note = (sql, binds, meta) => {
    log.queries++;
    log.rowsRead += meta?.rows_read ?? 0;
    log.rowsWritten += meta?.rows_written ?? 0;
    log.maxParams = Math.max(log.maxParams, binds.length);
    if (!log.sql.has(sql)) log.sql.set(sql, binds);
  };
  const wrap = (stmt, sql, binds) => ({
    __stmt: stmt, __sql: sql, __binds: binds,
    bind: (...b) => wrap(stmt.bind(...b), sql, b),
    async first() { const r = await stmt.all(); note(sql, binds, r.meta); return r.results[0] ?? null; },
    async all() { const r = await stmt.all(); note(sql, binds, r.meta); return r; },
    async run() { const r = await stmt.run(); note(sql, binds, r.meta); return r; },
  });
  return {
    log,
    prepare: sql => wrap(db.prepare(sql), sql, []),
    async batch(list) {
      const res = await db.batch(list.map(s => s.__stmt));
      res.forEach((r, i) => note(list[i].__sql, list[i].__binds, r.meta));
      return res;
    },
    raw: db,
  };
}

export async function makeEnv(overrides = {}) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'test-' + Math.random().toString(36).slice(2) },
  });
  const raw = await mf.getD1Database('DB');
  for (const s of schema) await raw.prepare(s).run();
  const inst = instrument(raw);
  // Test seam (core `Deps`): fake provider keys, a clock a test can move, and a fresh key cache per test database.
  const deps = makeDeps();
  const env = {
    DB: inst, ALLOW_SIGNUPS: 'false', ALLOWED_ORIGINS: ORIGIN,
    GOOGLE_CLIENT_ID, MS_CLIENT_ID: '', ...overrides,
  };
  Object.defineProperty(env, '__deps', { value: deps, enumerable: false });
  return { env, raw, inst, deps, close: () => mf.dispose() };
}

// ── fake identity providers ─────────────────────────────────────────────────────────
const enc = new TextEncoder();
async function makeProvider(kid) {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kp, jwk, kid };
}
export const providers = {};
export async function setupProviders() {
  providers.google = await makeProvider('g-key-1');
  providers.ms = await makeProvider('m-key-1');
  providers.rogue = await makeProvider('g-key-1'); // same kid, different key: bad signature
}

// The fake network and clock handed to the core through `deps`. `calls` records every key fetch; `clock.now` is null
// until a test sets it (then the core uses that time instead of the real one).
export function makeDeps() {
  const d = {
    calls: [], clock: { now: null }, keyCache: new KeyCache(),
    fetchJwks: async url => {
      d.calls.push(String(url));
      if (String(url).includes('googleapis.com/oauth2/v3/certs')) return { keys: d.googleKeys ?? [providers.google.jwk] };
      if (String(url).includes('login.microsoftonline.com/consumers/discovery')) return { keys: [providers.ms.jwk] };
      throw new Error('unexpected key fetch ' + url);
    },
    now: () => d.clock.now ?? Date.now(),
  };
  return d;
}

export async function signJwt(provider, payload, header = {}) {
  const h = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: provider.kid, ...header })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', provider.kp.privateKey, enc.encode(h + '.' + p)));
  return `${h}.${p}.${b64url(sig)}`;
}

const nowS = () => Math.floor(Date.now() / 1000);
export const googleToken = (o = {}, provider = providers.google) => signJwt(provider, {
  iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, sub: 'g-sub-1', email: 'a@example.test',
  email_verified: true, name: 'Test A', iat: nowS(), exp: nowS() + 600, ...o,
});
export const msToken = (o = {}) => signJwt(providers.ms, {
  iss: `https://login.microsoftonline.com/${MS_CONSUMER_TENANT}/v2.0`, aud: MS_CLIENT_ID, tid: MS_CONSUMER_TENANT,
  sub: 'm-sub-1', email: 'm@example.test', name: 'Test M', iat: nowS(), exp: nowS() + 600, ...o,
});

// ── calling the Worker ──────────────────────────────────────────────────────────────
export async function call(env, method, path, { token, body, origin, headers, deps } = {}) {
  const h = new Headers(headers || {});
  if (token) h.set('Authorization', 'Bearer ' + token);
  if (origin) h.set('Origin', origin);
  const init = { method, headers: h };
  if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); h.set('Content-Type', 'application/json'); }
  const res = await app.handle(new Request('https://api.example.test' + path, init), env, deps ?? env.__deps);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, body: data, headers: res.headers };
}

// Invites a user (what scripts/invite.mjs does) and signs them in with the fake Google.
export async function inviteAndLogin(ctx, email, sub = 'sub-' + email) {
  const id = crypto.randomUUID();
  await ctx.raw.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?1, ?2, \'\', ?3)').bind(id, email, new Date().toISOString()).run();
  const r = await call(ctx.env, 'POST', '/auth/google', { body: { idToken: await googleToken({ email, sub }) } });
  if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r.body));
  return { token: r.body.token, id, email };
}

// ── made-up data ────────────────────────────────────────────────────────────────────
export function makeDrink(id, over = {}) {
  return {
    id, type: 'wine', name: 'Test Wine ' + id, producer: 'Test Producer', year: 2020, price_cents: 2850,
    wineColor: 'red', grape: 'Test Grape', region: 'Testland', rating: 90, review: 'ok',
    tastingNotes: { nose: 'n', palate: 'p', finish: 'f' },
    stock: [{ id: id + 's1', location: 'wine-fridge', sublocation: 'Top Shelf', position: null, quantity: 2,
      dateAdded: '2024-01-01', status: 'in_stock', dateFinished: null }],
    ...over,
  };
}
export const LOCS = [
  { id: 'wine-fridge', name: 'Wine Fridge', slots: ['Top Shelf', '2nd Shelf'], positionsPerRow: null },
  { id: 'unassigned', name: 'Unassigned', slots: ['Needs Reassignment'], positionsPerRow: null, system: true },
];
export const put = (ctx, token, d, version = null) =>
  call(ctx.env, 'PUT', '/drinks/' + d.id, { token, body: { drink: d, version } });
