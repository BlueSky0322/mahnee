// Reminders by web push (owner decision D6, "Push with details"), end to end against the
// real Worker, a fresh local database and a stand-in push service. A device subscribes for
// the account signed in; the cron trigger (every 15 minutes, shared with the nightly job)
// then reminds each person at their own time, in their stored time zone: daily, only when
// nothing was added that day, and the day (or days) before a scheduled entry, naming it and
// its amount. Each message is encrypted to the device and signed with the server's VAPID
// key; this file reads it as the browser would.
//
// Runs are fired at fixed instants in 2025; "added that day" is worked out from when an
// entry was saved, so entries are moved to the day under test in the database.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES } from '../../shared/categories';
import type { LocalWorker } from './local-worker';
import { startLocalWorker } from './local-worker';
import { newBrowser, readVapid } from './push-receiver';

let api: LocalWorker;
let n = 0;
const person = (name: string) => `${name}${++n}@example.com`;

beforeAll(async () => {
  api = await startLocalWorker();
}, 180_000);

afterAll(() => api?.stop(), 30_000);

// Every run reminds everyone in the database: what a test leaves is taken away, so it can't
// land in a later test's runs
afterEach(async () => {
  await api.sql('DELETE FROM push_subscriptions');
  await api.sql('UPDATE recurring SET archived = 1 WHERE archived = 0');
  api.push.reset();
});

let ids = 0;
/** A fresh row id, as the app makes them: 16 hex characters */
const rowId = () => (++ids).toString(16).padStart(16, '5');
const BILLS = DEFAULT_CATEGORIES.find((c) => c.name === 'Bills')!.id;
const KL = 'Asia/Kuala_Lumpur';
const KATHMANDU = 'Asia/Kathmandu';
const CRON = '*/15 * * * *';
const APP = 'https://mahnee.shitty-app.workers.dev';

/** Runs the cron trigger as scheduled for `instant` */
async function runAt(instant: string) {
  const res = await fetch(
    `${api.base}/cdn-cgi/local/scheduled?cron=${encodeURIComponent(CRON)}&time=${Date.parse(instant)}`,
  );
  expect({ status: res.status, outcome: await res.text() }).toEqual({ status: 200, outcome: 'ok' });
}

async function send(who: string, changes: unknown[]) {
  const res = await api.call(who, 'POST', '/api/changes', {
    changes,
    ids: changes.map(() => rowId()),
  });
  expect(res).toEqual({ status: 200, data: { ok: true } });
}

/** A person with a wallet, their time zone and reminder settings saved */
async function someone(zone: string | null, settings: Record<string, unknown> = {}) {
  const who = person('me');
  const wallet = rowId();
  await send(who, [
    { op: 'addAccount', account: { id: wallet, name: 'Wallet', kind: 'cash', openingCents: 0 } },
  ]);
  const res = await api.call(who, 'PATCH', '/api/me', {
    settings: { ...(zone == null ? {} : { timeZone: zone }), ...settings },
  });
  expect(res.status).toBe(200);
  return { who, wallet };
}

let devices = 0;
/** A browser subscribed for `who`, on the stand-in push service */
async function device(who: string) {
  const browser = await newBrowser(`${api.push.base}/push/device-${++devices}`);
  const res = await api.call(who, 'PUT', '/api/push/subscription', browser.subscription);
  expect(res).toEqual({ status: 200, data: { ok: true } });
  const path = new URL(browser.subscription.endpoint).pathname;
  return {
    ...browser,
    path,
    /** What reached this device, each message read */
    messages: async () =>
      Promise.all(
        api.push
          .received()
          .filter((r) => r.path === path)
          .map(async (r) => JSON.parse(await browser.read(r.body)) as unknown),
      ),
  };
}

const DAILY = {
  title: 'Nothing added today',
  body: 'Anything spent today? Add it before you forget.',
  url: '/',
  tag: 'daily',
};

const scheduled = (title: string, body = 'From Scheduled. Tap to check it.') => ({
  title,
  body,
  url: '/?plan=scheduled',
  tag: 'scheduled',
});

