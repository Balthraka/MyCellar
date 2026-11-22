// All D1 statements for cellar data. Every statement filters by user_id first, and the
// user id only ever comes from the verified session, never from the request.
import { conflict, nowMs } from './util.js';

const GUARD_TABLE = '_guard';
export const isStaleError = e => /edit_is_current|UNIQUE constraint failed|PRIMARY KEY/i.test(String(e && e.message));

// Runs a batch; a failed guard or a unique clash rolls everything back and becomes 409.
export async function runBatch(db, statements) {
  try {
    return await db.batch(statements);
  } catch (e) {
    if (isStaleError(e)) throw conflict('conflict');
    throw e;
  }
}

// ── Drinks: one write path for single saves, bulk saves, demo loads ─────────────────
// items come from validate.normaliseItems: { id, v (null = new), price_cents, data, stock[] }.
// Four statements, however many drinks: 1 guard, 2 drink upsert, 3 bottle upsert, 4 drop trailing bottles.
export function drinkWriteStatements(db, userId, items, t = nowMs(), oldCounts = new Map()) {
  const payload = JSON.stringify(items.map(i => ({
    id: i.id, v: i.v, price: i.price_cents, data: i.data,
    // bottle rows that exist now but not in the new list (their ords are the trailing ones)
    drop: Array.from({ length: Math.max(0, (oldCounts.get(i.id) || 0) - i.stock.length) }, (_, k) => i.stock.length + k),
    stock: i.stock.map(s => ({ id: s.id, location: s.location, sublocation: s.sublocation, position: s.position,
      quantity: s.quantity, date_added: s.date_added, status: s.status, date_finished: s.date_finished })),
  })));
  return [
    // Stale or clashing item -> CHECK fails -> the whole batch rolls back.
    db.prepare(`INSERT INTO ${GUARD_TABLE}(ok) SELECT 0 WHERE EXISTS (
        SELECT 1 FROM json_each(?1) j
        WHERE (json_extract(j.value,'$.v') IS NULL
               AND EXISTS (SELECT 1 FROM drinks d WHERE d.user_id = ?2 AND d.id = json_extract(j.value,'$.id')))
           OR (json_extract(j.value,'$.v') IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM drinks d WHERE d.user_id = ?2 AND d.id = json_extract(j.value,'$.id')
                               AND d.version = json_extract(j.value,'$.v'))))`).bind(payload, userId),
    // One upsert driven by the request's own rows: new drinks insert, existing ones (whose
    // versions the guard just verified) update. No scan of the user's drinks.
    db.prepare(`INSERT INTO drinks (user_id, id, version, price_cents, data, created_at, updated_at)
        SELECT ?2, json_extract(value,'$.id'), 1, json_extract(value,'$.price'), json_extract(value,'$.data'), ?3, ?3
        FROM json_each(?1) WHERE true
        ON CONFLICT (user_id, id) DO UPDATE SET version = drinks.version + 1, price_cents = excluded.price_cents,
          data = excluded.data, updated_at = excluded.updated_at`).bind(payload, userId, t),
    // Bottle rows: only rows that are new or different are written (an unchanged row costs no
    // write), then rows past the end of the new list are removed.
    db.prepare(`INSERT INTO stock (user_id, drink_id, ord, id, location, sublocation, position, quantity, date_added, status, date_finished)
        SELECT ?2, json_extract(j.value,'$.id'), s.key, json_extract(s.value,'$.id'),
               json_extract(s.value,'$.location'), json_extract(s.value,'$.sublocation'), json_extract(s.value,'$.position'),
               json_extract(s.value,'$.quantity'), json_extract(s.value,'$.date_added'),
               json_extract(s.value,'$.status'), json_extract(s.value,'$.date_finished')
        FROM json_each(?1) j, json_each(j.value,'$.stock') s WHERE true
        ON CONFLICT (user_id, drink_id, ord) DO UPDATE SET id = excluded.id, location = excluded.location,
          sublocation = excluded.sublocation, position = excluded.position, quantity = excluded.quantity,
          date_added = excluded.date_added, status = excluded.status, date_finished = excluded.date_finished
        WHERE stock.id IS NOT excluded.id OR stock.location IS NOT excluded.location
           OR stock.sublocation IS NOT excluded.sublocation OR stock.position IS NOT excluded.position
           OR stock.quantity IS NOT excluded.quantity OR stock.date_added IS NOT excluded.date_added
           OR stock.status IS NOT excluded.status OR stock.date_finished IS NOT excluded.date_finished`).bind(payload, userId),
    db.prepare(`DELETE FROM stock WHERE (user_id, drink_id, ord) IN (
        SELECT ?2, json_extract(j.value,'$.id'), d.value FROM json_each(?1) j, json_each(j.value,'$.drop') d)`).bind(payload, userId),
  ];
}

// How many bottle rows each existing drink has now, so the write knows which trailing rows to drop.
// Safe without a transaction: if anyone changed the drink since, its version moved and the guard
// in the same batch rejects the write (409).
export async function stockCounts(db, userId, items) {
  const ids = items.filter(i => i.v != null).map(i => i.id);
  if (!ids.length) return new Map();
  const r = await db.prepare(`SELECT drink_id, count(*) AS c FROM stock WHERE user_id = ?1
      AND drink_id IN (SELECT value FROM json_each(?2)) GROUP BY drink_id`).bind(userId, JSON.stringify(ids)).all();
  return new Map(r.results.map(x => [x.drink_id, x.c]));
}

