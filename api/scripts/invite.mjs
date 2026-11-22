#!/usr/bin/env node
// Prints SQL that invites a user (private mode: only emails in `users` can sign in).
//   node scripts/invite.mjs --email someone@example.com [--name "Someone"] [--out import/invite.sql]
// Then: npx wrangler d1 execute mycellar --remote --file=import/invite.sql
// The first Google sign-in with that (verified) email links the account.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const email = String(args.email || '').trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('Usage: node scripts/invite.mjs --email <address> [--name <name>] [--out <file>]'); process.exit(1); }
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const sql = `INSERT INTO users (id, email, name, version, created_at) VALUES (${q(args.id || randomUUID())}, ${q(email)}, ${q(args.name || '')}, 1, ${q(new Date().toISOString())}) ON CONFLICT(email) DO NOTHING;\n`;
if (args.out) { mkdirSync(dirname(args.out), { recursive: true }); writeFileSync(args.out, sql); console.error('wrote ' + args.out); } else process.stdout.write(sql);
