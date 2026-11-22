import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { COMPAT, makeEnv, setupProviders, providers, call, googleToken, msToken, inviteAndLogin, MS_CLIENT_ID, ORIGIN } from './helpers.js';

let ctx;
before(async () => { await setupProviders(); ctx = await makeEnv(); });
after(() => ctx.close());

const login = (body, env = ctx.env) => call(env, 'POST', '/auth/google', { body });
const iso = (ms = Date.now()) => new Date(ms).toISOString().replace('Z', '000Z');
const invite = (email, name = '') => ctx.raw.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?1, ?2, ?3, ?4)')
  .bind(crypto.randomUUID(), email, name, iso()).run();

test('invited user signs in with a verified Google email; sub is stored on first sign-in', async () => {
  await invite('first@example.test');
  const r = await login({ idToken: await googleToken({ email: 'First@Example.test', sub: 'sub-first' }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email, 'first@example.test');
  assert.deepEqual(Object.keys(r.body).sort(), ['token', 'user']); // no expires_at: the page relies on a 401
  assert.ok(r.body.token.length >= 40);
  const id = await ctx.raw.prepare("SELECT provider, subject FROM identities WHERE subject = 'sub-first'").first();
  assert.deepEqual({ ...id }, { provider: 'google', subject: 'sub-first' });
  const again = await login({ idToken: await googleToken({ email: 'First@Example.test', sub: 'sub-first' }) });
  assert.equal(again.status, 200);
  assert.equal(again.body.user.id, r.body.user.id);
});

test('the request field is idToken: the old id_token field is refused', async () => {
  await invite('field@example.test');
  const t = await googleToken({ email: 'field@example.test', sub: 'field' });
  assert.equal((await login({ id_token: t })).status, 400);
  assert.equal((await login({ idToken: t })).status, 200);
});

test('unverified Google email is refused', async () => {
  await invite('unv@example.test');
  const r = await login({ idToken: await googleToken({ email: 'unv@example.test', sub: 's-unv', email_verified: false }) });
  assert.equal(r.status, 403); assert.equal(r.body.error, 'email_not_verified');
  const r2 = await login({ idToken: await googleToken({ email: 'unv@example.test', sub: 's-unv2', email_verified: undefined }) });
  assert.equal(r2.status, 403);
});

test('private mode: an unknown email gets 403 not_invited and no user is created', async () => {
  const r = await login({ idToken: await googleToken({ email: 'stranger@example.test', sub: 'stranger' }) });
  assert.equal(r.status, 403); assert.equal(r.body.error, 'not_invited');
  const n = await ctx.raw.prepare("SELECT count(*) n FROM users WHERE email = 'stranger@example.test'").first();
  assert.equal(n.n, 0);
});

test('ALLOW_SIGNUPS=true creates a Google user (the profile version defaults to 1)', async () => {
  const open = await makeEnv({ ALLOW_SIGNUPS: 'true' });
  const r = await login({ idToken: await googleToken({ email: 'new@example.test', sub: 'new-sub', name: 'New P' }) }, open.env);
  assert.equal(r.status, 200); assert.equal(r.body.user.name, 'New P');
  const me = await call(open.env, 'GET', '/me', { token: r.body.token });
  assert.equal(me.body.user.version, 1);
  open.close();
});

test('same email with a different Google sub is refused once linked', async () => {
  await invite('linked@example.test');
  assert.equal((await login({ idToken: await googleToken({ email: 'linked@example.test', sub: 'real-sub' }) })).status, 200);
  const r = await login({ idToken: await googleToken({ email: 'linked@example.test', sub: 'other-sub' }) });
  assert.equal(r.status, 403); assert.equal(r.body.error, 'account_already_linked');
});

test('bad tokens: wrong audience, issuer, expired, wrong signature, malformed, not yet valid, issued in the future', async () => {
  await invite('tok@example.test');
  const base = { email: 'tok@example.test', sub: 'tok' };
  const s = Math.floor(Date.now() / 1000);
  const cases = {
    aud: await googleToken({ ...base, aud: 'someone-else' }),
    iss: await googleToken({ ...base, iss: 'https://evil.example' }),
    exp: await googleToken({ ...base, exp: s - 3600 }),
    nbf: await googleToken({ ...base, nbf: s + 3600 }),
    iat: await googleToken({ ...base, iat: s + 3600 }),
    sig: await googleToken(base, providers.rogue),
    junk: 'not.a.jwt',
    none: (await googleToken(base)).split('.').slice(0, 2).join('.') + '.',
  };
  for (const [k, t] of Object.entries(cases)) assert.equal((await login({ idToken: t })).status, 401, k);
  assert.equal((await login({})).status, 400);
  const n = await ctx.raw.prepare("SELECT count(*) n FROM identities WHERE subject = 'tok'").first();
  assert.equal(n.n, 0);
});

test('Google nonce: optional, but if one is sent it must match the token', async () => {
  await invite('nonce@example.test');
  const t = await googleToken({ email: 'nonce@example.test', sub: 'nonce', nonce: 'abc123' });
  assert.equal((await login({ idToken: t, nonce: 'wrong' })).status, 401);
  assert.equal((await login({ idToken: t, nonce: 'abc123' })).status, 200);
  assert.equal((await login({ idToken: t, nonce: 42 })).status, 400);
});

test('Google sign-in is off (503) while GOOGLE_CLIENT_ID is empty', async () => {
  const e = await makeEnv({ GOOGLE_CLIENT_ID: '' });
  assert.equal((await login({ idToken: await googleToken() }, e.env)).status, 503); e.close();
});

test('Microsoft is disabled while MS_CLIENT_ID is empty', async () => {
  assert.equal((await call(ctx.env, 'POST', '/auth/microsoft', { body: { idToken: await msToken() } })).status, 503);
});

test('In private mode Microsoft links only an email already in users, never creates one, never counts as verified; the nonce is required', async () => {
  const e = await makeEnv({ MS_CLIENT_ID });   // private mode
  const ms = body => call(e.env, 'POST', '/auth/microsoft', { body });
  const stranger = await ms({ idToken: await msToken({ email: 'nobody@example.test', sub: 'ms-x', nonce: 'n1' }), nonce: 'n1' });
  assert.equal(stranger.status, 403); assert.equal(stranger.body.error, 'not_invited');
  await e.raw.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'm@example.test', '', '2000-01-01T00:00:00.000000Z')").run();
  assert.equal((await ms({ idToken: await msToken({ email: 'm@example.test', sub: 'ms-sub', nonce: 'n2' }) })).status, 401);
  assert.equal((await ms({ idToken: await msToken({ email: 'm@example.test', sub: 'ms-sub', nonce: 'n2' }), nonce: 'zzz' })).status, 401);
  assert.equal((await ms({ idToken: await msToken({ email: 'M@example.test', sub: 'ms-sub', nonce: 'n2' }), nonce: 'n2' })).status, 200);
  assert.equal((await ms({ idToken: await msToken({ tid: 'some-work-tenant', sub: 'ms-w', nonce: 'n3' }), nonce: 'n3' })).status, 401);
  assert.equal((await e.raw.prepare("SELECT provider FROM identities WHERE subject = 'ms-sub'").first()).provider, 'microsoft');
  assert.equal((await e.raw.prepare("SELECT verified_email v FROM sessions WHERE user_id = 'u1'").first()).v, 0);
  e.close();
});

test("sessions expire, can be logged out, and a later sign-in purges that user's expired ones", async () => {
  const u = await inviteAndLogin(ctx, 'sess@example.test');
  assert.equal((await call(ctx.env, 'GET', '/me', { token: u.token })).status, 200);
  await ctx.raw.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000000Z' WHERE user_id = ?1").bind(u.id).run();
  assert.equal((await call(ctx.env, 'GET', '/me', { token: u.token })).status, 401);
  const v = await inviteAndLogin(ctx, 'sess2@example.test');
  assert.equal((await call(ctx.env, 'POST', '/me/logout', { token: v.token })).status, 200);
  assert.equal((await call(ctx.env, 'GET', '/me', { token: v.token })).status, 401);
  await login({ idToken: await googleToken({ email: 'sess@example.test', sub: 'sub-sess@example.test' }) });
  const old = await ctx.raw.prepare("SELECT count(*) n FROM sessions WHERE user_id = ?1 AND expires_at < '2001'").bind(u.id).first();
  assert.equal(old.n, 0);
});

test('the clock is injected through deps: a session lasts SESSION_DAYS on the injected clock', async () => {
  const e = await makeEnv({ SESSION_DAYS: '2' });
  const t0 = Date.parse('2030-01-01T00:00:00Z'); e.deps.clock.now = t0;
  await e.raw.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('c1', 'clock@example.test', '', '2030-01-01T00:00:00.000000Z')").run();
  const s = Math.floor(t0 / 1000);
  const r = await call(e.env, 'POST', '/auth/google', { body: { idToken: await googleToken({ email: 'clock@example.test', sub: 'clk', iat: s, exp: s + 600 }) } });
  assert.equal(r.status, 200);
  assert.equal((await e.raw.prepare("SELECT expires_at FROM sessions WHERE user_id = 'c1'").first()).expires_at, '2030-01-03T00:00:00.000000Z');
  e.deps.clock.now = t0 + 47 * 3600_000;
  assert.equal((await call(e.env, 'GET', '/me', { token: r.body.token })).status, 200);
  e.deps.clock.now = t0 + 49 * 3600_000;
  assert.equal((await call(e.env, 'GET', '/me', { token: r.body.token })).status, 401);
  e.close();
});

test('provider keys: cached; an unknown key id forces at most one re-fetch per 5 minutes; a rotated key works after that', async () => {
  const e = await makeEnv();
  const t0 = Date.parse('2030-06-01T00:00:00Z'); e.deps.clock.now = t0;
  const s = Math.floor(t0 / 1000);
  await e.raw.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('k1', 'keys@example.test', '', '2030-01-01T00:00:00.000000Z')").run();
  const tok = (o, p = providers.google) => googleToken({ email: 'keys@example.test', sub: 'keys', iat: s, exp: s + 600, ...o }, p);
  const go = t => call(e.env, 'POST', '/auth/google', { body: { idToken: t } });
  assert.equal((await go(await tok({}))).status, 200);
  assert.equal((await go(await tok({}))).status, 200);
  assert.equal(e.deps.calls.length, 1, 'cached keys are reused');
  const junk = { ...providers.google, kid: 'made-up-kid' };
  for (let i = 0; i < 5; i++) assert.equal((await go(await tok({}, junk))).status, 401);
  assert.equal(e.deps.calls.length, 2, 'only one forced re-fetch');
  const rotated = { ...providers.google, kid: 'g-key-2' };
  e.deps.googleKeys = [providers.google.jwk, { ...providers.google.jwk, kid: 'g-key-2' }];
  const signed = await tok({}, rotated);
  assert.equal((await go(signed)).status, 401, 'within 5 minutes: no re-fetch');
  e.deps.clock.now = t0 + 301_000;
  assert.equal((await go(signed)).status, 200);
  assert.equal(e.deps.calls.length, 3);
  e.close();
});

test('origin check: an unlisted browser origin gets 403 before any work (no database query)', async () => {
  const before = ctx.inst.log.queries;
  const evil = await call(ctx.env, 'POST', '/auth/google', { origin: 'https://evil.example', body: { idToken: 'x' } });
  assert.equal(evil.status, 403); assert.equal(evil.body.error, 'origin_not_allowed');
  assert.equal(ctx.inst.log.queries, before);
  assert.notEqual((await call(ctx.env, 'POST', '/auth/google', { origin: ORIGIN, body: { idToken: 'x' } })).status, 403);
});

test('request body over 100,000 characters is refused; an undecodable path is 404, not 500', async () => {
  const big = await call(ctx.env, 'POST', '/auth/google', { body: 'x'.repeat(100_001) });
  assert.equal(big.status, 400); assert.equal(big.body.error, 'body_too_large');
  const u = await inviteAndLogin(ctx, 'paths@example.test');
  assert.equal((await call(ctx.env, 'PUT', '/drinks/%', { token: u.token, body: {} })).status, 404);
  assert.equal((await call(ctx.env, 'GET', '/nothing', { token: u.token })).status, 404);
  assert.equal((await call(ctx.env, 'POST', '/cellar', { token: u.token, body: {} })).status, 405);
});

test('PATCH /me updates the display name and rejects a stale version', async () => {
  const u = await inviteAndLogin(ctx, 'name@example.test');
  assert.equal((await call(ctx.env, 'GET', '/me', { token: u.token })).body.user.version, 1);
  const ok = await call(ctx.env, 'PATCH', '/me', { token: u.token, body: { name: '  Pat Tester ', version: 1 } });
  assert.equal(ok.status, 200); assert.equal(ok.body.user.name, 'Pat Tester'); assert.equal(ok.body.user.version, 2);
  assert.equal((await call(ctx.env, 'PATCH', '/me', { token: u.token, body: { name: 'Other', version: 1 } })).status, 409);
  assert.equal((await call(ctx.env, 'PATCH', '/me', { token: u.token, body: { name: '' } })).status, 400);
  assert.equal((await call(ctx.env, 'GET', '/me', { token: u.token })).body.user.name, 'Pat Tester');
});

test('core has no test-only settings: the test seam is deps only', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  for (const f of readdirSync(new URL('../core/', import.meta.url)).filter(f => f.endsWith('.js'))) {
    assert.ok(!/TEST_|process\.env|globalThis\.fetch/.test(readFileSync(new URL('../core/' + f, import.meta.url), 'utf8')), f);
  }
});

