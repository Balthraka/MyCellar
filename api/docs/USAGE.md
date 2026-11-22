# MyCellar usage (local D1, made-up data)

Measured from D1 `meta.rows_read` / `meta.rows_written` per request. Dataset: 4 users x 100 drinks, and the measured user has 500 drinks / 1,000 stock rows (a real cellar is about 30).

Free limits: 5,000,000 rows read and 100,000 rows written per day; 50 queries per request; 100 bound parameters per query.

| Route | Queries | Max params | Rows read | Rows written |
|---|---|---|---|---|
| GET /cellar (500 drinks, 1,000 stock rows) | 4 | 2 | 1503 | 0 |
| GET /cellar (100 drinks, 200 stock rows) | 4 | 2 | 305 | 0 |
| PUT /drinks/:id (new drink, 1 stock row) | 5 | 3 | 9 | 2 |
| PUT /drinks/:id (edit, 1 stock row) | 6 | 3 | 13 | 1 |
| DELETE /drinks/:id | 4 | 3 | 7 | 2 |
| POST /drinks/bulk (50 drinks, 100 stock rows) | 6 | 3 | 604 | 50 |
| POST /ops/unassign (500 drinks) | 3 | 2 | 3502 | 1000 |
| POST /ops/clearstock (500 drinks) | 3 | 2 | 4002 | 1000 |
| PUT /settings | 3 | 4 | 4 | 1 |
| POST /ops/replace-all (wipe 500, load 30-drink demo) | 8 | 3 | 2655 | 1061 |
| POST /auth/google (existing user) | 3 | 5 | 4 | 3 |
| DELETE /me (100 drinks, 200 stock rows) | 8 | 2 | 717 | 305 |
