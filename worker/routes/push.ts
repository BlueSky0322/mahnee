// Reminders by web push: the key a device subscribes with, and its subscription kept for
// the account signed in, or let go (as signing out does). The cron's job that sends them
// is push/reminders.ts.

import { Hono } from 'hono';
import type { Ok } from '../../shared/api';
import type { PushKey } from '../../shared/push';
import { MAX_PUSH_DEVICES, isPushService, readPushSubscription } from '../../shared/push';
import type { AppEnv } from '../app';
import { fail, json, ok, readJson } from '../http';
import { ensureProfileStatement } from '../accounts/profiles';
import { importBrowserKey } from '../push/encrypt';
import { vapidKeysOf } from '../push/reminders';

const push = new Hono<AppEnv>();

push.get('/push', (c) =>
  json<PushKey>({ publicKey: vapidKeysOf(c.env) == null ? null : c.env.VAPID_PUBLIC_KEY! }),
);

// Kept for whoever subscribes it: a device someone else had moves to them, so one device
// reminds one account. An account keeps its newest MAX_PUSH_DEVICES.
push.put('/push/subscription', async (c) => {
  if (vapidKeysOf(c.env) == null) return fail("Reminders aren't ready on the server yet.", 503);
  const body = await readJson<unknown>(c.req.raw);
  if (body instanceof Response) return body;
  const sub = readPushSubscription(body);
  if ('error' in sub) return fail(sub.error, 400);
  if (!isPushService(sub.endpoint, c.env.PUSH_TEST_ORIGIN)) {
    return fail("Reminders can only go through a browser's push service.", 400);
  }
  // A key that isn't a point on the curve could never be encrypted to
  try {
    await importBrowserKey(sub.keys.p256dh);
  } catch {
    return fail('Invalid subscription', 400);
  }
  const db = c.env.DB;
  const email = c.var.email;
  await db.batch([
    ensureProfileStatement(db, email),
    db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, email, p256dh, auth, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (endpoint) DO UPDATE SET
           email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth,
           created_at = excluded.created_at,
           reminded_on = CASE WHEN email = excluded.email THEN reminded_on END,
           last_ok_at = NULL`,
      )
      .bind(sub.endpoint, email, sub.keys.p256dh, sub.keys.auth, Date.now()),
    db
      .prepare(
        `DELETE FROM push_subscriptions WHERE email = ?1 AND endpoint NOT IN (
           SELECT endpoint FROM push_subscriptions WHERE email = ?1
           ORDER BY created_at DESC, rowid DESC LIMIT ?2)`,
      )
      .bind(email, MAX_PUSH_DEVICES),
  ]);
  return ok();
});

// Only the account's own; one already gone is fine
push.delete('/push/subscription', async (c) => {
  const body = await readJson<{ endpoint: string }>(c.req.raw);
  if (body instanceof Response) return body;
  if (typeof body.endpoint !== 'string') return fail('Invalid subscription', 400);
  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE email = ?1 AND endpoint = ?2')
    .bind(c.var.email, body.endpoint)
    .run();
  return json<Ok>({ ok: true });
});

export default push;
