import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, setupProviders, call, inviteAndLogin } from './helpers.js';
import { sanitise, answerOf } from '../src/lookup.js';

// The AI is a fake: no network, no Cloudflare. `ai.calls` records what the Worker asked it.
function fakeAi(reply) {
  const ai = { calls: [], run: async (model, input) => { ai.calls.push({ model, input }); if (reply instanceof Error) throw reply; return typeof reply === 'function' ? reply(input) : reply; } };
  return ai;
}
const MARGAUX = { response: JSON.stringify({ wineColor: 'red', grape: 'Cabernet Sauvignon blend', region: 'Bordeaux, France', appellation: 'Margaux AOC' }) };

let ctx, ai, U, V;
before(async () => {
  await setupProviders();
  ai = fakeAi(MARGAUX);
  ctx = await makeEnv({ AI: ai, LOOKUP_DAILY_LIMIT: '3' });
  U = await inviteAndLogin(ctx, 'u@example.test');
  V = await inviteAndLogin(ctx, 'v@example.test');
});
after(() => ctx.close());
const look = (u, body) => call(ctx.env, 'POST', '/lookup', { token: u.token, body });
const used = async id => (await ctx.raw.prepare('SELECT n FROM lookup_usage WHERE user_id = ?1').bind(id).first())?.n ?? 0;

test('wine lookup returns only the four fact fields', async () => {
  ai.calls.length = 0;
  const r = await look(U, { type: 'wine', name: 'Chateau Margaux', producer: 'Chateau Margaux' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { suggestions: { wineColor: 'red', grape: 'Cabernet Sauvignon blend', region: 'Bordeaux, France', appellation: 'Margaux AOC' } });
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, '@cf/google/gemma-4-26b-a4b-it');   // the default when LOOKUP_MODEL is not set
  assert.ok(ai.calls[0].input.messages.some(m => m.content.includes('Chateau Margaux')));
  assert.equal(await used(U.id), 1);
});

test('the model output is never trusted: only allowed fields, allowed values, cleaned and shortened', () => {
  const wine = sanitise('wine', JSON.stringify({
    wineColor: 'Purple', grape: '<script>alert(1)</script>Merlot', region: 'x'.repeat(500), appellation: 12,
    price: '$900', expertRating: 99, tastingNotes: { nose: 'made up' }, review: 'great',
  }));
  assert.deepEqual(Object.keys(wine).sort(), ['grape', 'region']);
  assert.ok(!/[<>]/.test(wine.grape) && wine.region.length === 80);
  assert.deepEqual(sanitise('wine', 'Sure! Here you go: {"wineColor":"ROSÉ"} Hope that helps'), { wineColor: 'rosé' });
  assert.deepEqual(sanitise('whisky', { whiskyStyle: 'Scotch', whiskyRegion: 'Islay, Scotland', grape: 'x', abv: 40 }), { whiskyStyle: 'scotch', whiskyRegion: 'Islay, Scotland' });
  for (const junk of ['not json', '', null, undefined, 5, '[1,2]', '{"a":', ['x']]) assert.deepEqual(sanitise('wine', junk), {});
});

