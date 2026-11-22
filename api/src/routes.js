import { login, logout } from '../core/index.js';
import { lookup } from './lookup.js';
import { bad, conflict, json, readJson, nowMs } from './util.js';
import {
  normaliseItems, normaliseLocations, normaliseScale, normaliseName, isId,
} from './validate.js';
import {
  runBatch, drinkWriteStatements, stockCounts, nextVersions, deleteDrinkStatements, loadCellarStatements, assembleCellar,
  settingsWriteStatements, settingsForceLocations, opStatements, deleteAccountStatements,
} from './store.js';

// ── Account ─────────────────────────────────────────────────────────────────────────
// Sign-in (/auth/*) and /me/logout are the core's handlers; they are wired up in the route table below.
// The core's session has no profile version, so /me reads it (one row) for the page's stale-edit check.
const profile = async (env, session) => {
  const r = await env.DB.prepare('SELECT version FROM users WHERE id = ?1').bind(session.userId).first();
  return { id: session.userId, email: session.email, name: session.name, version: r ? r.version : 1 };
};
const getMe = async ({ env, session }) => json({ user: await profile(env, session) });

async function patchMe({ req, env, session }) {
  const body = await readJson(req, 2000);
  const name = normaliseName(body.name);
  const version = body.version == null ? null : Number(body.version);
  if (version !== null && !Number.isInteger(version)) throw bad('invalid', 'version');
  const r = await env.DB.prepare(
    'UPDATE users SET name = ?1, version = version + 1 WHERE id = ?2 AND (?3 IS NULL OR version = ?3)'
  ).bind(name, session.userId, version).run();
  if (!r.meta.changes) throw conflict('conflict');
  return json({ user: await profile(env, { ...session, name }) });
}

async function deleteMe({ env, session }) {
  await env.DB.batch(deleteAccountStatements(env.DB, session.userId));
  return json({ deleted: true });
}

// ── Cellar ──────────────────────────────────────────────────────────────────────────
async function getCellar({ env, session }) {
  const res = await env.DB.batch(loadCellarStatements(env.DB, session.userId));
  return json(assembleCellar(res));
}

async function putDrink({ req, env, session, params }) {
  if (!isId(params.id)) throw bad('invalid', 'id');
  const body = await readJson(req, 90_000);
  if (!body.drink || body.drink.id !== params.id) throw bad('invalid', 'drink.id must match the URL');
  const items = normaliseItems([{ drink: body.drink, version: body.version }]);
  const counts = await stockCounts(env.DB, session.userId, items);
  await runBatch(env.DB, drinkWriteStatements(env.DB, session.userId, items, nowMs(), counts));
  return json({ version: nextVersions(items)[0].version });
}

async function deleteDrink({ env, session, params, url }) {
  if (!isId(params.id)) throw bad('invalid', 'id');
  const raw = url.searchParams.get('version');
  const version = raw == null ? null : Number(raw);
  if (version !== null && !Number.isInteger(version)) throw bad('invalid', 'version');
  await runBatch(env.DB, deleteDrinkStatements(env.DB, session.userId, params.id, version));
  return json({ deleted: true });
}

async function bulkDrinks({ req, env, session }) {
  const body = await readJson(req, 100_000);
  const items = normaliseItems(body.items);
  const counts = await stockCounts(env.DB, session.userId, items);
  await runBatch(env.DB, drinkWriteStatements(env.DB, session.userId, items, nowMs(), counts));
  return json({ versions: nextVersions(items) });
}

async function putSettings({ req, env, session }) {
  const body = await readJson(req, 60_000);
  const patch = {};
  if (body.locations !== undefined) patch.locations = normaliseLocations(body.locations);
  if (body.scale !== undefined) patch.scale = normaliseScale(body.scale);
  if (!Object.keys(patch).length) throw bad('invalid', 'nothing to save');
  const version = body.version == null ? 0 : Number(body.version);
  if (!Number.isInteger(version) || version < 0) throw bad('invalid', 'version');
  await runBatch(env.DB, settingsWriteStatements(env.DB, session.userId, patch, version));
  return json({ version: version + 1 });
}

// ── Cellar Management operations ────────────────────────────────────────────────────
const optionalLocations = body => (body.locations === undefined ? undefined : normaliseLocations(body.locations));

function opRoute(build) {
  return async ({ req, env, session }) => {
    const body = await readJson(req, 100_000);
    const t = nowMs();
    const stmts = await build({ env, userId: session.userId, body, t });
    await runBatch(env.DB, stmts);
    return json({ ok: true });
  };
}

const opUnassign = opRoute(({ env, userId, t }) => opStatements.unassign(env.DB, userId, t));

const opClearStock = opRoute(({ env, userId, body, t }) => {
  const locs = optionalLocations(body);
  const s = opStatements.clearstock(env.DB, userId, t);
  if (locs) s.push(settingsForceLocations(env.DB, userId, locs, t));
  return s;
});

const opDeleteDrinks = opRoute(({ env, userId, body, t }) => {
  const locs = optionalLocations(body);
  const s = opStatements.deleteDrinks(env.DB, userId);
  if (locs) s.push(settingsForceLocations(env.DB, userId, locs, t));
  return s;
});

// Wipes drinks and stock, sets the locations, loads the given drinks: one atomic batch.
const opReplaceAll = opRoute(({ env, userId, body, t }) => {
  const locs = normaliseLocations(body.locations);
  if (!Array.isArray(body.drinks)) throw bad('invalid', 'drinks must be a list');
  const items = normaliseItems(body.drinks.map(drink => ({ drink }))).map(i => ({ ...i, v: null }));
  return [
    ...opStatements.deleteDrinks(env.DB, userId),
    settingsForceLocations(env.DB, userId, locs, t),
    ...drinkWriteStatements(env.DB, userId, items, t),
  ];
});

// ── The route table ─────────────────────────────────────────────────────────────────
// A route's `guard` is a name: `public` (no token) is allowed only for /auth/* (a test enforces it); every other route
// uses `user`, the core's sign-in check. createApp refuses to start if a route names a guard that does not exist.
export const routes = [
  { method: 'POST', path: '/auth/google', guard: 'public', handler: c => login('google', c) },
  { method: 'POST', path: '/auth/microsoft', guard: 'public', handler: c => login('microsoft', c) },

  { method: 'GET', path: '/me', guard: 'user', handler: getMe },
  { method: 'PATCH', path: '/me', guard: 'user', handler: patchMe },
  { method: 'DELETE', path: '/me', guard: 'user', handler: deleteMe },
  { method: 'POST', path: '/me/logout', guard: 'user', handler: logout },

  { method: 'GET', path: '/cellar', guard: 'user', handler: getCellar },
  { method: 'POST', path: '/drinks/bulk', guard: 'user', handler: bulkDrinks },
  { method: 'PUT', path: '/drinks/:id', guard: 'user', handler: putDrink },
  { method: 'DELETE', path: '/drinks/:id', guard: 'user', handler: deleteDrink },
  { method: 'PUT', path: '/settings', guard: 'user', handler: putSettings },

  { method: 'POST', path: '/lookup', guard: 'user', handler: lookup },

  { method: 'POST', path: '/ops/unassign', guard: 'user', handler: opUnassign },
  { method: 'POST', path: '/ops/clearstock', guard: 'user', handler: opClearStock },
  { method: 'POST', path: '/ops/delete-drinks', guard: 'user', handler: opDeleteDrinks },
  { method: 'POST', path: '/ops/replace-all', guard: 'user', handler: opReplaceAll },
];
