import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv } from './helpers.js';
import { handle } from '../src/index.js';
import { ORIGIN } from './helpers.js';

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const val = k => new RegExp('^' + k + '\\s*=\\s*"([^"]*)"', 'm').exec(toml)?.[1];

test('wrangler.toml: 7-day sessions, a current lookup model, logs on, no localhost, no wildcard', () => {
  assert.equal(val('SESSION_DAYS'), '7');
  assert.equal(val('LOOKUP_MODEL'), '@cf/google/gemma-4-26b-a4b-it');
  assert.ok(!/llama-3\.1-8b-instruct-fp8"/.test(val('LOOKUP_MODEL')), 'retired on 2026-11-20');
  assert.match(toml, /\[observability\]\s*\nenabled = true/);
  assert.ok(!/localhost|127\.0\.0\.1/.test(val('ALLOWED_ORIGINS')), 'ALLOWED_ORIGINS must not list localhost');
  assert.ok(!val('ALLOWED_ORIGINS').includes('*'));
  assert.equal(val('ALLOW_SIGNUPS'), 'false');
});

test('every reply (success, error, preflight, forbidden origin) carries nosniff and Referrer-Policy', async () => {
  const c = await makeEnv({});
  try {
    const cases = [
      new Request('https://w.test/me'),                                                        // 401
      new Request('https://w.test/nope', { headers: { origin: ORIGIN } }),                     // 404
      new Request('https://w.test/me', { method: 'OPTIONS', headers: { origin: ORIGIN } }),    // preflight
      new Request('https://w.test/me', { headers: { origin: 'https://evil.example' } }),       // 403
    ];
    for (const req of cases) {
      const res = await handle(req, c.env);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', req.url + ' ' + res.status);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('cache-control') ?? 'no-store', 'no-store');
    }
  } finally { await c.close(); }
});