test('bad requests are 400 and never reach the AI or the counter', async () => {
  ai.calls.length = 0;
  const before = await used(V.id);
  for (const body of [{}, { type: 'beer', name: 'Abc' }, { type: 'wine', name: 'A' }, { type: 'wine', name: 'x'.repeat(121) },
    { type: 'wine', name: 'Abc', producer: 'y'.repeat(121) }, { type: 'wine', name: 5 }, null]) {
    const r = await look(V, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(['invalid', 'invalid_json'].includes(r.body.error), JSON.stringify(body)); // core answers invalid_json for a non-object body
  }
  const big = await look(V, { type: 'wine', name: 'a'.repeat(3000) });
  assert.deepEqual([big.status, big.body], [400, { error: 'body_too_large' }]);
  assert.equal(ai.calls.length, 0);
  assert.equal(await used(V.id), before);
});

test('needs sign-in', async () => {
  const r = await call(ctx.env, 'POST', '/lookup', { body: { type: 'wine', name: 'Abc' } });
  assert.equal(r.status, 401);
});

test('daily limit per user: the next one is 429 lookup_limit, writes nothing, others are unaffected', async () => {
  ai.calls.length = 0;
  const base = await used(U.id); // 1 from the first test
  for (let i = base; i < 3; i++) assert.equal((await look(U, { type: 'wine', name: 'Penfolds Grange' })).status, 200);
  const calls = ai.calls.length;
  ctx.inst.log.rowsWritten = 0;
  const r = await look(U, { type: 'wine', name: 'Penfolds Grange' });
  assert.deepEqual([r.status, r.body], [429, { error: 'lookup_limit' }]);
  assert.equal(ai.calls.length, calls, 'the AI is not asked once the limit is reached');
  assert.equal(ctx.inst.log.rowsWritten, 0);
  assert.equal(await used(U.id), 3);
  assert.equal((await look(V, { type: 'wine', name: 'Penfolds Grange' })).status, 200);
});

test('a new UTC day resets the count and removes the old row', async () => {
  const real = Date.now;
  try {
    Date.now = () => real() + 24 * 3600 * 1000;
    assert.equal((await look(U, { type: 'wine', name: 'Penfolds Grange' })).status, 200);
  } finally { Date.now = real; }
  const rows = (await ctx.raw.prepare('SELECT n FROM lookup_usage WHERE user_id = ?1').bind(U.id).all()).results;
  assert.deepEqual(rows.map(r => r.n), [1]);
});

test('the AI failing (or its own daily allowance running out) is 503 lookup_unavailable', async () => {
  const c2 = await makeEnv({ AI: fakeAi(new Error('4006: you have used up your daily free allocation')) });
  try {
    const u = await inviteAndLogin(c2, 'w@example.test');
    const r = await call(c2.env, 'POST', '/lookup', { token: u.token, body: { type: 'whisky', name: 'Lagavulin 16' } });
    assert.deepEqual([r.status, r.body], [503, { error: 'lookup_unavailable' }]);
    assert.ok(!JSON.stringify(r.body).includes('4006'), 'no internal text reaches the page');
  } finally { c2.close(); }
  const c3 = await makeEnv({}); // no AI binding at all
  try {
    const u = await inviteAndLogin(c3, 'x@example.test');
    const r = await call(c3.env, 'POST', '/lookup', { token: u.token, body: { type: 'wine', name: 'Abc' } });
    assert.deepEqual([r.status, r.body], [503, { error: 'lookup_unavailable' }]);
  } finally { c3.close(); }
});

test('cost per lookup: 1 row written; both queries use the primary key', async () => {
  const c = await makeEnv({ AI: fakeAi(MARGAUX) });
  try {
    const u = await inviteAndLogin(c, 'y@example.test');
    c.inst.log.rowsRead = c.inst.log.rowsWritten = 0; c.inst.log.sql.clear();
    assert.equal((await call(c.env, 'POST', '/lookup', { token: u.token, body: { type: 'wine', name: 'Abc' } })).status, 200);
    assert.ok(c.inst.log.rowsWritten <= 1, 'rows written ' + c.inst.log.rowsWritten);
    for (const [sql, binds] of c.inst.log.sql) {
      if (!/lookup_usage/.test(sql) || /^INSERT/.test(sql.trim())) continue;
      const plan = (await c.raw.prepare('EXPLAIN QUERY PLAN ' + sql).bind(...binds).all()).results.map(r => r.detail);
      assert.ok(plan.every(d => /PRIMARY KEY/.test(d)), plan.join(' | '));
    }
  } finally { c.close(); }
});

test('DELETE /me removes the usage rows', async () => {
  const c = await makeEnv({ AI: fakeAi(MARGAUX) });
  try {
    const u = await inviteAndLogin(c, 'z@example.test');
    await call(c.env, 'POST', '/lookup', { token: u.token, body: { type: 'wine', name: 'Abc' } });
    assert.equal((await c.raw.prepare('SELECT count(*) n FROM lookup_usage').first()).n, 1);
    assert.equal((await call(c.env, 'DELETE', '/me', { token: u.token })).status, 200);
    assert.equal((await c.raw.prepare('SELECT count(*) n FROM lookup_usage').first()).n, 0);
  } finally { c.close(); }
});

// ── answer shapes and the model name (added with the audit: the first model was retired by Cloudflare on 2026-11-20) ──
const FACTS = { wineColor: 'red', grape: 'Merlot', region: 'Pomerol, France', appellation: 'Pomerol AOC' };
const WANT = { suggestions: FACTS };

test('answer shape 1: { response: "<json text>" } and { result: ... } and an object response', async () => {
  for (const reply of [{ response: JSON.stringify(FACTS) }, { result: JSON.stringify(FACTS) }, { response: FACTS }]) {
    const c = await makeEnv({ AI: fakeAi(reply), LOOKUP_DAILY_LIMIT: '5' });
    const u = await inviteAndLogin(c, 'shape1@example.test');
    const r = await call(c.env, 'POST', '/lookup', { token: u.token, body: { type: 'wine', name: 'Chateau Petrus' } });
    assert.deepEqual([r.status, r.body], [200, WANT], JSON.stringify(reply));
    await c.close();
  }
});

test('answer shape 2: chat completions { choices: [{ message: { content } }] } (string, list of parts, with reasoning first)', async () => {
  const replies = [
    { choices: [{ message: { role: 'assistant', content: JSON.stringify(FACTS) } }] },
    { choices: [{ message: { content: [{ type: 'text', text: JSON.stringify(FACTS) }] } }] },
    { choices: [{ message: { content: '<think>Pomerol is {in} Bordeaux</think>\n```json\n' + JSON.stringify(FACTS) + '\n```' } }] },
    { choices: [{ text: JSON.stringify(FACTS) }] },
  ];
  for (const reply of replies) {
    const c = await makeEnv({ AI: fakeAi(reply), LOOKUP_DAILY_LIMIT: '5' });
    const u = await inviteAndLogin(c, 'shape2@example.test');
    const r = await call(c.env, 'POST', '/lookup', { token: u.token, body: { type: 'wine', name: 'Chateau Petrus' } });
    assert.deepEqual([r.status, r.body], [200, WANT], JSON.stringify(reply));
    await c.close();
  }
  assert.equal(answerOf(null), undefined);
  assert.equal(answerOf('abc'), 'abc');
});

test('LOOKUP_MODEL from the settings is the model that is asked (swap without a code change)', async () => {
  const swap = fakeAi({ choices: [{ message: { content: JSON.stringify(FACTS) } }] });
  const c = await makeEnv({ AI: swap, LOOKUP_MODEL: '@cf/qwen/qwen3.8-27b', LOOKUP_DAILY_LIMIT: '5' });
  const u = await inviteAndLogin(c, 'swap@example.test');
  const r = await call(c.env, 'POST', '/lookup', { token: u.token, body: { type: 'wine', name: 'Chateau Petrus' } });
  assert.equal(r.status, 200);
  assert.equal(swap.calls[0].model, '@cf/qwen/qwen3.8-27b');
  await c.close();
});

test('a retired model (HTTP 410 from Workers AI) is a plain 503 lookup_unavailable, nothing else leaks', async () => {
  const c = await makeEnv({ AI: fakeAi(new Error('5028: model deprecated')), LOOKUP_DAILY_LIMIT: '5' });
  const u = await inviteAndLogin(c, 'gone@example.test');
  const r = await call(c.env, 'POST', '/lookup', { token: u.token, body: { type: 'wine', name: 'Chateau Petrus' } });
  assert.deepEqual([r.status, r.body], [503, { error: 'lookup_unavailable' }]);
  await c.close();
});

// ── thinking models, time limit, tolerant wine reader, empty-result log (added after live tests with Qwen and Gemma) ──
const WINE_FACTS = { wineColor: 'red', grape: 'Cabernet Sauvignon, Merlot', region: 'Bordeaux, France', appellation: 'Margaux AOC' };
const askWine = async (reply, extra = {}) => {
  const a = fakeAi(reply);
  const c = await makeEnv({ AI: a, LOOKUP_DAILY_LIMIT: '5', ...extra });
  try {
    const u = await inviteAndLogin(c, 'think@example.test');
    const t0 = Date.now();
    const r = await call(c.env, 'POST', '/lookup', { token: u.token, body: { type: 'wine', name: 'Chateau Margaux', producer: 'Chateau Margaux' } });
    return { r, a, ms: Date.now() - t0 };
  } finally { await c.close(); }
};
const captureLog = async fn => {
  const lines = [], orig = console.log; console.log = (...x) => lines.push(x.join(' '));
  try { await fn(); } finally { console.log = orig; }
  return lines;
};

test('thinking is switched off and the token ceiling is small but leaves room for the JSON', async () => {
  const { a } = await askWine({ choices: [{ message: { content: JSON.stringify(WINE_FACTS) } }] });
  const i = a.calls[0].input;
  assert.deepEqual(i.chat_template_kwargs, { enable_thinking: false });
  assert.ok(i.max_completion_tokens >= 400 && i.max_completion_tokens <= 600, 'room for the JSON, not a huge ceiling');
  assert.equal(i.max_tokens, undefined);
  assert.equal(i.reasoning_effort, undefined, 'only sent to Qwen (the default is Gemma)');
});

test('Qwen also gets the lowest reasoning effort; Gemma does not', async () => {
  const q = await askWine({ response: '{}' }, { LOOKUP_MODEL: '@cf/qwen/qwen3.8-27b' });
  assert.equal(q.a.calls[0].input.reasoning_effort, 'low');
  assert.equal(q.a.calls[0].model, '@cf/qwen/qwen3.8-27b');
  const g = await askWine({ response: '{}' }, { LOOKUP_MODEL: '@cf/google/gemma-4-26b-a4b-it' });
  assert.equal(g.a.calls[0].input.reasoning_effort, undefined);
});

test('if the model refuses the extra settings it is asked once more with the plain request', async () => {
  let n = 0;
  const a = fakeAi(input => { n++; if (input.chat_template_kwargs) throw new Error('AiError: unknown field chat_template_kwargs'); return { response: JSON.stringify(WINE_FACTS) }; });
  const c = await makeEnv({ AI: a, LOOKUP_DAILY_LIMIT: '5' });
  try {
    const u = await inviteAndLogin(c, 'retry@example.test');
    const r = await call(c.env, 'POST', '/lookup', { token: u.token, body: { type: 'wine', name: 'Chateau Margaux' } });
    assert.deepEqual([r.status, r.body.suggestions], [200, WINE_FACTS]);
    assert.equal(n, 2);
    assert.equal(a.calls[1].input.chat_template_kwargs, undefined);
    assert.equal(a.calls[1].input.max_completion_tokens, 500);
  } finally { await c.close(); }
});

test('a model that never answers ends in 503 lookup_unavailable at the time limit, not after minutes', async () => {
  const { r, ms } = await askWine(() => new Promise(() => {}), { LOOKUP_TIMEOUT_MS: '150' });
  assert.deepEqual([r.status, r.body], [503, { error: 'lookup_unavailable' }]);
  assert.ok(ms >= 140 && ms < 2000, `took ${ms} ms`);
});

test('the time limit covers the retry too (one shared deadline)', async () => {
  const { r, ms } = await askWine(input => (input.chat_template_kwargs ? Promise.reject(new Error('refused')) : new Promise(() => {})), { LOOKUP_TIMEOUT_MS: '200' });
  assert.deepEqual([r.status, r.body], [503, { error: 'lookup_unavailable' }]);
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test('the default time limit is about 20 seconds', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/lookup.js', import.meta.url), 'utf8');
  assert.match(src, /DEFAULT_TIMEOUT_MS = 20000/);
});

test('wine reader: lists of strings are joined', () => {
  assert.deepEqual(sanitise('wine', JSON.stringify({ wineColor: 'red', grape: ['Cabernet Sauvignon', 'Merlot'], region: ['Bordeaux', 'France'] })),
    { wineColor: 'red', grape: 'Cabernet Sauvignon, Merlot', region: 'Bordeaux, France' });
  assert.deepEqual(sanitise('wine', JSON.stringify({ grape: ['ok', 5, { a: 1 }] })), {}, 'a mixed list is not trusted');
});

test('wine reader: clear synonyms (color, colour, variety, grapes, any case or separator) give the same four fields', () => {
  const want = { wineColor: 'red', grape: 'Syrah', region: 'Barossa Valley, Australia', appellation: 'Barossa Valley GI' };
  for (const o of [
    { color: 'Red', variety: 'Syrah', region: 'Barossa Valley, Australia', appellation: 'Barossa Valley GI' },
    { colour: 'red', grapes: ['Syrah'], Region: 'Barossa Valley, Australia', Appellation: 'Barossa Valley GI' },
    { 'Wine Color': 'RED', grape_variety: 'Syrah', REGION: 'Barossa Valley, Australia', appellation: 'Barossa Valley GI' },
    { wine_color: ['red'], grape: 'Syrah', region: 'Barossa Valley, Australia', appellation: 'Barossa Valley GI' },
  ]) assert.deepEqual(sanitise('wine', JSON.stringify(o)), want, JSON.stringify(o));
  assert.deepEqual(sanitise('wine', JSON.stringify({ wineColor: 'red', color: 'white' })), { wineColor: 'red' }, 'the exact name wins');
});

test('wine reader: still only the allowed fields and values (synonyms do not open the door)', () => {
  const r = sanitise('wine', JSON.stringify({ color: 'Purple', variety: '<b>Merlot</b>', type: 'red', price: '$900', rating: 99, notes: 'x', grapes: [1, 2], region: 'x'.repeat(500) }));
  assert.deepEqual(Object.keys(r).sort(), ['grape', 'region']);
  assert.equal(r.region.length, 80);
  assert.ok(!/[<>]/.test(r.grape));
  assert.deepEqual(sanitise('whisky', JSON.stringify({ style: 'scotch', region: 'Islay', color: 'red' })), {}, 'whisky reading is unchanged');
});

test('empty result: one log line with the shape (keys and types), never the answer text or the drink', async () => {
  const secret = 'ZZSECRETANSWERZZ';
  const reply = { choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'Let me think about ' + secret } }], usage: { completion_tokens: 300 } };
  let res;
  const lines = await captureLog(async () => { res = await askWine(reply); });
  assert.deepEqual(res.r.body, { suggestions: {} });
  const mine = lines.filter(l => l.includes('"lookup":"empty"'));
  assert.equal(mine.length, 1);
  const o = JSON.parse(mine[0]);
  assert.equal(o.type, 'wine');
  assert.deepEqual(o.reply, ['choices', 'usage']);
  assert.equal(o.finish, 'length');
  assert.equal(o.tokens, 300);
  assert.equal(o.parsed, null);
  assert.ok(!mine[0].includes(secret) && !/margaux/i.test(mine[0]), 'no answer text, no drink text');
});

test('empty result with a parsed answer: keys and value types only', async () => {
  const secret = 'ZZSECRETVALUEZZ';
  let res;
  const lines = await captureLog(async () => { res = await askWine({ response: JSON.stringify({ taste: secret, score: 97, tags: ['a', 'b'], nothing: null, nested: { x: secret } }) }); });
  assert.deepEqual(res.r.body, { suggestions: {} });
  const o = JSON.parse(lines.find(l => l.includes('"lookup":"empty"')));
  assert.deepEqual(o.parsed, { taste: 'string(15)', score: 'number', tags: 'array(2)', nothing: 'null', nested: 'object' });
  assert.ok(!JSON.stringify(o).includes(secret));
});

test('a result with something in it logs nothing', async () => {
  const lines = await captureLog(async () => { await askWine({ response: JSON.stringify(WINE_FACTS) }); });
  assert.ok(!lines.some(l => l.includes('"lookup":"empty"')));
});