/** A monthly bill from the wallet, TNB RM 189.00 on the 20th unless said otherwise */
function item(accountId: string, more: Record<string, unknown> = {}) {
  return {
    id: rowId(),
    kind: 'expense',
    accountId,
    toAccountId: null,
    amountCents: 18_900,
    categoryId: BILLS,
    payee: 'TNB',
    schedule: 'monthly',
    day: 20,
    startDate: '2025-10-20',
    nextDue: '2025-11-20',
    ...more,
  };
}

/** Sets up items as added on their day, not asked about first (as scheduled.test.ts does) */
async function setUp(who: string, items: ReturnType<typeof item>[]) {
  await send(
    who,
    items.map((recurring) => ({ op: 'addRecurring', recurring })),
  );
  await api.sql('UPDATE recurring SET ask_first = 0 WHERE email = ?', who);
}

/** Saves an entry, then marks it as saved at `instant` */
async function addedAt(who: string, wallet: string, instant: string) {
  const id = rowId();
  await send(who, [
    {
      op: 'addTransaction',
      transaction: {
        id,
        kind: 'expense',
        accountId: wallet,
        amountCents: 1_200,
        categoryId: BILLS,
        payee: 'Kopi',
        date: '2025-11-19',
      },
    },
  ]);
  await api.sql(
    'UPDATE transactions SET created_at = ?, updated_at = ? WHERE email = ? AND id = ?',
    Date.parse(instant),
    Date.parse(instant),
    who,
    id,
  );
}

const subscriptions = (who: string) =>
  api.sql('SELECT endpoint FROM push_subscriptions WHERE email = ? ORDER BY endpoint', who);

describe('a device subscribing', () => {
  it("is given the server's public key to subscribe with", async () => {
    const res = await api.call(person('key'), 'GET', '/api/push');
    expect(res).toEqual({ status: 200, data: { publicKey: api.vapidPublicKey } });
  });

  it('is kept for the account that sent it, and only for it', async () => {
    const { who } = await someone(KL);
    const other = person('other');
    const phone = await device(who);
    expect(await subscriptions(who)).toEqual([{ endpoint: phone.subscription.endpoint }]);
    expect(await subscriptions(other)).toEqual([]);
  });

  it.each<[string, (s: { endpoint: string; keys: Record<string, string> }) => unknown]>([
    ['no keys', (s) => ({ endpoint: s.endpoint })],
    [
      'a key that is not a point on the curve',
      (s) => ({ ...s, keys: { ...s.keys, p256dh: 'AAAA' } }),
    ],
    ['an auth secret of the wrong length', (s) => ({ ...s, keys: { ...s.keys, auth: 'AAAA' } })],
    ['an endpoint that is not a web address', (s) => ({ ...s, endpoint: 'push me' })],
    [
      'an endpoint over 2048 characters',
      (s) => ({ ...s, endpoint: `${s.endpoint}/${'x'.repeat(2048)}` }),
    ],
    ['fields it does not know', (s) => ({ ...s, expirationTime: 1, extra: true })],
  ])('refuses one with %s, and keeps nothing', async (_name, change) => {
    const who = person('refused');
    const browser = await newBrowser(`${api.push.base}/push/refused-${++devices}`);
    const res = await api.call(who, 'PUT', '/api/push/subscription', change(browser.subscription));
    expect(res).toEqual({ status: 400, data: { error: 'Invalid subscription' } });
    expect(await subscriptions(who)).toEqual([]);
  });

  it('refuses an endpoint that is not a push service, and keeps nothing', async () => {
    const who = person('elsewhere');
    for (const endpoint of [
      'https://example.com/push/1',
      'http://fcm.googleapis.com/fcm/send/1',
      'https://fcm.googleapis.com.example.com/fcm/send/1',
    ]) {
      const browser = await newBrowser(endpoint);
      const res = await api.call(who, 'PUT', '/api/push/subscription', browser.subscription);
      expect(res).toEqual({
        status: 400,
        data: { error: "Reminders can only go through a browser's push service." },
      });
    }
    expect(await subscriptions(who)).toEqual([]);
  });

  it("takes the browsers' push services", async () => {
    const who = person('real');
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QabcDEF',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      const browser = await newBrowser(endpoint);
      const res = await api.call(who, 'PUT', '/api/push/subscription', browser.subscription);
      expect({ endpoint, ...res }).toEqual({ endpoint, status: 200, data: { ok: true } });
    }
    expect(await subscriptions(who)).toHaveLength(4);
  });

  it('is refused, keeping nothing, when made as another account than the one signed in', async () => {
    const who = person('signed-in');
    const browser = await newBrowser(`${api.push.base}/push/mismatch-${++devices}`);
    const res = await api.call(who, 'PUT', '/api/push/subscription', browser.subscription, {
      'X-Expected-Account': 'someone-else@example.com',
    });
    expect(res).toEqual({
      status: 409,
      data: { error: 'Signed in as someone else.', code: 'account_mismatch' },
    });
    expect(await subscriptions(who)).toEqual([]);
  });

  it('moves a device to whoever subscribes it next, so one device reminds one account', async () => {
    const [ann, ben] = [person('ann'), person('ben')];
    const browser = await newBrowser(`${api.push.base}/push/shared-${++devices}`);
    for (const who of [ann, ben]) {
      expect(await api.call(who, 'PUT', '/api/push/subscription', browser.subscription)).toEqual({
        status: 200,
        data: { ok: true },
      });
    }
    expect(await subscriptions(ann)).toEqual([]);
    expect(await subscriptions(ben)).toEqual([{ endpoint: browser.subscription.endpoint }]);
  });

  it('keeps the newest ten devices of an account', async () => {
    const who = person('many');
    const endpoints: string[] = [];
    for (let i = 0; i < 11; i++) {
      const phone = await device(who);
      endpoints.push(phone.subscription.endpoint);
    }
    const kept = (await subscriptions(who)).map((r) => (r as { endpoint: string }).endpoint);
    expect(kept.sort()).toEqual(endpoints.slice(1).sort());
  });

  it('is let go by its own account only, as signing out does', async () => {
    const [ann, ben] = [person('ann'), person('ben')];
    const phone = await device(ann);
    const body = { endpoint: phone.subscription.endpoint };
    expect(await api.call(ben, 'DELETE', '/api/push/subscription', body)).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await subscriptions(ann)).toHaveLength(1);
    expect(await api.call(ann, 'DELETE', '/api/push/subscription', body)).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await subscriptions(ann)).toEqual([]);
    // Again, already gone: still fine
    expect(await api.call(ann, 'DELETE', '/api/push/subscription', body)).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await api.call(ann, 'DELETE', '/api/push/subscription', { endpoint: 42 })).toEqual({
      status: 400,
      data: { error: 'Invalid subscription' },
    });
  });
});

