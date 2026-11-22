import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, setupProviders, call, inviteAndLogin, makeDrink, put, LOCS } from './helpers.js';

let ctx, U;
before(async () => { await setupProviders(); ctx = await makeEnv(); U = await inviteAndLogin(ctx, 'u@example.test'); });
after(() => ctx.close());
const cellar = async (u = U) => (await call(ctx.env, 'GET', '/cellar', { token: u.token })).body;
const counts = async () => ({ ...(await ctx.raw.prepare('SELECT (SELECT count(*) FROM drinks) d, (SELECT count(*) FROM stock) s, (SELECT count(*) FROM _guard) g').first()) });

test('create, read back: fields, stock order and integer cents survive', async () => {
  const d = makeDrink('d1', { price_cents: 1999, expertRating: 97, stock: [
    { id: 'z9', location: 'wine-fridge', sublocation: 'Top Shelf', position: null, quantity: 1, dateAdded: '2024-01-01', status: 'in_stock', dateFinished: null },
    { id: 'a1', location: 'wine-rack', sublocation: 'Row 2', position: 7, quantity: 1, dateAdded: '2024-02-01', status: 'finished', dateFinished: '2024-03-01' },
    { id: 'm5', location: 'bar-cart', sublocation: '', position: null, quantity: 3, dateAdded: null, status: 'in_stock', dateFinished: null },
  ] });
  const r = await put(ctx, U.token, d);
  assert.deepEqual(r.body, { version: 1 });
  const back = (await cellar()).drinks.find(x => x.id === 'd1');
  assert.deepEqual({ ...back, version: undefined }, { ...d, version: undefined });
  assert.equal(back.version, 1);
  assert.deepEqual(back.stock.map(s => s.id), ['z9', 'a1', 'm5']); // order kept, not id order
  assert.ok(Number.isInteger(back.price_cents));
});

test('money must be whole cents: floats, negatives and strings are rejected', async () => {
  for (const bad of [28.5, -1, '12', 1e12, true]) {
    const r = await put(ctx, U.token, makeDrink('m1', { price_cents: bad }));
    assert.equal(r.status, 400, String(bad));
  }
  assert.equal((await put(ctx, U.token, makeDrink('m2', { price_cents: null }))).status, 200);
  assert.equal((await put(ctx, U.token, makeDrink('m3', { price: 28.5, price_cents: 2850 }))).status, 200);
  const m3 = (await cellar()).drinks.find(x => x.id === 'm3');
  assert.equal(m3.price, undefined); // the float field is never stored
});

test('version: update bumps it; a stale edit gets 409 and changes nothing (atomic with stock)', async () => {
  await put(ctx, U.token, makeDrink('v1'));
  const v1 = (await cellar()).drinks.find(x => x.id === 'v1');
  const first = await put(ctx, U.token, { ...v1, name: 'First edit', stock: [] }, v1.version);
  assert.deepEqual(first.body, { version: 2 });
  const before = await counts();
  const stale = await put(ctx, U.token, { ...v1, name: 'Stale edit', stock: [{ ...v1.stock[0], id: 'new-stock' }] }, v1.version);
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'conflict');
  assert.deepEqual(await counts(), before);
  const now = (await cellar()).drinks.find(x => x.id === 'v1');
  assert.equal(now.name, 'First edit'); assert.equal(now.version, 2); assert.deepEqual(now.stock, []);
  assert.equal((await put(ctx, U.token, makeDrink('nope'), 5)).status, 409); // update of a missing drink
});

test('creating an id that already exists is a 409, not an overwrite', async () => {
  await put(ctx, U.token, makeDrink('dup'));
  const r = await put(ctx, U.token, makeDrink('dup', { name: 'overwrite' }));
  assert.equal(r.status, 409);
  assert.equal((await cellar()).drinks.find(x => x.id === 'dup').name, 'Test Wine dup');
});

test('a drink keeps its own stock ids; the same stock id on two drinks is fine', async () => {
  await put(ctx, U.token, makeDrink('s1'));
  const twin = makeDrink('s2'); twin.stock[0].id = 's1s1';
  assert.equal((await put(ctx, U.token, twin)).status, 200);
  const c = await cellar();
  assert.equal(c.drinks.find(d => d.id === 's1').stock.length, 1);
  assert.equal(c.drinks.find(d => d.id === 's2').stock.length, 1);
  const dup = makeDrink('s3'); dup.stock.push({ ...dup.stock[0] });
  assert.equal((await put(ctx, U.token, dup)).status, 400); // duplicate within one drink
});

