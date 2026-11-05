// The API end to end, against the real Worker and a fresh local database: who's signed
// in, their profile and settings, exchange rates, their accounts and the changes saved
// to them, and the safeguards every write passes.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LocalWorker } from './local-worker';
import { startLocalWorker } from './local-worker';
import { rateDay } from '../../shared/rates';

let api: LocalWorker;
let n = 0;
// Fresh accounts for each test, so tests don't see each other's data
const person = (name: string) => `${name}${++n}@example.com`;

// Within the harness's own limits: migrations, then the Worker starting
beforeAll(async () => {
  api = await startLocalWorker();
}, 180_000);

// Each test sets the rates it needs
afterEach(() => api.rates.reset());

afterAll(() => api?.stop(), 30_000);

describe('the profile', () => {
  it('starts with the defaults, before anything is saved', async () => {
    const me = person('me');
    const { status, data } = await api.call(me, 'GET', '/api/me');
    expect(status).toBe(200);
    expect(data).toEqual({
      email: me,
      displayName: null,
      settings: { theme: 'auto', accent: 'blurple', ratePreference: 'wise' },
    });
  });

  it('saves a display name and settings, for that account alone', async () => {
    const me = person('me');
    const other = person('other');
    const saved = await api.call(me, 'PATCH', '/api/me', {
      displayName: '  Mei  ',
      settings: { theme: 'light' },
    });
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ displayName: 'Mei', settings: { theme: 'light' } });
    // A later change keeps what it doesn't name
    await api.call(me, 'PATCH', '/api/me', { settings: { accent: 'teal' } });
    expect((await api.call(me, 'GET', '/api/me')).data).toMatchObject({
      displayName: 'Mei',
      settings: { theme: 'light', accent: 'teal', ratePreference: 'wise' },
    });
    expect((await api.call(other, 'GET', '/api/me')).data.displayName).toBeNull();
    // An empty name clears it
    await api.call(me, 'PATCH', '/api/me', { displayName: '' });
    expect((await api.call(me, 'GET', '/api/me')).data.displayName).toBeNull();
  });

  it.each<[string, object]>([
    ['an unknown setting', { settings: { sidebarOpen: false } }],
    ['a theme that does not exist', { settings: { theme: 'sepia' } }],
    ['a rate source that does not exist', { settings: { ratePreference: 'xe' } }],
    ['settings that are not a list of settings', { settings: ['theme'] }],
    ['a name that is too long', { displayName: 'x'.repeat(33) }],
    ['a name that is not text', { displayName: 42 }],
  ])('refuses %s and saves nothing', async (_what, patch) => {
    const me = person('me');
    await api.call(me, 'PATCH', '/api/me', { displayName: 'Mei' });
    const res = await api.call(me, 'PATCH', '/api/me', patch);
    expect(res.status).toBe(400);
    expect(typeof res.data.error).toBe('string');
    expect((await api.call(me, 'GET', '/api/me')).data).toMatchObject({
      displayName: 'Mei',
      settings: { theme: 'auto', ratePreference: 'wise' },
    });
  });
});

