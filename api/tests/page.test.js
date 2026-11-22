import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Every error code the Worker (core + app) can send must have a sentence in the page's ERROR_TEXT, because the error
// body is only { error: code } (no message).
test('the page has a sentence for every error code the Worker can send', () => {
  const codes = new Set();
  for (const dir of ['core', 'src']) {
    for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url)).filter(f => f.endsWith('.js'))) {
      const src = readFileSync(new URL(`../${dir}/${f}`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/HttpError\(\d+,\s*'([a-z_]+)'/g)) codes.add(m[1]);
      for (const m of src.matchAll(/\b(?:bad|forbidden|conflict)\('([a-z_]+)'/g)) codes.add(m[1]);
      for (const m of src.matchAll(/error: '([a-z_]+)'/g)) codes.add(m[1]);
    }
  }
  codes.delete('name'); codes.delete('items'); // validate.js's own bad(field, message) helper: the code is 'invalid'
  const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const block = page.slice(page.indexOf('const ERROR_TEXT = {'), page.indexOf('class ApiError'));
  const missing = [...codes].filter(c => !new RegExp(`\\b${c}:`).test(block));
  assert.deepEqual(missing, []);
  assert.ok(codes.has('body_too_large') && codes.has('email_not_verified'));
});

test('the page does not read expires_at, send an id_token request field or wait for a 413', () => {
  const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.ok(!/expires_at|\{\s*id_token\s*[:,}]|=== 413/.test(page)); // (Microsoft's own id_token URL fragment is fine)
});

// Pinning: the session token lives in localStorage, so a changed CDN file could steal it. Every outside script must be an exact
// version with a sha384 integrity hash and crossorigin. The only exceptions are Google's sign-in script (Google serves it itself,
// it cannot be pinned) and the Google Fonts stylesheet (a stylesheet, not code). docs/PRIVACY-HOSTS.md lists every host.
test('every outside script is pinned to an exact version with an integrity hash', () => {
  const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const tags = [...page.matchAll(/<(script|link)\b[^>]*>/gi)].map(m => m[0]);
  const unpinnedOk = [/^https:\/\/accounts\.google\.com\/gsi\/client$/, /^https:\/\/fonts\.googleapis\.com\//];
  let pinned = 0;
  for (const tag of tags) {
    const url = (/\b(?:src|href)="([^"]+)"/.exec(tag) || [])[1];
    if (!url || !/^https?:\/\//.test(url) || /rel="preconnect"/.test(tag)) continue;
    if (unpinnedOk.some(re => re.test(url))) continue;
    assert.ok(/^https:\/\/cdn\.jsdelivr\.net\/npm\/(@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+\//.test(url), `not an exact version on jsDelivr: ${url}`);
    assert.ok(/\bintegrity="sha384-[A-Za-z0-9+/]{64}"/.test(tag), `no sha384 integrity hash: ${url}`);
    assert.ok(/\bcrossorigin="anonymous"/.test(tag), `no crossorigin: ${url}`);
    pinned++;
  }
  assert.equal(pinned, 3, 'React, ReactDOM and Babel');
  assert.ok(!/unpkg\.com|@18\/|@7\/|@latest/.test(page), 'no unpinned CDN address anywhere');
  // the hosts document must name every host the page contacts
  const hosts = new Set([...page.matchAll(/https:\/\/([a-z0-9.-]+)\//gi)].map(m => m[1]).filter(h => !/^(www\.w3\.org|localhost)/.test(h)));
  const doc = readFileSync(new URL('../docs/PRIVACY-HOSTS.md', import.meta.url), 'utf8');
  for (const h of hosts) assert.ok(doc.includes(h), `docs/PRIVACY-HOSTS.md does not mention ${h}`);
});
