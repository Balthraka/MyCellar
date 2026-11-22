import { HttpError } from './util.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isId = v => typeof v === 'string' && ID_RE.test(v);

const bad = (field, msg) => new HttpError(400, 'invalid', `${field}: ${msg}`);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function str(v, field, max, { allowEmpty = true } = {}) {
  if (typeof v !== 'string') throw bad(field, 'must be a string');
  if (v.length > max) throw bad(field, `longer than ${max}`);
  if (!allowEmpty && !v.trim()) throw bad(field, 'required');
  return v;
}
function intIn(v, field, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw bad(field, `must be a whole number ${min}..${max}`);
  return v;
}
const nullableStr = (v, f, max) => (v == null ? null : str(v, f, max));

export const MAX_DRINKS_PER_REQUEST = 50;
const MAX_STOCK_PER_DRINK = 200;
const MAX_DATA_CHARS = 20_000;
// Keys that belong to the API envelope, never to the stored `data` blob.
const ENVELOPE = new Set(['id', 'stock', 'price', 'price_cents', 'version', '_v']);

export function normaliseStock(list, field = 'stock') {
  if (!Array.isArray(list)) throw bad(field, 'must be a list');
  if (list.length > MAX_STOCK_PER_DRINK) throw bad(field, `more than ${MAX_STOCK_PER_DRINK} entries`);
  return list.map((s, i) => {
    const f = `${field}[${i}]`;
    if (!isObj(s)) throw bad(f, 'must be an object');
    if (!isId(s.id)) throw bad(`${f}.id`, 'invalid id');
    if (s.status !== 'in_stock' && s.status !== 'finished') throw bad(`${f}.status`, 'must be in_stock or finished');
    return {
      id: s.id,
      location: str(s.location, `${f}.location`, 100, { allowEmpty: false }),
      sublocation: s.sublocation == null ? '' : str(s.sublocation, `${f}.sublocation`, 100),
      position: s.position == null ? null : intIn(s.position, `${f}.position`, 1, 10000),
      quantity: intIn(s.quantity, `${f}.quantity`, 1, 100000),
      date_added: nullableStr(s.dateAdded, `${f}.dateAdded`, 40),
      status: s.status,
      date_finished: nullableStr(s.dateFinished, `${f}.dateFinished`, 40),
      ord: i,
    };
  });
}

// Turns one browser drink into { id, price_cents, data (JSON text), stock[] }.
// Money arrives as integer cents (price_cents). It is never a float.
export function normaliseDrink(d, field = 'drink') {
  if (!isObj(d)) throw bad(field, 'must be an object');
  if (!isId(d.id)) throw bad(`${field}.id`, 'invalid id');
  if (d.type !== 'wine' && d.type !== 'whisky') throw bad(`${field}.type`, 'must be wine or whisky');
  str(d.name, `${field}.name`, 300, { allowEmpty: false });
  const price_cents = d.price_cents == null ? null : intIn(d.price_cents, `${field}.price_cents`, 0, 100_000_000);
  const stock = normaliseStock(d.stock ?? [], `${field}.stock`);
  const ids = new Set();
  for (const s of stock) {
    if (ids.has(s.id)) throw bad(`${field}.stock`, 'duplicate stock id');
    ids.add(s.id);
  }
  const rest = {};
  for (const [k, v] of Object.entries(d)) if (!ENVELOPE.has(k)) rest[k] = v;
  const data = JSON.stringify(rest);
  if (data.length > MAX_DATA_CHARS) throw bad(field, 'too large');
  return { id: d.id, price_cents, data, stock };
}

// items: [{ drink, version }] where version is null/absent for a new drink.
export function normaliseItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw bad('items', 'must be a non-empty list');
  if (items.length > MAX_DRINKS_PER_REQUEST) throw bad('items', `more than ${MAX_DRINKS_PER_REQUEST}`);
  const seen = new Set();
  return items.map((it, i) => {
    if (!isObj(it)) throw bad(`items[${i}]`, 'must be an object');
    const n = normaliseDrink(it.drink, `items[${i}].drink`);
    if (seen.has(n.id)) throw bad(`items[${i}]`, 'duplicate drink id');
    seen.add(n.id);
    const v = it.version == null ? null : intIn(it.version, `items[${i}].version`, 1, 2_000_000_000);
    return { ...n, v };
  });
}

export function normaliseLocations(list, field = 'locations') {
  if (!Array.isArray(list)) throw bad(field, 'must be a list');
  if (list.length > 100) throw bad(field, 'more than 100');
  const ids = new Set();
  return list.map((l, i) => {
    const f = `${field}[${i}]`;
    if (!isObj(l)) throw bad(f, 'must be an object');
    if (!isId(l.id)) throw bad(`${f}.id`, 'invalid id');
    if (ids.has(l.id)) throw bad(f, 'duplicate id');
    ids.add(l.id);
    if (!Array.isArray(l.slots) || l.slots.length > 200) throw bad(`${f}.slots`, 'must be a list of at most 200');
    const out = {
      id: l.id,
      name: str(l.name, `${f}.name`, 100, { allowEmpty: false }),
      slots: l.slots.map((s, j) => str(s, `${f}.slots[${j}]`, 100)),
      positionsPerRow: l.positionsPerRow == null ? null : intIn(l.positionsPerRow, `${f}.positionsPerRow`, 1, 1000),
    };
    if (l.system === true) out.system = true;
    return out;
  });
}

export function normaliseScale(list, field = 'scale') {
  if (!Array.isArray(list) || list.length > 20) throw bad(field, 'must be a list of at most 20');
  return list.map((c, i) => {
    if (!Array.isArray(c) || c.length !== 2) throw bad(`${field}[${i}]`, 'must be [points, label]');
    return [intIn(c[0], `${field}[${i}][0]`, 0, 100), str(c[1], `${field}[${i}][1]`, 50)];
  });
}

export function normaliseName(v) {
  const name = str(v, 'name', 80, { allowEmpty: false }).trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw bad('name', 'invalid characters');
  return name;
}
