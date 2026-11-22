import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv, setupProviders, call, inviteAndLogin } from './helpers.js';
import { buildSql } from '../scripts/import-local.mjs';

let ctx;
before(async () => { await setupProviders(); ctx = await makeEnv(); });
after(() => ctx.close());

const run = async sql => { for (const s of sql.split('\n').filter(l => l.trim() && !l.startsWith('--'))) await ctx.raw.prepare(s).run(); };

test('import keeps ids, converts dollars to integer cents, matches counts, and is rerunnable', async () => {
  const exp = JSON.parse(readFileSync(new URL('./fixtures/old-export.json', import.meta.url), 'utf8'));
  const U = await inviteAndLogin(ctx, 'import@example.test');
  const other = await inviteAndLogin(ctx, 'other@example.test');
  const r = buildSql(exp, 'Import@Example.test');
  assert.equal(r.drinkCount, 3); assert.equal(r.stockCount, 3);
  await run(r.sql); await run(r.sql); // twice: no duplicates, no errors
  const c = (await call(ctx.env, 'GET', '/cellar', { token: U.token })).body;
  assert.deepEqual(c.drinks.map(d => d.id), ['k02', 'k03', 'w01']);
  assert.deepEqual(Object.fromEntries(c.drinks.map(d => [d.id, d.price_cents])), { k02: 1999, k03: null, w01: 2850 });
  assert.equal(c.drinks.flatMap(d => d.stock).length, 3);
  assert.equal(c.drinks.find(d => d.id === 'k02').name, "It's a Test Whisky");
  assert.deepEqual(c.settings.locations.map(l => l.id), ['wine-fridge']); // system location is re-added by the app
  assert.deepEqual(c.settings.scale, [[80, 'Good'], [90, 'Great']]);
  assert.equal((await call(ctx.env, 'GET', '/cellar', { token: other.token })).body.drinks.length, 0);
  // the imported drink can be edited through the API at its version
  const w = c.drinks.find(d => d.id === 'w01');
  assert.equal((await call(ctx.env, 'PUT', '/drinks/w01', { token: U.token, body: { drink: { ...w, name: 'Edited' }, version: w.version } })).status, 200);
});