describe('the daily reminder', () => {
  const quiet = { scheduledReminderDays: null };

  it('comes at 9:00 PM in Kuala Lumpur when nothing was added that day, once', async () => {
    const { who } = await someone(KL, quiet);
    const phone = await device(who);
    // 8:45 PM there
    await runAt('2025-11-19T12:45:00Z');
    expect(await phone.messages()).toEqual([]);
    await runAt('2025-11-19T13:00:00Z');
    expect(await phone.messages()).toEqual([DAILY]);
    await runAt('2025-11-19T13:15:00Z');
    expect(await phone.messages()).toEqual([DAILY]);
    // The next day, again
    await runAt('2025-11-20T13:00:00Z');
    expect(await phone.messages()).toEqual([DAILY, DAILY]);
  });

  it('is sent encrypted to the device, signed as the app, for the push service', async () => {
    const { who } = await someone(KL, quiet);
    const phone = await device(who);
    await runAt('2025-11-19T13:00:00Z');
    const [sent] = api.push.received().filter((r) => r.path === phone.path);
    expect(sent.headers['content-encoding']).toBe('aes128gcm');
    expect(Number(sent.headers.ttl)).toBeGreaterThan(0);
    const claims = await readVapid(sent.headers.authorization, api.vapidPublicKey);
    expect(claims).toMatchObject({ aud: api.push.base, sub: APP });
    expect(claims.exp * 1000).toBeGreaterThan(Date.now());
  });

  it('follows a zone a quarter of an hour off the hour: 9:00 PM in Kathmandu', async () => {
    const { who } = await someone(KATHMANDU, quiet);
    const phone = await device(who);
    await runAt('2025-11-19T15:00:00Z');
    expect(await phone.messages()).toEqual([]);
    await runAt('2025-11-19T15:15:00Z');
    expect(await phone.messages()).toEqual([DAILY]);
  });

  it('comes at the run after a time between runs, and not hours late', async () => {
    const { who } = await someone(KL, { ...quiet, reminderTime: '21:10' });
    const phone = await device(who);
    await runAt('2025-11-19T13:00:00Z');
    expect(await phone.messages()).toEqual([]);
    await runAt('2025-11-19T13:15:00Z');
    expect(await phone.messages()).toEqual([DAILY]);

    // Nothing ran for hours: 11:30 PM is too late for a 9:10 PM reminder
    const late = await someone(KL, { ...quiet, reminderTime: '21:10' });
    const laptop = await device(late.who);
    await runAt('2025-11-20T15:30:00Z');
    expect(await laptop.messages()).toEqual([]);
  });

  it('stays away when something was added that day, and counts only that day', async () => {
    const busy = await someone(KL, quiet);
    const busyPhone = await device(busy.who);
    // 1:00 PM on the 19th in Kuala Lumpur
    await addedAt(busy.who, busy.wallet, '2025-11-19T05:00:00Z');
    const yesterday = await someone(KL, quiet);
    const yesterdayPhone = await device(yesterday.who);
    // 11:30 PM on the 18th there
    await addedAt(yesterday.who, yesterday.wallet, '2025-11-18T15:30:00Z');

    await runAt('2025-11-19T13:00:00Z');
    expect(await busyPhone.messages()).toEqual([]);
    expect(await yesterdayPhone.messages()).toEqual([DAILY]);
  });

  it('counts an entry the nightly job added from Scheduled as nothing added', async () => {
    const { who, wallet } = await someone(KL, quiet);
    const phone = await device(who);
    await setUp(who, [item(wallet, { nextDue: '2025-11-19', day: 19 })]);
    // Midnight there: the job adds TNB on the 19th
    await runAt('2025-11-18T16:00:00Z');
    expect(await api.sql('SELECT date FROM transactions WHERE email = ?', who)).toEqual([
      { date: '2025-11-19' },
    ]);
    await runAt('2025-11-19T13:00:00Z');
    expect(await phone.messages()).toEqual([DAILY]);
  });

  it('never comes when it is off, without a subscription, or without a time zone', async () => {
    const off = await someone(KL, { ...quiet, dailyReminder: false });
    const offPhone = await device(off.who);
    const nowhere = await someone(null, quiet);
    const nowherePhone = await device(nowhere.who);
    // Someone with nothing to send to
    await someone(KL, quiet);
    await runAt('2025-11-19T13:00:00Z');
    expect(await offPhone.messages()).toEqual([]);
    expect(await nowherePhone.messages()).toEqual([]);
    expect(api.push.received()).toEqual([]);
  });

  it('comes to each of the person’s devices', async () => {
    const { who } = await someone(KL, quiet);
    const [phone, laptop] = [await device(who), await device(who)];
    await runAt('2025-11-19T13:00:00Z');
    expect(await phone.messages()).toEqual([DAILY]);
    expect(await laptop.messages()).toEqual([DAILY]);
  });
});

