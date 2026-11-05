// The Worker: the app's files for everything outside /api, and the API itself. Every
// API request passes the cross-site check and sign-in before reaching a route.

import { Hono } from 'hono';
import type { AppEnv, Env } from './app';
import { fail, isCrossSiteWrite, notFound } from './http';
import { EXPECTED_ACCOUNT_HEADER } from '../shared/api';
import { getUserEmail } from './accounts/auth';
import ledger from './routes/ledger';
import me from './routes/me';
import rates from './routes/rates';

const api = new Hono<AppEnv>().basePath('/api');

api.use('*', async (c, next) => {
  if (isCrossSiteWrite(c.req.raw, new URL(c.req.url))) {
    return fail('Not allowed from another site', 403);
  }
  const email = await getUserEmail(c.req.raw, c.env);
  if (email == null) return fail('Not signed in', 401);
  c.set('email', email);
  await next();
});

// A write says whose it is: one made as another account than the one signed in now (a
// change kept on the device from before someone else signed in, or a tab left open) is
// refused before it changes anything, and the app keeps it for that account. Apps too
// old to say are refused once REQUIRE_EXPECTED_ACCOUNT is on, with a status they keep
// their changes for, until they update.
api.use('*', async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  const expected = c.req.header(EXPECTED_ACCOUNT_HEADER);
  if (expected == null) {
    if (c.env.REQUIRE_EXPECTED_ACCOUNT === 'true') {
      return fail('Update the app to save this.', 503, 'client_update_required');
    }
    return next();
  }
  if (expected.trim().toLowerCase() !== c.var.email.toLowerCase()) {
    return fail('Signed in as someone else.', 409, 'account_mismatch');
  }
  await next();
});

// Each account gets a limited number of changes a minute; reading is never limited
api.use('*', async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  const { success } = await c.env.API_LIMITER.limit({ key: c.var.email });
  if (!success) return fail('Too many changes, slow down a moment.', 429);
  await next();
});

api.route('/', me);
api.route('/', ledger);
api.route('/', rates);

api.notFound(() => notFound());

// Answer in JSON like every other error, so the app can show it, rather than
// Cloudflare's error page. Only the error's name and message are logged: nothing a
// person typed reaches the logs.
api.onError((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'Unknown error');
  return fail('Something went wrong. Try again in a moment.', 500);
});

export default {
  fetch(req, env, ctx): Response | Promise<Response> {
    const path = new URL(req.url).pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    return api.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
