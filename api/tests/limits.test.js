// Free-tier safety: query plans, queries per request, bound parameters, rows read/written.
// Rows are counted from D1's own `meta` on every statement, on a made-up dataset about
// ten times the size of what MyCellar will really hold. Results go to docs/USAGE.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { makeEnv, setupProviders, call, inviteAndLogin, makeDrink, LOCS } from './helpers.js';

let ctx, big, others;
const table = [];
before(async () => {
  await setupProviders(); ctx = await makeEnv();
  others = [];
  for (let i = 0; i < 4; i++) others.push(await inviteAndLogin(ctx, `other${i}@example.test`));
  big = await inviteAndLogin(ctx, 'big@example.test');
  // Four other users with 100 drinks each, and the user under test with 500 (30 is a
  // realistic real cellar; this is more than 15x that).
  for (const [u, n] of [...others.map(u => [u, 100]), [big, 500]]) {
    for (let from = 0; from < n; from += 50) {
      const items = Array.from({ length: Math.min(50, n - from) }, (_, i) => {
        const id = `${u.email.slice(0, 3)}${from + i}`;
        return { drink: makeDrink(id, { stock: [
          { id: id + 'a', location: 'wine-rack', sublocation: 'Row ' + (i % 5), position: (i % 12) + 1, quantity: 1, dateAdded: '2024-01-01', status: 'in_stock', dateFinished: null },
          { id: id + 'b', location: 'wine-fridge', sublocation: 'Top Shelf', position: null, quantity: 2, dateAdded: '2024-01-01', status: 'finished', dateFinished: '2024-02-02' }] }) };
      });
      const r = await call(ctx.env, 'POST', '/drinks/bulk', { token: u.token, body: { items } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    await call(ctx.env, 'PUT', '/settings', { token: u.token, body: { locations: LOCS } });
  }
});
after(() => {
  const md = ['# MyCellar usage (local D1, made-up data)', '',
    'Measured from D1 `meta.rows_read` / `meta.rows_written` per request. Dataset: 4 users x 100 drinks, and the measured user has 500 drinks / 1,000 stock rows (a real cellar is about 30).', '',
    'Free limits: 5,000,000 rows read and 100,000 rows written per day; 50 queries per request; 100 bound parameters per query.', '',
    '| Route | Queries | Max params | Rows read | Rows written |', '|---|---|---|---|---|',
    ...table.map(r => `| ${r.name} | ${r.queries} | ${r.params} | ${r.read} | ${r.written} |`), ''].join('\n');
  writeFileSync(new URL('../docs/USAGE.md', import.meta.url), md);
  ctx.close();
});

async function measure(name, method, path, opts) {
  ctx.inst.log.queries = 0; ctx.inst.log.rowsRead = 0; ctx.inst.log.rowsWritten = 0; ctx.inst.log.maxParams = 0;
  const res = await call(ctx.env, method, path, opts);
  const l = ctx.inst.log;
  table.push({ name, queries: l.queries, params: l.maxParams, read: l.rowsRead, written: l.rowsWritten });
  assert.ok(res.status < 300, `${name}: ${res.status} ${JSON.stringify(res.body)}`);
  assert.ok(l.queries <= 50, `${name}: ${l.queries} queries`);
  assert.ok(l.maxParams <= 100, `${name}: ${l.maxParams} bound params`);
  return { res, ...l };
}

test('every statement the Worker runs uses an index (no table scans)', async () => {
  // run the main routes so the instrumented DB has seen their SQL
  const T = big.token;
  await call(ctx.env, 'GET', '/cellar', { token: T });
  const d = makeDrink('plan1');
  await call(ctx.env, 'PUT', '/drinks/plan1', { token: T, body: { drink: d, version: null } });
  await call(ctx.env, 'PUT', '/drinks/plan1', { token: T, body: { drink: d, version: 1 } });
  await call(ctx.env, 'POST', '/drinks/bulk', { token: T, body: { items: [{ drink: d, version: 2 }] } });
  await call(ctx.env, 'DELETE', '/drinks/plan1?version=3', { token: T });
  await call(ctx.env, 'PUT', '/settings', { token: T, body: { scale: [[80, 'a']], version: 1 } });
  await call(ctx.env, 'PATCH', '/me', { token: T, body: { name: 'N' } });
  const P = await inviteAndLogin(ctx, 'plan@example.test');
  for (const op of ['unassign', 'clearstock', 'delete-drinks']) await call(ctx.env, 'POST', '/ops/' + op, { token: P.token, body: { locations: LOCS } });
  await call(ctx.env, 'POST', '/ops/replace-all', { token: P.token, body: { drinks: [makeDrink('p1')], locations: LOCS } });
  await call(ctx.env, 'POST', '/me/logout', { token: P.token });
  const Q = await inviteAndLogin(ctx, 'plan2@example.test');
  await call(ctx.env, 'DELETE', '/me', { token: Q.token });

  const own = /\b(drinks|stock|users|sessions|identities|settings)\b/;
  // Statements that legitimately read or change every row of one user (loading the cellar,
  // the bulk operations, deleting the account). Anything else touching drinks/stock with
  // only `user_id=?` as its key is a range scan of the whole user and fails the test.
  const wholeUser = [
    /^SELECT id, version, price_cents, data FROM drinks WHERE user_id = \?1 ORDER BY id/,
    /^SELECT drink_id, id, location[\s\S]*FROM stock WHERE user_id = \?1 ORDER BY/,
    /^DELETE FROM (stock|drinks) WHERE user_id = \?1$/,
    /^DELETE FROM users WHERE id = \?1$/, // cascades to the user's own rows
    /^UPDATE stock SET location = 'unassigned'/,
    /^UPDATE drinks SET version = version \+ 1, updated_at = \?2 WHERE user_id = \?1\s+AND id IN \(SELECT drink_id FROM stock/,
    /^DELETE FROM stock WHERE user_id = \?1 AND status = 'in_stock'/,
  ];
  let checked = 0; const scans = [];
  for (const [sql, binds] of ctx.inst.log.sql) {
    if (/^\s*(INSERT INTO (_guard|settings|sessions|identities|users)|PRAGMA)/i.test(sql) && !/SELECT/i.test(sql)) continue;
    const plan = await ctx.raw.prepare('EXPLAIN QUERY PLAN ' + sql).bind(...binds).all();
    checked++;
    for (const row of plan.results) {
      // `SCAN <alias>` on json_each rows (j, s, i, value) is fine: that is the request's own JSON.
      const m = /^SCAN (\w+)/.exec(row.detail);
      if (m && own.test(row.detail) && !['j', 's', 'i', 'json_each'].includes(m[1]) ) scans.push(`${row.detail}  <=  ${sql.replace(/\s+/g, ' ').slice(0, 90)}`);
      else if (m && !['j', 's', 'i', 'json_each', 'value'].includes(m[1]) && own.test(m[1])) scans.push(row.detail);
      const partial = /^SEARCH (drinks|stock) USING (?:COVERING )?(?:INDEX \w+|PRIMARY KEY) \(user_id=\?\)$/.exec(row.detail);
      if (partial && !wholeUser.some(re => re.test(sql.trim()))) scans.push(`range scan of a whole user: ${row.detail}  <=  ${sql.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
  assert.ok(checked > 20, `only ${checked} statements checked`);
  assert.deepEqual(scans, []);
});

test('opening the app reads only this user\'s rows, however big the database is', async () => {
  const { res, rowsRead } = await measure('GET /cellar (500 drinks, 1,000 stock rows)', 'GET', '/cellar', { token: big.token });
  assert.equal(res.body.drinks.length, 500);
  // auth (2 rows) + 500 drinks + 1000 stock + settings; four other users' 400 drinks are not touched
  assert.ok(rowsRead < 1700, `read ${rowsRead}`);
  const small = await measure('GET /cellar (100 drinks, 200 stock rows)', 'GET', '/cellar', { token: others[0].token });
  assert.ok(small.rowsRead < 400, `read ${small.rowsRead}`);
});

test('single-drink writes touch a handful of rows regardless of cellar size', async () => {
  const d = makeDrink('bigNew');
  const create = await measure('PUT /drinks/:id (new drink, 1 stock row)', 'PUT', '/drinks/bigNew', { token: big.token, body: { drink: d, version: null } });
  assert.ok(create.rowsRead < 30, `read ${create.rowsRead}`); assert.ok(create.rowsWritten < 12, `wrote ${create.rowsWritten}`);
  const upd = await measure('PUT /drinks/:id (edit, 1 stock row)', 'PUT', '/drinks/bigNew', { token: big.token, body: { drink: { ...d, name: 'x' }, version: 1 } });
  assert.ok(upd.rowsRead < 30, `read ${upd.rowsRead}`); assert.ok(upd.rowsWritten < 14, `wrote ${upd.rowsWritten}`);
  const del = await measure('DELETE /drinks/:id', 'DELETE', '/drinks/bigNew?version=2', { token: big.token });
  assert.ok(del.rowsRead < 30, `read ${del.rowsRead}`);
});

test('bulk save of 50 drinks reads about 10 rows per drink', async () => {
  const cur = (await call(ctx.env, 'GET', '/cellar', { token: big.token })).body.drinks.slice(0, 50);
  const m = await measure('POST /drinks/bulk (50 drinks, 100 stock rows)', 'POST', '/drinks/bulk', { token: big.token, body: { items: cur.map(d => ({ drink: { ...d, review: 'edited' }, version: d.version })) } });
  assert.ok(m.rowsRead < 800, `read ${m.rowsRead}`);
  assert.equal(m.res.body.versions.length, 50);
});

test('Cellar Management operations on the 500-drink cellar', async () => {
  const U = await measure('POST /ops/unassign (500 drinks)', 'POST', '/ops/unassign', { token: big.token, body: {} });
  assert.ok(U.rowsRead < 6000, `read ${U.rowsRead}`);
  const C = await measure('POST /ops/clearstock (500 drinks)', 'POST', '/ops/clearstock', { token: big.token, body: {} });
  assert.ok(C.rowsRead < 6000, `read ${C.rowsRead}`);
  const sv = (await call(ctx.env, 'GET', '/cellar', { token: big.token })).body.settings.version;
  const S = await measure('PUT /settings', 'PUT', '/settings', { token: big.token, body: { scale: [[80, 'Good']], version: sv } });
  assert.ok(S.rowsRead < 20);
  const demo = Array.from({ length: 30 }, (_, i) => makeDrink('demo' + i));
  const R = await measure('POST /ops/replace-all (wipe 500, load 30-drink demo)', 'POST', '/ops/replace-all', { token: big.token, body: { drinks: demo, locations: LOCS } });
  assert.ok(R.rowsRead < 6000, `read ${R.rowsRead}`);
  const others0 = (await call(ctx.env, 'GET', '/cellar', { token: others[0].token })).body;
  assert.equal(others0.drinks.length, 100); // other users untouched by all of the above
});

test('sign-in and deleting an account', async () => {
  const L = await measure('POST /auth/google (existing user)', 'POST', '/auth/google', { body: { idToken: await (await import('./helpers.js')).googleToken({ email: others[1].email, sub: 'sub-' + others[1].email }) } });
  assert.ok(L.rowsRead < 40, `read ${L.rowsRead}`);
  const D = await measure('DELETE /me (100 drinks, 200 stock rows)', 'DELETE', '/me', { token: others[1].token });
  assert.ok(D.rowsRead < 1500, `read ${D.rowsRead}`);
});