describe('the reminder before a scheduled entry', () => {
  const only = { dailyReminder: false };

  it('names it and its amount the day before: "TNB RM 189.00 is added tomorrow"', async () => {
    const { who, wallet } = await someone(KL, only);
    const phone = await device(who);
    await setUp(who, [item(wallet)]);
    await runAt('2025-11-18T13:00:00Z');
    expect(await phone.messages()).toEqual([]);
    await runAt('2025-11-19T13:00:00Z');
    expect(await phone.messages()).toEqual([scheduled('TNB RM 189.00 is added tomorrow')]);
  });

  it('comes as many days before as set', async () => {
    const { who, wallet } = await someone(KL, { ...only, scheduledReminderDays: 3 });
    const phone = await device(who);
    await setUp(who, [item(wallet)]);
    await runAt('2025-11-17T13:00:00Z');
    await runAt('2025-11-19T13:00:00Z');
    expect(await phone.messages()).toEqual([scheduled('TNB RM 189.00 is added in 3 days')]);
  });

  it('names one and counts the others due that day; never one that asks first or stopped', async () => {
    const { who, wallet } = await someone(KL, only);
    const phone = await device(who);
    await setUp(who, [
      item(wallet),
      item(wallet, { payee: 'Unifi', amountCents: 12_900 }),
      item(wallet, { payee: 'Water', amountCents: 3_000, day: 21, nextDue: '2025-11-21' }),
    ]);
    const asking = item(wallet, { payee: 'Astro', amountCents: 9_900 });
    const stopped = item(wallet, { payee: 'Gym', amountCents: 15_000 });
    await setUp(who, [asking, stopped]);
    await api.sql('UPDATE recurring SET ask_first = 1 WHERE email = ? AND id = ?', who, asking.id);
    await send(who, [{ op: 'archiveRecurring', id: stopped.id, archived: true }]);

    await runAt('2025-11-19T13:00:00Z');
    expect(await phone.messages()).toEqual([
      scheduled(
        'TNB RM 189.00 and 1 more are added tomorrow',
        'Also Unifi RM 129.00. Tap to check them.',
      ),
    ]);
  });

  it('comes beside the daily reminder when both are due', async () => {
    const { who, wallet } = await someone(KL);
    const phone = await device(who);
    await setUp(who, [item(wallet)]);
    await runAt('2025-11-19T13:00:00Z');
    expect(await phone.messages()).toEqual([DAILY, scheduled('TNB RM 189.00 is added tomorrow')]);
  });

  it('never comes when it is off', async () => {
    const { who, wallet } = await someone(KL, { ...only, scheduledReminderDays: null });
    const phone = await device(who);
    await setUp(who, [item(wallet)]);
    await runAt('2025-11-19T13:00:00Z');
    expect(await phone.messages()).toEqual([]);
  });
});

