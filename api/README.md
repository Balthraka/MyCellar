# My Cellar API

A small Cloudflare Worker and D1 database behind a single-page wine and whisky tracker (`web/index.html`). Each signed-in person has their own cellar: drinks, bottles in storage locations, tasting notes, ratings. Sign-in is Google (Microsoft is built and hidden until switched on); there are no passwords and no email is sent.

## What is here
- `src/` the Worker routes (cellar, drinks, settings, bulk operations, account, "Look up details"). Money is stored as whole cents. A save writes only the rows that changed, and a stale edit is refused (version number).
- `core/` the shared sign-in, session and routing layer (also used by other apps; do not edit it here, `scripts/check-core.mjs` compares copies).
- `schema.sql` the D1 tables.
- `web/index.html` the page (React and Babel in the browser, pinned to exact versions with integrity hashes).
- `scripts/` an invite script, a local importer, a local-Worker runner and a smoke test.
- `tests/` the tests (made-up data only) and `test-web/` a browser check.
- `docs/PRIVACY-HOSTS.md` lists every outside host the page contacts.

## Private by default
`ALLOW_SIGNUPS = "false"` in `wrangler.toml`: only people you invite can sign in (`scripts/invite.mjs`).

## Setup
1. `npm install`
2. `npx wrangler d1 create mycellar`, then put the id it prints in `wrangler.toml` (the file holds a placeholder).
3. `npx wrangler d1 execute mycellar --remote --file=schema.sql`
4. Create your own Google Cloud OAuth Web client. Put its client id in `wrangler.toml` (`GOOGLE_CLIENT_ID`) and in `web/index.html`, and your own page address in `ALLOWED_ORIGINS` and your Worker address in `API_BASE` (`web/index.html`).
5. `npx wrangler deploy`
6. Invite people: `node scripts/invite.mjs --email someone@example.com --out import/invite.sql`, then `npx wrangler d1 execute mycellar --remote --file=import/invite.sql`.

"Look up details" uses Cloudflare Workers AI (the `[ai]` binding in `wrangler.toml`): no API key, free daily allowance, a per-person daily limit.

## Checks
`npm test` (Worker and page tests), `npm run smoke` (the real Worker runtime, local only).
