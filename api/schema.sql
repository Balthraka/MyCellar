-- MyCellar D1 schema.
-- Part 1 is core/schema.sql, copied exactly (users, identities, sessions): do not edit it here. If the core needs a
-- change, the SplitTrip chat makes it and every app copies it again.
-- Part 2 is this app's own tables. Every table that holds user data is keyed by user_id first, so every filter is an
-- index search, never a table scan.

-- ===== Part 1: core/schema.sql =====
-- Tables the core reads and writes. Copy these into the app's first migration; the app adds its own tables after them.
-- Timestamps are ISO-8601 UTC text with 6 fractional digits (the core writes them with nowIso()).
-- The display-name column of `users` can be called anything (createApp's `naming.column`); it is `name` here.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,          -- stored lowercase
  name        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE identities (
  provider    TEXT NOT NULL,                 -- 'google' | 'microsoft'
  subject     TEXT NOT NULL,                 -- the provider's stable `sub`
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_identities_user ON identities(user_id);

CREATE TABLE sessions (
  token_hash     TEXT PRIMARY KEY,           -- SHA-256 hex of the bearer token; the token itself is never stored
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_email INTEGER NOT NULL DEFAULT 0, -- 1 only when the provider reported the email as verified (Google)
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ===== Part 2: MyCellar's own tables =====

-- The profile version (stale-edit check for PATCH /me). Added after the core's `users` table, which the core never
-- reads this column from: it only touches id, email, name and created_at, and the default covers its INSERTs.
ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- One row per wine / whisky. Descriptive fields live in `data` (JSON); money is
-- integer cents in its own column. Ids are chosen by the browser (the demo data uses
-- 'w01' etc.), so the key is (user_id, id): two users can hold the same id.
CREATE TABLE drinks (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  data        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;  -- the row lives in the key index: one read per row, not two

-- Bottles of a drink: where they are and whether they are still in the cellar.
-- The key is (user_id, drink_id, ord): a drink's bottles are stored together and already
-- in list order, so loading needs no sort, and deleting or replacing one drink's bottles
-- (and the foreign-key check) is a prefix lookup instead of a scan of the user's stock.
CREATE TABLE stock (
  user_id       TEXT NOT NULL,
  drink_id      TEXT NOT NULL,
  ord           INTEGER NOT NULL,            -- position in the drink's stock list
  id            TEXT NOT NULL,               -- browser-generated, unique within a drink
  location      TEXT NOT NULL,
  sublocation   TEXT NOT NULL DEFAULT '',
  position      INTEGER,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  date_added    TEXT,
  status        TEXT NOT NULL CHECK (status IN ('in_stock', 'finished')),
  date_finished TEXT,
  PRIMARY KEY (user_id, drink_id, ord),
  FOREIGN KEY (user_id, drink_id) REFERENCES drinks(user_id, id) ON DELETE CASCADE
) WITHOUT ROWID;
-- No index on status: the bulk operations filter a user's own bottle rows (a few hundred at most),
-- and an extra index would cost a write on every bottle change.

-- Storage locations and the personal rating scale (one row per user).
CREATE TABLE settings (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  locations  TEXT,
  scale      TEXT,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- How many "Look up details" requests a user has made today (UTC day). One row per user per day;
-- the Worker removes older rows for that user each time it counts.
CREATE TABLE lookup_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,
  n       INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
) WITHOUT ROWID;

-- Abort switch for batches. `INSERT INTO _guard(ok) SELECT 0 WHERE <stale>` fails the
-- CHECK, which rolls the whole D1 batch back. Nothing is ever stored here.
CREATE TABLE _guard (
  ok INTEGER NOT NULL,
  CONSTRAINT edit_is_current CHECK (ok = 1)
);