export const nextVersions = items => items.map(i => ({ id: i.id, version: i.v == null ? 1 : i.v + 1 }));

export function deleteDrinkStatements(db, userId, id, version) {
  return [
    db.prepare(`INSERT INTO ${GUARD_TABLE}(ok) SELECT 0 WHERE ?3 IS NOT NULL
        AND EXISTS (SELECT 1 FROM drinks WHERE user_id = ?1 AND id = ?2 AND version <> ?3)`).bind(userId, id, version),
    db.prepare('DELETE FROM stock WHERE user_id = ?1 AND drink_id = ?2').bind(userId, id),
    db.prepare('DELETE FROM drinks WHERE user_id = ?1 AND id = ?2').bind(userId, id),
  ];
}

export function loadCellarStatements(db, userId) {
  return [
    db.prepare('SELECT id, version, price_cents, data FROM drinks WHERE user_id = ?1 ORDER BY id').bind(userId),
    db.prepare(`SELECT drink_id, id, location, sublocation, position, quantity, date_added, status, date_finished
                FROM stock WHERE user_id = ?1 ORDER BY drink_id, ord`).bind(userId),
    db.prepare('SELECT locations, scale, version FROM settings WHERE user_id = ?1').bind(userId),
  ];
}

export function assembleCellar([drinksRes, stockRes, settingsRes]) {
  const byDrink = new Map();
  for (const s of stockRes.results) {
    if (!byDrink.has(s.drink_id)) byDrink.set(s.drink_id, []);
    byDrink.get(s.drink_id).push({
      id: s.id, location: s.location, sublocation: s.sublocation, position: s.position,
      quantity: s.quantity, dateAdded: s.date_added, status: s.status, dateFinished: s.date_finished,
    });
  }
  const drinks = drinksRes.results.map(r => ({
    ...JSON.parse(r.data), id: r.id, version: r.version, price_cents: r.price_cents, stock: byDrink.get(r.id) || [],
  }));
  const st = settingsRes.results[0];
  const settings = st
    ? { locations: st.locations ? JSON.parse(st.locations) : null, scale: st.scale ? JSON.parse(st.scale) : null, version: st.version }
    : { locations: null, scale: null, version: 0 };
  return { drinks, settings };
}

// ── Settings ────────────────────────────────────────────────────────────────────────
// version 0/null = create; otherwise it must match. Same abort-on-stale guard.
export function settingsWriteStatements(db, userId, { locations, scale }, version, t = nowMs()) {
  const loc = locations === undefined ? null : JSON.stringify(locations);
  const sc = scale === undefined ? null : JSON.stringify(scale);
  if (!version) {
    return [
      db.prepare(`INSERT INTO ${GUARD_TABLE}(ok) SELECT 0 WHERE EXISTS (SELECT 1 FROM settings WHERE user_id = ?1)`).bind(userId),
      db.prepare('INSERT INTO settings (user_id, locations, scale, version, updated_at) VALUES (?1, ?2, ?3, 1, ?4)').bind(userId, loc, sc, t),
    ];
  }
  return [
    db.prepare(`INSERT INTO ${GUARD_TABLE}(ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM settings WHERE user_id = ?1 AND version = ?2)`).bind(userId, version),
    db.prepare(`UPDATE settings SET locations = COALESCE(?2, locations), scale = COALESCE(?3, scale),
                version = version + 1, updated_at = ?4 WHERE user_id = ?1`).bind(userId, loc, sc, t),
  ];
}

// Unconditional replace of the locations, used by the reset operations.
export function settingsForceLocations(db, userId, locations, t = nowMs()) {
  return db.prepare(`INSERT INTO settings (user_id, locations, scale, version, updated_at) VALUES (?1, ?2, NULL, 1, ?3)
      ON CONFLICT(user_id) DO UPDATE SET locations = excluded.locations, version = settings.version + 1, updated_at = excluded.updated_at`)
    .bind(userId, JSON.stringify(locations), t);
}

// ── Bulk operations on stock (what the Cellar Management page does) ─────────────────
const bumpAffected = (db, userId, t) => db.prepare(
  `UPDATE drinks SET version = version + 1, updated_at = ?2 WHERE user_id = ?1
   AND id IN (SELECT drink_id FROM stock WHERE user_id = ?1 AND status = 'in_stock')`).bind(userId, t);

export const opStatements = {
  unassign: (db, userId, t) => [
    bumpAffected(db, userId, t),
    db.prepare(`UPDATE stock SET location = 'unassigned', sublocation = '', position = NULL
                WHERE user_id = ?1 AND status = 'in_stock'`).bind(userId),
  ],
  clearstock: (db, userId, t) => [
    bumpAffected(db, userId, t),
    db.prepare(`DELETE FROM stock WHERE user_id = ?1 AND status = 'in_stock'`).bind(userId),
  ],
  deleteDrinks: (db, userId) => [
    db.prepare('DELETE FROM stock WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM drinks WHERE user_id = ?1').bind(userId),
  ],
};

// ── Account deletion: this app only ─────────────────────────────────────────────────
export function deleteAccountStatements(db, userId) {
  return [
    db.prepare('DELETE FROM stock WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM drinks WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM settings WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM lookup_usage WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM identities WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?1').bind(userId),
  ];
}