describe('exchange rates', () => {
  // The Worker keeps the rates it fetches for hours, for every test after: these tests
  // look at which service a rate came from, so each uses currencies of its own
  it('converts with Wise, falls back to Frankfurter, and says when neither has a rate', async () => {
    const me = person('me');
    const [first, second] = [api.rates.newCurrency(), api.rates.newCurrency()];
    api.rates.set(first, 'MYR', 4.2);
    const res = await api.call(
      me,
      'GET',
      `/api/rates?from=${first.toLowerCase()}&to=MYR&amount=10.5`,
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ from: first, to: 'MYR', rate: 4.2, source: 'wise' });
    expect(res.data.convertedCents).toBe(4410);

    api.rates.set(second, 'MYR', 3.3);
    api.rates.down('wise', true);
    const fallback = await api.call(me, 'GET', `/api/rates?from=${second}&to=MYR`);
    api.rates.down('wise', false);
    expect(fallback.data).toMatchObject({ rate: 3.3, source: 'frankfurter' });

    expect((await api.call(me, 'GET', '/api/rates?from=XXX&to=MYR')).status).toBe(503);
  });

  it('uses the rate source each person picked', async () => {
    const wiseFan = person('wisefan');
    const ecbFan = person('ecbfan');
    const nzd = api.rates.newCurrency();
    // The two services differ, so each answer shows where it came from
    api.rates.set(nzd, 'MYR', 2.75, 'wise');
    api.rates.set(nzd, 'MYR', 2.7, 'frankfurter');
    await api.call(ecbFan, 'PATCH', '/api/me', { settings: { ratePreference: 'ecb' } });
    expect((await api.call(ecbFan, 'GET', `/api/rates?from=${nzd}&to=MYR`)).data).toMatchObject({
      rate: 2.7,
      source: 'frankfurter',
    });
    expect((await api.call(wiseFan, 'GET', `/api/rates?from=${nzd}&to=MYR`)).data).toMatchObject({
      rate: 2.75,
      source: 'wise',
    });
  });

  it("gives an earlier day's rate, said to be from that day", async () => {
    const me = person('me');
    const cur = api.rates.newCurrency();
    const at = Date.parse(`${rateDay(Date.now() - 3 * 864e5)}T12:00:00Z`);
    api.rates.set(cur, 'MYR', 4);
    api.rates.setOn(rateDay(at), cur, 'MYR', 3);
    const res = await api.call(me, 'GET', `/api/rates?from=${cur}&to=MYR&at=${at}`);
    expect(res.data).toMatchObject({ rate: 3, source: 'frankfurter', fetchedAt: at });
  });

  it.each([
    'from=US&to=MYR',
    'from=USD&to=MYR&amount=-1',
    'from=USD&to=MYR&amount=abc',
    'from=USD&to=MYR&amount=1000000001',
    `from=USD&to=MYR&at=${Date.now() + 7 * 864e5}`,
    'from=USD&to=MYR&at=0',
  ])('refuses %s', async (query) => {
    expect((await api.call(person('me'), 'GET', `/api/rates?${query}`)).status).toBe(400);
  });
});