describe('what the push service answers', () => {
  const quiet = { scheduledReminderDays: null };

  it.each([404, 410])('a device gone (%i) is let go', async (status) => {
    const { who } = await someone(KL, quiet);
    const phone = await device(who);
    api.push.answer(phone.path, status);
    await runAt('2025-11-19T13:00:00Z');
    expect(await subscriptions(who)).toEqual([]);
  });

  it('a device the service can’t take now is kept and tried at the next run, without holding back others', async () => {
    const ann = await someone(KL, quiet);
    const busy = await device(ann.who);
    const ben = await someone(KL, quiet);
    const fine = await device(ben.who);
    api.push.answer(busy.path, 503);
    await runAt('2025-11-19T13:00:00Z');
    expect(await fine.messages()).toEqual([DAILY]);
    expect(await subscriptions(ann.who)).toHaveLength(1);

    api.push.answer(busy.path, 201);
    await runAt('2025-11-19T13:15:00Z');
    const tries = api.push.received().filter((r) => r.path === busy.path);
    expect(tries).toHaveLength(2);
    expect(JSON.parse(await busy.read(tries[1].body))).toEqual(DAILY);
    // Ben's once only
    expect(await fine.messages()).toEqual([DAILY]);
  });

  it('a run reminds at most 50 devices; the rest come at the next run', async () => {
    const browser = await newBrowser(`${api.push.base}/push/unused`);
    const now = Date.now();
    for (let i = 0; i < 55; i++) {
      const email = person('crowd');
      await api.sql(
        'INSERT INTO profiles (email, created_at, updated_at) VALUES (?, ?, ?)',
        email,
        now,
        now,
      );
      await api.sql(
        `INSERT INTO user_settings (email, time_zone, scheduled_reminder_days, updated_at)
         VALUES (?, ?, NULL, ?)`,
        email,
        KL,
        now,
      );
      await api.sql(
        `INSERT INTO push_subscriptions (email, endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        email,
        `${api.push.base}/push/crowd-${i}`,
        browser.subscription.keys.p256dh,
        browser.subscription.keys.auth,
        now,
      );
    }
    await runAt('2025-11-19T13:00:00Z');
    expect(api.push.received()).toHaveLength(50);
    await runAt('2025-11-19T13:15:00Z');
    const paths = api.push.received().map((r) => r.path);
    expect(paths).toHaveLength(55);
    expect(new Set(paths).size).toBe(55);
  });
});