test('bulk save is all-or-nothing and reports the new versions', async () => {
  await put(ctx, U.token, makeDrink('b1')); await put(ctx, U.token, makeDrink('b2'));
  const cur = Object.fromEntries((await cellar()).drinks.map(d => [d.id, d]));
  const ok = await call(ctx.env, 'POST', '/drinks/bulk', { token: U.token, body: { items: [
    { drink: { ...cur.b1, name: 'B1 new' }, version: cur.b1.version },
    { drink: { ...cur.b2, name: 'B2 new' }, version: cur.b2.version },
    { drink: makeDrink('b3'), version: null },
  ] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.versions, [{ id: 'b1', version: 2 }, { id: 'b2', version: 2 }, { id: 'b3', version: 1 }]);
  const before = await counts();
  const mixed = await call(ctx.env, 'POST', '/drinks/bulk', { token: U.token, body: { items: [
    { drink: { ...cur.b1, name: 'must not land' }, version: 2 },
    { drink: { ...cur.b2, name: 'must not land' }, version: 1 }, // stale
    { drink: makeDrink('b4'), version: null },
  ] } });
  assert.equal(mixed.status, 409);
  assert.deepEqual(await counts(), before);
  const after = Object.fromEntries((await cellar()).drinks.map(d => [d.id, d]));
  assert.equal(after.b1.name, 'B1 new'); assert.equal(after.b1.version, 2); assert.equal(after.b4, undefined);
});

test('delete a drink: removes its stock; a stale version is refused', async () => {
  await put(ctx, U.token, makeDrink('del1'));
  assert.equal((await call(ctx.env, 'DELETE', '/drinks/del1?version=9', { token: U.token })).status, 409);
  assert.ok((await cellar()).drinks.some(d => d.id === 'del1'));
  assert.equal((await call(ctx.env, 'DELETE', '/drinks/del1?version=1', { token: U.token })).status, 200);
  assert.ok(!(await cellar()).drinks.some(d => d.id === 'del1'));
  const orphan = await ctx.raw.prepare("SELECT count(*) n FROM stock WHERE drink_id = 'del1'").first();
  assert.equal(orphan.n, 0);
});

test('validation: bad ids, types, stock and oversized data are rejected', async () => {
  const bad = [
    makeDrink('ok1', { type: 'beer' }), makeDrink('ok1', { name: '' }),
    makeDrink('ok1', { stock: [{ id: 'q', location: 'x', quantity: 0, status: 'in_stock' }] }),
    makeDrink('ok1', { stock: [{ id: 'q', location: 'x', quantity: 1, status: 'weird' }] }),
    makeDrink('ok1', { stock: [{ id: 'q', location: 'x', quantity: 1.5, status: 'in_stock' }] }),
    makeDrink('ok1', { notes: 'x'.repeat(25000) }),
  ];
  for (const d of bad) assert.equal((await put(ctx, U.token, d)).status, 400);
  assert.equal((await call(ctx.env, 'PUT', '/drinks/bad id!', { token: U.token, body: { drink: makeDrink('bad id!') } })).status, 400);
  assert.equal((await call(ctx.env, 'PUT', '/drinks/aa', { token: U.token, body: { drink: makeDrink('bb') } })).status, 400);
  assert.equal((await call(ctx.env, 'PUT', '/drinks/aa', { token: U.token, body: '{nope' })).status, 400);
  assert.equal((await call(ctx.env, 'PUT', '/drinks/aa', { token: U.token, body: 'x'.repeat(130000) })).status, 400);
  const many = Array.from({ length: 51 }, (_, i) => ({ drink: makeDrink('many' + i) }));
  assert.equal((await call(ctx.env, 'POST', '/drinks/bulk', { token: U.token, body: { items: many } })).status, 400);
});

test('settings: create, versioned update, stale 409, validation', async () => {
  const W = await inviteAndLogin(ctx, 'w@example.test');
  const empty = await cellar(W);
  assert.deepEqual(empty.settings, { locations: null, scale: null, version: 0 });
  assert.deepEqual((await call(ctx.env, 'PUT', '/settings', { token: W.token, body: { locations: LOCS } })).body, { version: 1 });
  assert.equal((await call(ctx.env, 'PUT', '/settings', { token: W.token, body: { locations: LOCS } })).status, 409); // create twice
  assert.deepEqual((await call(ctx.env, 'PUT', '/settings', { token: W.token, body: { scale: [[80, 'Good'], [90, 'Great']], version: 1 } })).body, { version: 2 });
  assert.equal((await call(ctx.env, 'PUT', '/settings', { token: W.token, body: { scale: [[1, 'x']], version: 1 } })).status, 409);
  const s = (await cellar(W)).settings;
  assert.equal(s.version, 2); assert.deepEqual(s.scale, [[80, 'Good'], [90, 'Great']]); assert.deepEqual(s.locations, LOCS); // locations kept
  assert.equal((await call(ctx.env, 'PUT', '/settings', { token: W.token, body: { locations: [{ id: 'a', name: '', slots: [] }], version: 2 } })).status, 400);
  assert.equal((await call(ctx.env, 'PUT', '/settings', { token: W.token, body: { version: 2 } })).status, 400);
});

test('Cellar Management operations', async () => {
  const O = await inviteAndLogin(ctx, 'o@example.test');
  const a = makeDrink('o1'); const b = makeDrink('o2', { stock: [
    { id: 'o2a', location: 'wine-rack', sublocation: 'Row 1', position: 3, quantity: 1, dateAdded: 'x', status: 'in_stock', dateFinished: null },
    { id: 'o2b', location: 'wine-rack', sublocation: 'Row 1', position: 4, quantity: 1, dateAdded: 'x', status: 'finished', dateFinished: 'y' }] });
  const c = makeDrink('o3', { stock: [] });
  for (const d of [a, b, c]) await put(ctx, O.token, d);
  const op = (name, body = {}) => call(ctx.env, 'POST', '/ops/' + name, { token: O.token, body });

  assert.equal((await op('unassign')).status, 200);
  let cur = await cellar(O);
  const inStock = cur.drinks.flatMap(d => d.stock).filter(s => s.status === 'in_stock');
  assert.ok(inStock.every(s => s.location === 'unassigned' && s.sublocation === '' && s.position === null));
  assert.equal(cur.drinks.flatMap(d => d.stock).find(s => s.status === 'finished').location, 'wine-rack'); // finished untouched
  assert.deepEqual(cur.drinks.map(d => d.version), [2, 2, 1]); // only affected drinks were bumped

  // a client holding the old version is now correctly refused
  assert.equal((await put(ctx, O.token, { ...a, name: 'old' }, 1)).status, 409);

  assert.equal((await op('clearstock', { locations: LOCS })).status, 200);
  cur = await cellar(O);
  assert.equal(cur.drinks.length, 3);
  assert.deepEqual(cur.drinks.flatMap(d => d.stock).map(s => s.status), ['finished']);
  assert.deepEqual(cur.settings.locations, LOCS);

  assert.equal((await op('delete-drinks', { locations: [] })).status, 200);
  cur = await cellar(O);
  assert.deepEqual(cur.drinks, []); assert.deepEqual(cur.settings.locations, []);

  const demo = Array.from({ length: 30 }, (_, i) => makeDrink('w' + String(i).padStart(2, '0')));
  assert.equal((await op('replace-all', { drinks: demo, locations: LOCS })).status, 200);
  cur = await cellar(O);
  assert.equal(cur.drinks.length, 30); assert.equal(cur.drinks.flatMap(d => d.stock).length, 30);
  assert.ok(cur.drinks.every(d => d.version === 1));
  // replace-all is atomic: a bad drink in the list leaves the cellar untouched
  const broken = [...demo.slice(0, 5), makeDrink('zz', { type: 'cider' })];
  assert.equal((await op('replace-all', { drinks: broken, locations: LOCS })).status, 400);
  assert.equal((await cellar(O)).drinks.length, 30);
});

// The changed-rows-only bottle write must always leave exactly the list the browser sent:
// same entries, same order, nothing left over, whatever mix of adds, removals and edits.
test('bottle rows always equal the saved list after random edits (single and bulk)', async () => {
  const R = await inviteAndLogin(ctx, 'rand@example.test');
  let seed = 12345; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let nextId = 0;
  const entry = () => ({ id: 'e' + (nextId++), location: ['wine-rack', 'wine-fridge', 'bar-cart'][rnd(3)], sublocation: ['Row 1', 'Top Shelf', ''][rnd(3)],
    position: rnd(2) ? null : 1 + rnd(12), quantity: 1 + rnd(4), dateAdded: rnd(2) ? '2024-01-01' : null, status: rnd(3) ? 'in_stock' : 'finished', dateFinished: rnd(2) ? null : '2024-02-02' });
  const model = new Map(); // id -> { drink, version }
  for (const id of ['r1', 'r2', 'r3']) {
    const d = makeDrink(id, { stock: Array.from({ length: rnd(5) }, entry) });
    assert.equal((await put(ctx, R.token, d)).status, 200);
    model.set(id, { drink: d, version: 1 });
  }
  const mutate = stock => {
    const s = stock.map(x => ({ ...x }));
    switch (rnd(6)) {
      case 0: s.push(entry()); break;                              // add at end
      case 1: if (s.length) s.splice(rnd(s.length), 1); break;     // remove anywhere (later rows shift)
      case 2: if (s.length) s[rnd(s.length)].quantity += 1; break; // edit one
      case 3: s.reverse(); break;                                  // reorder
      case 4: s.length = 0; break;                                 // clear
      default: break;                                              // unchanged
    }
    return s;
  };
  for (let step = 0; step < 60; step++) {
    const ids = ['r1', 'r2', 'r3'].filter(() => rnd(2) || step % 3 === 0);
    if (!ids.length) continue;
    const next = ids.map(id => ({ ...model.get(id).drink, review: 'step' + step, stock: mutate(model.get(id).drink.stock) }));
    const res = ids.length === 1
      ? await call(ctx.env, 'PUT', '/drinks/' + ids[0], { token: R.token, body: { drink: next[0], version: model.get(ids[0]).version } })
      : await call(ctx.env, 'POST', '/drinks/bulk', { token: R.token, body: { items: next.map((d, i) => ({ drink: d, version: model.get(ids[i]).version })) } });
    assert.equal(res.status, 200, `step ${step}`);
    ids.forEach((id, i) => model.set(id, { drink: next[i], version: model.get(id).version + 1 }));
    if (step % 5 === 0 || step === 59) {
      const c = (await call(ctx.env, 'GET', '/cellar', { token: R.token })).body.drinks;
      for (const id of ['r1', 'r2', 'r3']) {
        const got = c.find(d => d.id === id);
        assert.deepEqual(got.stock, model.get(id).drink.stock, `step ${step} ${id}`);
        assert.equal(got.version, model.get(id).version);
      }
    }
  }
  const rows = await ctx.raw.prepare('SELECT drink_id, count(*) n, max(ord) m FROM stock WHERE user_id = ?1 GROUP BY drink_id').bind(R.id).all();
  for (const r of rows.results) assert.equal(r.m, r.n - 1, 'no gaps in ord for ' + r.drink_id); // contiguous 0..n-1
});

test('an unchanged bottle list costs no bottle writes; one changed bottle writes one bottle row', async () => {
  const W = await inviteAndLogin(ctx, 'wr@example.test');
  const d = makeDrink('wr1', { stock: Array.from({ length: 5 }, (_, i) => ({ id: 'w' + i, location: 'wine-rack', sublocation: 'Row 1', position: i + 1, quantity: 2, dateAdded: null, status: 'in_stock', dateFinished: null })) });
  await put(ctx, W.token, d);
  const written = async fn => { const l = ctx.inst.log; l.rowsWritten = 0; const r = await fn(); assert.equal(r.status, 200); return l.rowsWritten; };
  assert.equal(await written(() => put(ctx, W.token, { ...d, name: 'only the name' }, 1)), 1);
  const changed = { ...d, name: 'only the name', stock: d.stock.map((s, i) => i === 3 ? { ...s, quantity: 1 } : s) };
  assert.equal(await written(() => put(ctx, W.token, changed, 2)), 2);
});