describe('safeguards', () => {
  it('refuses changes started by another site, but not reads or the app itself', async () => {
    const me = person('me');
    const rename = (headers: Record<string, string>) =>
      api.call(me, 'PATCH', '/api/me', { displayName: 'Taken' }, headers);
    expect((await rename({ 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await rename({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await api.call(me, 'GET', '/api/me')).data.displayName).toBeNull();
    // The same write from the app's own page goes through, whichever header says so
    expect((await rename({ Origin: api.base })).status).toBe(200);
    expect((await rename({ 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    // Reads are fine from anywhere
    expect(
      (await api.call(me, 'GET', '/api/me', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status,
    ).toBe(200);
  });

  it('limits how many changes an account makes a minute, but never reading', async () => {
    const busy = person('busy');
    // Write until refused. The limit counts per minute window, and a run can straddle
    // two windows, so up to 130 writes: at least one window then sees more than 60.
    let accepted = 0;
    let refused = false;
    for (let i = 0; i < 130 && !refused; i++) {
      const theme = i % 2 === 0 ? 'light' : 'dark';
      const { status } = await api.call(busy, 'PATCH', '/api/me', { settings: { theme } });
      if (status === 429) refused = true;
      else if (status === 200) accepted++;
    }
    expect(refused).toBe(true);
    expect(accepted).toBeGreaterThanOrEqual(60);
    expect((await api.call(busy, 'GET', '/api/me')).status).toBe(200);
    // Someone else isn't held back
    expect((await api.call(person('calm'), 'PATCH', '/api/me', { displayName: 'C' })).status).toBe(
      200,
    );
  });

  it('turns away request bodies that are too large, or are not JSON', async () => {
    const me = person('me');
    const huge = await api.call(me, 'PATCH', '/api/me', { displayName: 'x'.repeat(300_000) });
    expect(huge.status).toBe(413);
    const garbled = await api.call(me, 'PATCH', '/api/me', '{not json', {
      'Content-Type': 'application/json',
    });
    expect(garbled).toEqual({ status: 400, data: { error: 'Invalid JSON' } });
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const res = await api.call(person('x'), 'GET', '/api/nope');
    expect(res.status).toBe(404);
    expect(res.data.error).toBe('Not found');
  });
});

describe('saying whose a write is', () => {
  it('refuses a write made as another account before changing anything', async () => {
    const me = person('me');
    const other = person('other');
    const renameAs = (expected: string) =>
      api.call(me, 'PATCH', '/api/me', { displayName: 'Mei' }, { 'X-Expected-Account': expected });

    const refused = await renameAs(other);
    expect(refused).toEqual({
      status: 409,
      data: { error: 'Signed in as someone else.', code: 'account_mismatch' },
    });
    expect((await api.call(me, 'GET', '/api/me')).data.displayName).toBeNull();

    // The account signed in, however it's written, is saved
    expect((await renameAs(` ${me.toUpperCase()} `)).status).toBe(200);
    expect((await api.call(me, 'GET', '/api/me')).data.displayName).toBe('Mei');
  });

  it('still saves a write that says nothing, from apps from before it, while that is allowed', async () => {
    const me = person('me');
    expect((await api.call(me, 'PATCH', '/api/me', { displayName: 'Mei' })).status).toBe(200);
  });
});

describe('accounts', () => {
  let ids = 0;
  /** A fresh row id, as the app makes them: 16 hex characters */
  const rowId = () => (++ids).toString(16).padStart(16, 'a');
  const add = (id: string, name: string, kind = 'bank', openingCents = 0) => ({
    op: 'addAccount',
    account: { id, name, kind, openingCents },
  });
  /** Sends changes as `who`, each with an id of its own unless given */
  const send = (who: string, changes: unknown[], changeIds = changes.map(() => rowId())) =>
    api.call(who, 'POST', '/api/changes', { changes, ids: changeIds });
  const list = async (who: string) => {
    const res = await api.call(who, 'GET', '/api/accounts');
    expect(res.status).toBe(200);
    return res.data.accounts as { id: string; name: string; [k: string]: unknown }[];
  };

  it('starts with none', async () => {
    expect(await list(person('me'))).toEqual([]);
  });

  it('adds accounts, listed in the order they were added with their balances', async () => {
    const me = person('me');
    const [wallet, bank, card] = [rowId(), rowId(), rowId()];
    expect(await send(me, [add(wallet, '  Wallet ', 'cash', 5_000)])).toEqual({
      status: 200,
      data: { ok: true },
    });
    await send(me, [add(bank, 'Maybank', 'bank', 123_456), add(card, 'Visa', 'card', -12_000)]);
    expect(await list(me)).toEqual([
      {
        id: wallet,
        name: 'Wallet',
        kind: 'cash',
        currency: 'MYR',
        openingCents: 5_000,
        balanceCents: 5_000,
        position: 0,
        archived: false,
      },
      expect.objectContaining({ id: bank, position: 1, balanceCents: 123_456 }),
      expect.objectContaining({ id: card, kind: 'card', position: 2, balanceCents: -12_000 }),
    ]);
  });

  it('renames an account and changes its opening balance, keeping what it is not told', async () => {
    const me = person('me');
    const id = rowId();
    await send(me, [add(id, 'Wallet', 'cash', 1_000)]);
    await send(me, [{ op: 'updateAccount', id, name: 'Purse' }]);
    expect((await list(me))[0]).toMatchObject({ name: 'Purse', openingCents: 1_000 });
    await send(me, [{ op: 'updateAccount', id, openingCents: -250 }]);
    expect((await list(me))[0]).toMatchObject({
      name: 'Purse',
      kind: 'cash',
      openingCents: -250,
      balanceCents: -250,
    });
  });

  it('archives an account and brings it back, listed all along', async () => {
    const me = person('me');
    const id = rowId();
    await send(me, [add(id, 'Old card', 'card')]);
    await send(me, [{ op: 'archiveAccount', id, archived: true }]);
    expect(await list(me)).toEqual([expect.objectContaining({ id, archived: true })]);
    await send(me, [{ op: 'archiveAccount', id, archived: false }]);
    expect(await list(me)).toEqual([expect.objectContaining({ id, archived: false })]);
  });

  it("refuses another person's account like one that doesn't exist, and leaves it alone", async () => {
    const me = person('me');
    const other = person('other');
    const theirs = rowId();
    await send(other, [add(theirs, 'Savings', 'bank', 900_000)]);
    const missing = await send(me, [{ op: 'updateAccount', id: rowId(), name: 'Mine' }]);
    expect(missing).toEqual({ status: 404, data: { error: 'Account not found' } });
    for (const change of [
      { op: 'updateAccount', id: theirs, name: 'Mine' },
      { op: 'archiveAccount', id: theirs, archived: true },
    ]) {
      expect(await send(me, [change])).toEqual(missing);
    }
    expect(await list(me)).toEqual([]);
    expect(await list(other)).toEqual([
      expect.objectContaining({ id: theirs, name: 'Savings', archived: false }),
    ]);
    // The same id added as one of mine is a different account, theirs untouched
    expect((await send(me, [add(theirs, 'Mine')])).status).toBe(200);
    expect((await list(other))[0]).toMatchObject({ name: 'Savings' });
    expect((await list(me))[0]).toMatchObject({ id: theirs, name: 'Mine' });
  });

  it.each<[string, (id: string) => unknown, number]>([
    ['an unknown change', () => ({ op: 'deleteAccount', id: rowId() }), 400],
    ['a change that is not an object', () => 'addAccount', 400],
    ['an account without an object', () => ({ op: 'addAccount', account: null }), 400],
    ['an account id of the wrong shape', () => add('ABC', 'Wallet'), 400],
    ['an empty name', () => add(rowId(), '   '), 400],
    ['a name that is too long', () => add(rowId(), 'x'.repeat(41)), 400],
    [
      'a name that is not text',
      () => ({ op: 'addAccount', account: { ...add(rowId(), 'x').account, name: 7 } }),
      400,
    ],
    ['a kind that does not exist', () => add(rowId(), 'Gold', 'gold'), 400],
    ['an opening balance over the limit', () => add(rowId(), 'Rich', 'bank', 1_000_000_001), 400],
    ['an opening balance under the limit', () => add(rowId(), 'Poor', 'bank', -1_000_000_001), 400],
    ['an opening balance in part cents', () => add(rowId(), 'Odd', 'bank', 10.5), 400],
    ['a field it does not know', () => ({ ...add(rowId(), 'x'), extra: 1 }), 400],
    ['changing the kind', (id) => ({ op: 'updateAccount', id, kind: 'cash' }), 400],
    ['a rename to nothing', (id) => ({ op: 'updateAccount', id, name: '' }), 400],
    ['an update that changes nothing', (id) => ({ op: 'updateAccount', id }), 400],
    [
      'archiving without saying which way',
      (id) => ({ op: 'archiveAccount', id, archived: 'yes' }),
      400,
    ],
    ['an account id already used', (id) => add(id, 'Again'), 409],
  ])('refuses %s, saving nothing', async (_what, change, status) => {
    const me = person('me');
    const id = rowId();
    await send(me, [add(id, 'Wallet', 'cash', 100)]);
    const before = await list(me);
    const res = await send(me, [change(id)]);
    expect(res.status).toBe(status);
    expect(typeof res.data.error).toBe('string');
    expect(await list(me)).toEqual(before);
  });

  it.each<[string, (changes: unknown[]) => unknown]>([
    ['no list of changes', () => ({ ids: [rowId()] })],
    ['no ids', (changes) => ({ changes })],
    ['one id short', (changes) => ({ changes, ids: [rowId()] })],
    ['an id of the wrong shape', (changes) => ({ changes, ids: ['nope', rowId()] })],
    ['the same id twice', (changes) => ({ changes, ids: ['f'.repeat(16), 'f'.repeat(16)] })],
    ['no changes at all', () => ({ changes: [], ids: [] })],
  ])('refuses a batch with %s', async (_what, body) => {
    const me = person('me');
    const changes = [add(rowId(), 'One'), add(rowId(), 'Two')];
    const res = await api.call(me, 'POST', '/api/changes', body(changes));
    expect(res.status).toBe(400);
    expect(await list(me)).toEqual([]);
  });

  it('refuses more than 200 changes in one batch', async () => {
    const me = person('me');
    const id = rowId();
    await send(me, [add(id, 'Wallet')]);
    const renames = Array.from({ length: 201 }, (_, i) => ({
      op: 'updateAccount',
      id,
      name: `Wallet ${i}`,
    }));
    expect((await send(me, renames)).status).toBe(400);
    // 200 is fine, and the last one is what stays
    expect((await send(me, renames.slice(0, 200))).status).toBe(200);
    expect((await list(me))[0].name).toBe('Wallet 199');
  });

  it('refuses adding the same new id twice in one batch', async () => {
    const me = person('me');
    const id = rowId();
    const res = await send(me, [add(id, 'One'), add(id, 'Two')]);
    expect(res.status).toBe(409);
    expect(await list(me)).toEqual([]);
  });

  it('keeps to 50 accounts, archived ones included', async () => {
    const me = person('me');
    const fifty = Array.from({ length: 50 }, (_, i) => add(rowId(), `Account ${i}`));
    expect((await send(me, fifty)).status).toBe(200);
    await send(me, [{ op: 'archiveAccount', id: fifty[0].account.id, archived: true }]);
    const res = await send(me, [add(rowId(), 'One too many')]);
    expect(res).toEqual({
      status: 409,
      data: { error: 'You can have up to 50 accounts, archived ones included' },
    });
    expect(await list(me)).toHaveLength(50);
  });

  it('saves a batch all or nothing', async () => {
    const me = person('me');
    const id = rowId();
    await send(me, [add(id, 'Wallet', 'cash', 100)]);
    const res = await send(me, [
      add(rowId(), 'Bank'),
      { op: 'updateAccount', id, name: 'Purse' },
      { op: 'archiveAccount', id: rowId(), archived: true },
    ]);
    expect(res.status).toBe(404);
    expect(await list(me)).toEqual([expect.objectContaining({ id, name: 'Wallet' })]);
  });

  it('applies a batch in order, so a change can follow an account added in it', async () => {
    const me = person('me');
    const id = rowId();
    expect(
      (
        await send(me, [
          add(id, 'Wallet', 'cash', 100),
          { op: 'updateAccount', id, name: 'Purse' },
          { op: 'archiveAccount', id, archived: true },
        ])
      ).status,
    ).toBe(200);
    expect(await list(me)).toEqual([
      expect.objectContaining({ id, name: 'Purse', archived: true }),
    ]);
  });

  it('counts a change sent again once, and refuses its id with a different change', async () => {
    const me = person('me');
    const [account, changeId] = [rowId(), rowId()];
    const first = await send(me, [add(account, 'Wallet', 'cash', 100)], [changeId]);
    expect(first.status).toBe(200);
    // Its answer lost, the app sends it again, alongside a newer change
    const rename = { op: 'updateAccount', id: account, name: 'Purse' };
    const again = await send(
      me,
      [add(account, 'Wallet', 'cash', 100), rename],
      [changeId, rowId()],
    );
    expect(again).toEqual({ status: 200, data: { ok: true } });
    expect(await list(me)).toEqual([expect.objectContaining({ id: account, name: 'Purse' })]);

    const reused = await send(me, [add(rowId(), 'Other')], [changeId]);
    expect(reused).toEqual({
      status: 409,
      data: { error: 'That change was saved differently before' },
    });
    expect(await list(me)).toHaveLength(1);
  });

  it("keeps each person's receipts apart", async () => {
    const [me, other] = [person('me'), person('other')];
    const changeId = rowId();
    await send(me, [add(rowId(), 'Mine')], [changeId]);
    // The same change id from someone else is their own change, saved for them
    expect((await send(other, [add(rowId(), 'Theirs')], [changeId])).status).toBe(200);
    expect(await list(other)).toEqual([expect.objectContaining({ name: 'Theirs' })]);
  });

  it('lets go of receipts older than 90 days when it saves the next change', async () => {
    const me = person('me');
    const [old, recent] = [rowId(), rowId()];
    await send(me, [add(rowId(), 'Wallet')], [old]);
    await send(me, [add(rowId(), 'Bank')], [recent]);
    const day = 24 * 60 * 60 * 1000;
    await api.sql(
      'UPDATE change_receipts SET saved_at = ? WHERE email = ? AND change_id = ?',
      Date.now() - 91 * day,
      me,
      old,
    );
    await api.sql(
      'UPDATE change_receipts SET saved_at = ? WHERE email = ? AND change_id = ?',
      Date.now() - 89 * day,
      me,
      recent,
    );
    await send(me, [add(rowId(), 'Card', 'card')]);
    const kept = (await api.sql(
      'SELECT change_id AS id FROM change_receipts WHERE email = ? ORDER BY saved_at',
      me,
    )) as { id: string }[];
    expect(kept.map((r) => r.id)).toEqual([recent, expect.any(String)]);
  });
});