test('wrangler.toml pins compatibility_date 2026-11-01', () => {
  assert.equal(COMPAT, '2026-11-01');
});

test('open signups never create a user from an unverified email: Microsoft (never verified) and unverified Google both get 403 email_not_verified', async () => {
  const e = await makeEnv({ MS_CLIENT_ID, ALLOW_SIGNUPS: 'true' });
  const ms = await call(e.env, 'POST', '/auth/microsoft', { body: { idToken: await msToken({ email: 'fresh@example.test', sub: 'ms-fresh', nonce: 'n9' }), nonce: 'n9' } });
  assert.equal(ms.status, 403); assert.deepEqual(ms.body, { error: 'email_not_verified' });
  const g = await call(e.env, 'POST', '/auth/google', { body: { idToken: await googleToken({ email: 'fresh2@example.test', sub: 'g-fresh', email_verified: false }) } });
  assert.equal(g.status, 403); assert.deepEqual(g.body, { error: 'email_not_verified' });
  const ok = await call(e.env, 'POST', '/auth/google', { body: { idToken: await googleToken({ email: 'fresh3@example.test', sub: 'g-fresh3' }) } });
  assert.equal(ok.status, 200);
  assert.equal((await e.raw.prepare("SELECT count(*) n FROM users WHERE email IN ('fresh@example.test','fresh2@example.test')").first()).n, 0);
  e.close();
});

