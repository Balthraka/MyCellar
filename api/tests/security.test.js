import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { routes } from '../src/routes.js';
import { createApp, userGuard } from '../core/index.js';
import { makeEnv, setupProviders, call, inviteAndLogin, makeDrink, put, LOCS, ORIGIN } from './helpers.js';

let ctx, A, B;
before(async () => {
  await setupProviders();
  ctx = await makeEnv();
  A = await inviteAndLogin(ctx, 'a@example.test');
  B = await inviteAndLogin(ctx, 'b@example.test');
});
after(() => ctx.close());

test('route table: only /auth/* routes are public, everything else uses the sign-in guard', () => {
  for (const r of routes) {
    if (r.guard === 'public') assert.ok(r.path.startsWith('/auth/'), `${r.method} ${r.path} is public but not under /auth/`);
    else assert.equal(r.guard, 'user', `${r.method} ${r.path} must use the 'user' guard`);
    if (r.path.startsWith('/auth/')) assert.equal(r.guard, 'public', r.path);
  }
  assert.ok(routes.some(r => r.guard === 'user'), 'there are protected routes');
});

test('createApp refuses a route whose guard name does not exist', () => {
  assert.throws(() => createApp({ routes: [{ method: 'GET', path: '/x', guard: 'nope', handler: async () => new Response('') }], guards: { user: userGuard } }), /guards table/);
});

test('every protected route returns 401 with no token, a junk token, or an expired session', async () => {
  const expired = 'expiredtoken'.padEnd(43, 'x');
  const { sha256Hex: sha256hex } = await import('../core/index.js');
  await ctx.raw.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, \'2000-01-01T00:00:00.000000Z\', \'2000-01-02T00:00:00.000000Z\')')
    .bind(await sha256hex(expired), A.id).run();
  for (const r of routes.filter(r => r.guard !== 'public')) {
    const path = r.path.replace(':id', 'x1');
    for (const token of [undefined, 'junk', 'a'.repeat(43), expired]) {
      const res = await call(ctx.env, r.method, path, { token, body: r.method === 'GET' ? undefined : {} });
      assert.equal(res.status, 401, `${r.method} ${path} with token ${token}`);
    }
  }
});

test('user B cannot read, change or delete user A\'s drinks, settings or account', async () => {
  const d = makeDrink('x1');
  assert.equal((await put(ctx, A.token, d)).status, 200);
  await call(ctx.env, 'PUT', '/settings', { token: A.token, body: { locations: LOCS } });

  const seenByB = await call(ctx.env, 'GET', '/cellar', { token: B.token });
  assert.deepEqual(seenByB.body.drinks, []);
  assert.equal(seenByB.body.settings.locations, null);

  // B writing the same id with a version of A's drink is stale: B has no such row.
  const edit = await put(ctx, B.token, { ...d, name: 'hijack' }, 1);
  assert.equal(edit.status, 409);
  // B deleting A's id deletes nothing of A's
  await call(ctx.env, 'DELETE', '/drinks/x1', { token: B.token });
  // B's destructive operations touch only B
  for (const op of ['unassign', 'clearstock', 'delete-drinks']) {
    assert.equal((await call(ctx.env, 'POST', '/ops/' + op, { token: B.token, body: {} })).status, 200);
  }
  await call(ctx.env, 'POST', '/ops/replace-all', { token: B.token, body: { locations: LOCS, drinks: [makeDrink('x1')] } });

  const a = await call(ctx.env, 'GET', '/cellar', { token: A.token });
  assert.equal(a.body.drinks.length, 1);
  assert.equal(a.body.drinks[0].name, 'Test Wine x1');
  assert.equal(a.body.drinks[0].stock.length, 1);
  assert.equal(a.body.drinks[0].version, 1);
  assert.deepEqual(a.body.settings.locations.map(l => l.id), ['wine-fridge', 'unassigned']);

  // the same id can exist for both users independently
  const b = await call(ctx.env, 'GET', '/cellar', { token: B.token });
  assert.equal(b.body.drinks.length, 1);
});

test('the user id in a request body is ignored: data is always filed under the session user', async () => {
  const res = await call(ctx.env, 'PUT', '/drinks/y1', { token: B.token, body: { user_id: A.id, drink: { ...makeDrink('y1'), user_id: A.id }, version: null } });
  assert.equal(res.status, 200);
  const rows = await ctx.raw.prepare('SELECT user_id FROM drinks WHERE id = \'y1\'').all();
  assert.deepEqual(rows.results.map(r => r.user_id), [B.id]);
});

test('delete my account removes only this user\'s data in this app', async () => {
  const C = await inviteAndLogin(ctx, 'c@example.test');
  await put(ctx, C.token, makeDrink('c1'));
  await call(ctx.env, 'PUT', '/settings', { token: C.token, body: { locations: LOCS } });
  const before = await call(ctx.env, 'GET', '/cellar', { token: A.token });
  const del = await call(ctx.env, 'DELETE', '/me', { token: C.token });
  assert.equal(del.status, 200);
  for (const t of ['users', 'drinks', 'stock', 'settings', 'sessions', 'identities']) {
    const col = t === 'users' ? 'id' : 'user_id';
    const n = await ctx.raw.prepare(`SELECT count(*) AS n FROM ${t} WHERE ${col} = ?1`).bind(C.id).first();
    assert.equal(n.n, 0, t);
  }
  assert.equal((await call(ctx.env, 'GET', '/me', { token: C.token })).status, 401);
  const after = await call(ctx.env, 'GET', '/cellar', { token: A.token });
  assert.deepEqual(after.body, before.body);
});

test('CORS allows only the app origin, never *', async () => {
  const ok = await call(ctx.env, 'GET', '/me', { token: A.token, origin: ORIGIN });
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const evil = await call(ctx.env, 'GET', '/me', { token: A.token, origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);
  const pre = await call(ctx.env, 'OPTIONS', '/cellar', { origin: ORIGIN });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const preEvil = await call(ctx.env, 'OPTIONS', '/cellar', { origin: 'https://evil.example' });
  assert.equal(preEvil.status, 403);
});

test('session tokens are stored hashed', async () => {
  const rows = await ctx.raw.prepare('SELECT token_hash FROM sessions').all();
  for (const r of rows.results) {
    assert.match(r.token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(r.token_hash, A.token);
  }
});
