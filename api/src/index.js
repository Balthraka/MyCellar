import { createApp, publicGuard, userGuard } from '../core/index.js';
import { routes } from './routes.js';

// All sign-in, token checks, sessions, origin checks and routing are the shared core. The app supplies its route table
// and what its two guard names mean.
export const app = createApp({
  routes,
  guards: { public: publicGuard, user: userGuard },
  naming: { column: 'name', field: 'name' },
});

// Two headers on every reply, added here because the shared core does not send them (the core is never edited in this repo).
export async function handle(req, env) {
  const res = await app.handle(req, env);
  const out = new Response(res.body, res);
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('referrer-policy', 'no-referrer');
  return out;
}

export default { fetch: handle };