test('per-route body limits come from core readJson(req, maxChars): too large is 400 body_too_large, never 413', async () => {
  const u = await inviteAndLogin(ctx, 'limits@example.test');
  const patch = await call(ctx.env, 'PATCH', '/me', { token: u.token, body: { name: 'x'.repeat(2500) } });
  assert.equal(patch.status, 400); assert.deepEqual(patch.body, { error: 'body_too_large' });
  const drink = await call(ctx.env, 'PUT', '/drinks/d-big', { token: u.token, body: { drink: { id: 'd-big', name: 'x'.repeat(95_000) }, version: null } });
  assert.equal(drink.status, 400); assert.deepEqual(drink.body, { error: 'body_too_large' });
  const bulk = await call(ctx.env, 'POST', '/drinks/bulk', { token: u.token, body: { items: [], pad: 'x'.repeat(100_500) } });
  assert.equal(bulk.status, 400); assert.equal(bulk.body.error, 'body_too_large');
});

test('a stale edit is a plain 409 {error:"conflict"} (the page only reads the status and code)', async () => {
  const u = await inviteAndLogin(ctx, 'stale409@example.test');
  const mk = v => call(ctx.env, 'PUT', '/drinks/d-stale', { token: u.token, body: { drink: { id: 'd-stale', type: 'wine', name: 'A', stock: [] }, version: v } });
  assert.equal((await mk(null)).status, 200);
  const r = await mk(7);
  assert.equal(r.status, 409); assert.deepEqual(r.body, { error: 'conflict' });
  const p = await call(ctx.env, 'PATCH', '/me', { token: u.token, body: { name: 'N', version: 99 } });
  assert.equal(p.status, 409); assert.deepEqual(p.body, { error: 'conflict' });
});

// scripts/invite.mjs is what the owner runs against the real database: its SQL must produce a row the core accepts.
test('the invite script writes a user that can sign in with Google (private mode)', async () => {
  const { execFileSync } = await import('node:child_process');
  // process.execPath and an absolute path: no dependence on the current folder or on `node` being found by name (Windows)
  const script = fileURLToPath(new URL('../scripts/invite.mjs', import.meta.url));
  const sql = execFileSync(process.execPath, [script, '--email', 'Invited@Example.test', '--name', 'Inv'], { encoding: 'utf8' });
  const c = await makeEnv();
  try {
    await c.raw.prepare(sql.trim().replace(/;$/, '')).run();
    const row = await c.raw.prepare('SELECT email, created_at FROM users').first();
    assert.equal(row.email, 'invited@example.test');
    assert.ok(!Number.isNaN(Date.parse(row.created_at)) && String(row.created_at).includes('T'), 'created_at is ISO text: ' + row.created_at);
    const r = await call(c.env, 'POST', '/auth/google', { body: { idToken: await googleToken({ email: 'invited@example.test', sub: 'inv-1' }) } });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.email, 'invited@example.test');
  } finally { c.close(); }
});
