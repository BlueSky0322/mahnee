// The API end to end, against the real Worker and a fresh local database: who's signed
// in, their profile and settings, exchange rates, their accounts and categories and the
// changes saved to them, and the safeguards every write passes.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LocalWorker } from './local-worker';
import { startLocalWorker } from './local-worker';
import { DEFAULT_CATEGORIES } from '../../shared/categories';
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

describe('categories', () => {
  let ids = 0;
  /** A fresh row id, as the app makes them: 16 hex characters */
  const rowId = () => (++ids).toString(16).padStart(16, 'b');
  const add = (id: string, name: string, parentId: string | null = null, kind = 'expense') => ({
    op: 'addCategory',
    category: { id, name, kind, parentId },
  });
  const send = (who: string, changes: unknown[], changeIds = changes.map(() => rowId())) =>
    api.call(who, 'POST', '/api/changes', { changes, ids: changeIds });
  interface Row {
    id: string;
    name: string;
    kind: string;
    parentId: string | null;
    position: number;
    archived: boolean;
  }
  const ledger = async (who: string) => {
    const res = await api.call(who, 'GET', '/api/accounts');
    expect(res.status).toBe(200);
    return res.data as { accounts: { id: string; name: string }[]; categories: Row[] };
  };
  const list = async (who: string) => (await ledger(who)).categories;
  /** The categories beside each other under `parentId` (null: top level), as "name" in order */
  const under = async (who: string, parentId: string | null, kind = 'expense') =>
    (await list(who))
      .filter((c) => c.parentId === parentId && c.kind === kind)
      .sort((a, b) => a.position - b.position)
      .map((c) => c.name);
  const byId = (rows: readonly { id: string }[]) =>
    [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  const [food, transport, groceries] = DEFAULT_CATEGORIES.map((c) => c.id);
  const salary = DEFAULT_CATEGORIES.find((c) => c.name === 'Salary')!.id;

  /** A person with the defaults saved, and Coffee under Food */
  async function withCoffee() {
    const me = person('me');
    const coffee = rowId();
    expect((await send(me, [add(coffee, 'Coffee', food)])).status).toBe(200);
    return { me, coffee };
  }

  it('has none saved at first, and saves the defaults with the first change of any kind', async () => {
    const me = person('me');
    expect(await list(me)).toEqual([]);
    expect(
      (
        await send(me, [
          {
            op: 'addAccount',
            account: { id: rowId(), name: 'Wallet', kind: 'cash', openingCents: 0 },
          },
        ])
      ).status,
    ).toBe(200);
    const saved = await list(me);
    expect(byId(saved)).toEqual(byId(DEFAULT_CATEGORIES));
    expect(await under(me, null)).toEqual([
      'Food',
      'Transport',
      'Groceries',
      'Bills',
      'Shopping',
      'Health',
      'Fun',
      'Other',
    ]);
    expect(await under(me, null, 'income')).toEqual(['Salary', 'Other income']);
    // Later changes leave them as they are
    await send(me, [add(rowId(), 'Gifts')]);
    expect(await list(me)).toHaveLength(DEFAULT_CATEGORIES.length + 1);
  });

  it('takes a change to a default before any are saved, saving the defaults first', async () => {
    const me = person('me');
    expect((await send(me, [{ op: 'updateCategory', id: food, name: 'Eating out' }])).status).toBe(
      200,
    );
    expect(await under(me, null)).toEqual(expect.arrayContaining(['Eating out', 'Transport']));
    expect(await list(me)).toHaveLength(DEFAULT_CATEGORIES.length);
  });

  it('adds categories and subcategories, each last among the ones beside it', async () => {
    const { me, coffee } = await withCoffee();
    const tea = rowId();
    await send(me, [
      add(tea, '  Tea ', food),
      add(rowId(), 'Gifts'),
      add(rowId(), 'Bonus', null, 'income'),
    ]);
    expect(await under(me, food)).toEqual(['Coffee', 'Tea']);
    expect((await under(me, null)).at(-1)).toBe('Gifts');
    expect(await under(me, null, 'income')).toEqual(['Salary', 'Other income', 'Bonus']);
    expect((await list(me)).find((c) => c.id === coffee)).toEqual({
      id: coffee,
      name: 'Coffee',
      kind: 'expense',
      parentId: food,
      position: 0,
      archived: false,
    });
  });

  it('renames, reorders, moves, archives and brings back', async () => {
    const { me, coffee } = await withCoffee();
    const tea = rowId();
    await send(me, [add(tea, 'Tea', food)]);

    await send(me, [{ op: 'updateCategory', id: coffee, name: 'Kopi' }]);
    // Tea first among Food's, then Groceries to the top of the list
    await send(me, [{ op: 'updateCategory', id: tea, position: 0 }]);
    expect(await under(me, food)).toEqual(['Tea', 'Kopi']);
    await send(me, [{ op: 'updateCategory', id: groceries, position: 0 }]);
    expect((await under(me, null)).slice(0, 3)).toEqual(['Groceries', 'Food', 'Transport']);
    // Positions are numbered afresh, so a place past the end is last
    await send(me, [{ op: 'updateCategory', id: groceries, position: 99 }]);
    expect((await under(me, null)).at(-1)).toBe('Groceries');

    // Kopi to the top level, then Transport under Food, at the front there
    await send(me, [{ op: 'updateCategory', id: coffee, parentId: null }]);
    expect(await under(me, food)).toEqual(['Tea']);
    expect((await under(me, null)).at(-1)).toBe('Kopi');
    await send(me, [{ op: 'updateCategory', id: transport, parentId: food, position: 0 }]);
    expect(await under(me, food)).toEqual(['Transport', 'Tea']);

    await send(me, [{ op: 'archiveCategory', id: tea, archived: true }]);
    expect((await list(me)).find((c) => c.id === tea)).toMatchObject({
      archived: true,
      parentId: food,
    });
    await send(me, [{ op: 'archiveCategory', id: tea, archived: false }]);
    expect((await list(me)).find((c) => c.id === tea)?.archived).toBe(false);
  });

  it.each<[string, (ids: { coffee: string; other: string }) => unknown, number, string?]>([
    [
      'a subcategory under a subcategory',
      ({ coffee }) => add(rowId(), 'Espresso', coffee),
      409,
      'Coffee is a subcategory itself',
    ],
    [
      'a move under a subcategory',
      ({ coffee }) => ({ op: 'updateCategory', id: groceries, parentId: coffee }),
      409,
    ],
    [
      'an income category under a spending one',
      () => add(rowId(), 'Bonus', food, 'income'),
      409,
      'Spending and income categories stay apart',
    ],
    [
      'a move under the other kind',
      () => ({ op: 'updateCategory', id: salary, parentId: food }),
      409,
    ],
    ['a category under itself', () => ({ op: 'updateCategory', id: food, parentId: food }), 409],
    [
      'moving one with subcategories under another',
      () => ({ op: 'updateCategory', id: food, parentId: groceries }),
      409,
      'Food has subcategories, so it stays at the top level',
    ],
    [
      "one under someone else's category",
      ({ other }) => add(rowId(), 'Mine', other),
      404,
      'Category not found',
    ],
    ['one under a category that does not exist', () => add(rowId(), 'Mine', rowId()), 404],
    [
      'one under nothing said',
      () => ({ op: 'addCategory', category: { id: rowId(), name: 'x', kind: 'expense' } }),
      400,
    ],
    ['an id of the wrong shape', () => add('ABC', 'Mine'), 400],
    ['an empty name', () => add(rowId(), '   '), 400],
    ['a name that is too long', () => add(rowId(), 'x'.repeat(41)), 400],
    ['a kind that does not exist', () => add(rowId(), 'Gold', null, 'savings'), 400],
    ['a field it does not know', () => ({ ...add(rowId(), 'x'), extra: 1 }), 400],
    ['changing the kind', () => ({ op: 'updateCategory', id: food, kind: 'income' }), 400],
    ['an update that changes nothing', () => ({ op: 'updateCategory', id: food }), 400],
    ['a place below 0', () => ({ op: 'updateCategory', id: food, position: -1 }), 400],
    ['a place in part', () => ({ op: 'updateCategory', id: food, position: 1.5 }), 400],
    [
      'archiving without saying which way',
      () => ({ op: 'archiveCategory', id: food, archived: 1 }),
      400,
    ],
    ['a category id already used', () => add(food, 'Again'), 409],
  ])('refuses %s, saving nothing', async (_what, change, status, error) => {
    const { me, coffee } = await withCoffee();
    const theirs = rowId();
    await send(person('other'), [add(theirs, 'Theirs')]);
    const before = await list(me);
    const res = await send(me, [change({ coffee, other: theirs })]);
    expect(res.status).toBe(status);
    if (error != null) expect(res.data).toEqual({ error });
    else expect(typeof res.data.error).toBe('string');
    expect(await list(me)).toEqual(before);
  });

  it('refuses a move under an archived category, and adding under one', async () => {
    const { me } = await withCoffee();
    await send(me, [{ op: 'archiveCategory', id: groceries, archived: true }]);
    const before = await list(me);
    for (const change of [
      add(rowId(), 'Veg', groceries),
      { op: 'updateCategory', id: transport, parentId: groceries },
    ]) {
      expect(await send(me, [change])).toEqual({
        status: 409,
        data: { error: 'Groceries is archived' },
      });
    }
    expect(await list(me)).toEqual(before);
  });

  it('keeps a category with archived subcategories at the top level too', async () => {
    const { me, coffee } = await withCoffee();
    await send(me, [{ op: 'archiveCategory', id: coffee, archived: true }]);
    const res = await send(me, [{ op: 'updateCategory', id: food, parentId: groceries }]);
    expect(res.status).toBe(409);
    expect((await list(me)).find((c) => c.id === food)?.parentId).toBeNull();
  });

  it("refuses someone else's category like one that doesn't exist, and leaves it alone", async () => {
    const [me, other] = [person('me'), person('other')];
    const theirs = rowId();
    await send(other, [add(theirs, 'Theirs')]);
    for (const change of [
      { op: 'updateCategory', id: theirs, name: 'Mine' },
      { op: 'archiveCategory', id: theirs, archived: true },
    ]) {
      expect(await send(me, [change])).toEqual({
        status: 404,
        data: { error: 'Category not found' },
      });
    }
    expect((await list(other)).find((c) => c.id === theirs)).toMatchObject({
      name: 'Theirs',
      archived: false,
    });
    // Nothing was saved for me, the defaults included
    expect(await list(me)).toEqual([]);
  });

  it('keeps to 200 categories, archived ones included', async () => {
    const me = person('me');
    // The 10 defaults and 190 more
    const more = Array.from({ length: 190 }, (_, i) => add(rowId(), `Category ${i}`));
    expect((await send(me, more)).status).toBe(200);
    await send(me, [{ op: 'archiveCategory', id: food, archived: true }]);
    expect(await send(me, [add(rowId(), 'One too many')])).toEqual({
      status: 409,
      data: { error: 'You can have up to 200 categories, archived ones included' },
    });
    expect(await list(me)).toHaveLength(200);
  });

  it('keeps to 50 subcategories under one category, archived ones included', async () => {
    const me = person('me');
    const fifty = Array.from({ length: 50 }, (_, i) => add(rowId(), `Sub ${i}`, food));
    expect((await send(me, fifty)).status).toBe(200);
    await send(me, [{ op: 'archiveCategory', id: fifty[0].category.id, archived: true }]);
    const full = {
      status: 409,
      data: { error: 'Food has 50 subcategories, the most it can have' },
    };
    expect(await send(me, [add(rowId(), 'Sub 51', food)])).toEqual(full);
    expect(await send(me, [{ op: 'updateCategory', id: transport, parentId: food }])).toEqual(full);
    expect(await under(me, food)).toHaveLength(50);
    expect((await list(me)).find((c) => c.id === transport)?.parentId).toBeNull();
  });

  it('counts a change sent again once', async () => {
    const me = person('me');
    const [coffee, changeId] = [rowId(), rowId()];
    expect((await send(me, [add(coffee, 'Coffee', food)], [changeId])).status).toBe(200);
    // Its answer lost, the app sends it again, with a move after it
    const again = await send(
      me,
      [add(coffee, 'Coffee', food), { op: 'updateCategory', id: coffee, parentId: null }],
      [changeId, rowId()],
    );
    expect(again).toEqual({ status: 200, data: { ok: true } });
    expect((await list(me)).filter((c) => c.name === 'Coffee')).toEqual([
      expect.objectContaining({ id: coffee, parentId: null }),
    ]);
    expect(await list(me)).toHaveLength(DEFAULT_CATEGORIES.length + 1);
  });

  it('saves a batch of account and category changes all or nothing, defaults included', async () => {
    const me = person('me');
    const [wallet, coffee] = [rowId(), rowId()];
    const res = await send(me, [
      { op: 'addAccount', account: { id: wallet, name: 'Wallet', kind: 'cash', openingCents: 0 } },
      add(coffee, 'Coffee', food),
      { op: 'updateCategory', id: food, name: 'Meals' },
      add(rowId(), 'Espresso', coffee),
    ]);
    expect(res).toEqual({ status: 409, data: { error: 'Coffee is a subcategory itself' } });
    expect(await ledger(me)).toEqual({ accounts: [], categories: [] });

    // In order, a later change can name a category added earlier in the batch
    const ok = await send(me, [
      { op: 'addAccount', account: { id: wallet, name: 'Wallet', kind: 'cash', openingCents: 0 } },
      add(coffee, 'Coffee'),
      { op: 'updateCategory', id: coffee, parentId: food },
      { op: 'archiveCategory', id: coffee, archived: true },
    ]);
    expect(ok.status).toBe(200);
    const after = await ledger(me);
    expect(after.accounts).toEqual([expect.objectContaining({ id: wallet })]);
    expect(after.categories.find((c) => c.id === coffee)).toMatchObject({
      parentId: food,
      archived: true,
      position: 0,
    });
  });

  it('holds one level deep in the database too, whatever writes there', async () => {
    const { me, coffee } = await withCoffee();
    const now = Date.now();
    const insertUnder = (parent: string, kind: string) =>
      api.sql(
        `INSERT INTO categories (email, id, name, kind, parent_id, position, created_at, updated_at)
         VALUES (?, ?, 'x', ?, ?, 9, ?, ?)`,
        me,
        rowId(),
        kind,
        parent,
        now,
        now,
      );
    await expect(insertUnder(coffee, 'expense')).rejects.toThrow(/one level deep/);
    await expect(insertUnder(food, 'income')).rejects.toThrow(/one level deep/);
    await expect(
      api.sql(
        'UPDATE categories SET parent_id = ? WHERE email = ? AND id = ?',
        groceries,
        me,
        food,
      ),
    ).rejects.toThrow(/one level deep/);
    // Someone else's category is never a parent
    const theirs = rowId();
    await send(person('other'), [add(theirs, 'Theirs')]);
    await expect(insertUnder(theirs, 'expense')).rejects.toThrow(/one level deep/);
  });
});

describe('transactions', () => {
  let ids = 0;
  /** A fresh row id, as the app makes them: 16 hex characters */
  const rowId = () => (++ids).toString(16).padStart(16, 'c');
  const send = (who: string, changes: unknown[], changeIds = changes.map(() => rowId())) =>
    api.call(who, 'POST', '/api/changes', { changes, ids: changeIds });
  const addAccount = (id: string, kind = 'cash', openingCents = 0, name = 'Wallet') => ({
    op: 'addAccount',
    account: { id, name, kind, openingCents },
  });
  const [food, transport] = DEFAULT_CATEGORIES.map((c) => c.id);
  const salary = DEFAULT_CATEGORIES.find((c) => c.name === 'Salary')!.id;
  const DAY = '2025-10-14';
  const add = (
    id: string,
    accountId: string,
    amountCents: number,
    more: Record<string, unknown> = {},
  ) => ({
    op: 'addTransaction',
    transaction: {
      id,
      kind: 'expense',
      accountId,
      amountCents,
      categoryId: food,
      payee: null,
      note: null,
      date: DAY,
      ...more,
    },
  });
  const page = (who: string, query: string) => api.call(who, 'GET', `/api/transactions?${query}`);
  const listed = async (who: string, account: string) => {
    const res = await page(who, `account=${account}`);
    expect(res.status).toBe(200);
    return res.data.transactions as { id: string; [k: string]: unknown }[];
  };
  const balances = async (who: string) => {
    const res = await api.call(who, 'GET', '/api/accounts');
    const accounts = res.data.accounts as { id: string; balanceCents: number }[];
    return Object.fromEntries(accounts.map((a) => [a.id, a.balanceCents]));
  };

  /** A person with a cash account holding RM 100 */
  async function withWallet() {
    const me = person('me');
    const wallet = rowId();
    expect((await send(me, [addAccount(wallet, 'cash', 10_000)])).status).toBe(200);
    return { me, wallet };
  }

  it('adds, edits and deletes a transaction, the balance following each', async () => {
    const { me, wallet } = await withWallet();
    const [coffee, pay] = [rowId(), rowId()];
    expect(
      await send(me, [add(coffee, wallet, 800, { payee: '  Kopi Corner ', note: ' ' })]),
    ).toEqual({ status: 200, data: { ok: true } });
    await send(me, [
      add(pay, wallet, 5_000, { kind: 'income', categoryId: salary, date: '2025-10-15' }),
    ]);
    expect((await balances(me))[wallet]).toBe(10_000 - 800 + 5_000);
    const [newest, older] = await listed(me, wallet);
    expect(newest).toMatchObject({ id: pay, kind: 'income', amountCents: 5_000 });
    expect(older).toEqual({
      id: coffee,
      kind: 'expense',
      accountId: wallet,
      amountCents: 800,
      categoryId: food,
      payee: 'Kopi Corner',
      note: null,
      date: DAY,
      createdAt: expect.any(Number),
    });

    await send(me, [
      { op: 'updateTransaction', id: coffee, amountCents: 1_250, payee: null, note: 'Two' },
    ]);
    expect((await balances(me))[wallet]).toBe(10_000 - 1_250 + 5_000);
    expect((await listed(me, wallet))[1]).toMatchObject({
      amountCents: 1_250,
      payee: null,
      note: 'Two',
      date: DAY,
    });

    await send(me, [{ op: 'removeTransaction', id: coffee }]);
    expect((await balances(me))[wallet]).toBe(15_000);
    expect((await listed(me, wallet)).map((t) => t.id)).toEqual([pay]);
    // Undo adds it again, with the same id
    expect((await send(me, [add(coffee, wallet, 1_250)])).status).toBe(200);
    expect((await listed(me, wallet)).map((t) => t.id)).toEqual([pay, coffee]);
    expect((await balances(me))[wallet]).toBe(10_000 - 1_250 + 5_000);
  });

  it('works out each kind of balance: spending on a card grows what is owed', async () => {
    const me = person('me');
    const [cash, bank, card] = [rowId(), rowId(), rowId()];
    await send(me, [
      addAccount(cash, 'cash', 5_000),
      addAccount(bank, 'bank', 100_000, 'Bank'),
      addAccount(card, 'card', -12_000, 'Visa'),
    ]);
    await send(me, [
      add(rowId(), cash, 800),
      add(rowId(), bank, 30_000, { kind: 'income', categoryId: salary }),
      add(rowId(), bank, 2_550, { categoryId: transport }),
      add(rowId(), card, 3_000),
      add(rowId(), card, 4_500),
      // A refund on the card takes what's owed down
      add(rowId(), card, 1_000, { kind: 'income', categoryId: salary }),
    ]);
    expect(await balances(me)).toEqual({
      [cash]: 4_200,
      [bank]: 127_450,
      [card]: -18_500,
    });
  });

  it('saves the defaults first when the first batch adds a transaction in one', async () => {
    const me = person('me');
    const [wallet, coffee] = [rowId(), rowId()];
    expect((await send(me, [addAccount(wallet), add(coffee, wallet, 800)])).status).toBe(200);
    expect((await listed(me, wallet)).map((t) => t.categoryId)).toEqual([food]);
    const { data } = await api.call(me, 'GET', '/api/accounts');
    expect(data.categories).toHaveLength(DEFAULT_CATEGORIES.length);
  });

  it('turns spending into income with an income category, and refuses it without', async () => {
    const { me, wallet } = await withWallet();
    const id = rowId();
    await send(me, [add(id, wallet, 800)]);
    expect(await send(me, [{ op: 'updateTransaction', id, kind: 'income' }])).toEqual({
      status: 409,
      data: { error: 'Income goes in an income category' },
    });
    expect((await balances(me))[wallet]).toBe(9_200);
    await send(me, [{ op: 'updateTransaction', id, kind: 'income', categoryId: salary }]);
    expect((await balances(me))[wallet]).toBe(10_800);
    expect((await listed(me, wallet))[0]).toMatchObject({ kind: 'income', categoryId: salary });
  });

  it('moves a transaction to another account, both balances following', async () => {
    const { me, wallet } = await withWallet();
    const [bank, id] = [rowId(), rowId()];
    await send(me, [addAccount(bank, 'bank', 0, 'Bank'), add(id, wallet, 800)]);
    await send(me, [{ op: 'updateTransaction', id, accountId: bank, date: '2025-10-01' }]);
    expect(await balances(me)).toEqual({ [wallet]: 10_000, [bank]: -800 });
    expect(await listed(me, wallet)).toEqual([]);
    expect(await listed(me, bank)).toEqual([expect.objectContaining({ id, date: '2025-10-01' })]);
  });

  const tomorrow = rateDay(Date.now() + 864e5);
  const inTwoDays = rateDay(Date.now() + 2 * 864e5);

  it.each<[string, (ids: Record<string, string>) => unknown, number, string]>([
    [
      "someone else's account",
      ({ theirAccount }) => add(rowId(), theirAccount, 800),
      404,
      'Account not found',
    ],
    [
      "someone else's category",
      ({ wallet, theirCategory }) => add(rowId(), wallet, 800, { categoryId: theirCategory }),
      404,
      'Category not found',
    ],
    [
      'an archived account',
      ({ archived }) => add(rowId(), archived, 800),
      409,
      'Old purse is archived',
    ],
    [
      'an archived category',
      ({ wallet }) => add(rowId(), wallet, 800, { categoryId: transport }),
      409,
      'Transport is archived',
    ],
    [
      'spending in an income category',
      ({ wallet }) => add(rowId(), wallet, 800, { categoryId: salary }),
      409,
      'Spending goes in a spending category',
    ],
    [
      'income in a spending category',
      ({ wallet }) => add(rowId(), wallet, 800, { kind: 'income' }),
      409,
      'Income goes in an income category',
    ],
    [
      'no category',
      ({ wallet }) => add(rowId(), wallet, 800, { categoryId: null }),
      400,
      'Pick a category',
    ],
    [
      'an amount of 0',
      ({ wallet }) => add(rowId(), wallet, 0),
      400,
      'An amount is more than 0 and up to 10,000,000',
    ],
    [
      'an amount below 0',
      ({ wallet }) => add(rowId(), wallet, -800),
      400,
      'An amount is more than 0 and up to 10,000,000',
    ],
    [
      'an amount over the most',
      ({ wallet }) => add(rowId(), wallet, 1_000_000_001),
      400,
      'An amount is more than 0 and up to 10,000,000',
    ],
    [
      'an amount in part cents',
      ({ wallet }) => add(rowId(), wallet, 80.5),
      400,
      'An amount is more than 0 and up to 10,000,000',
    ],
    [
      'a day that does not exist',
      ({ wallet }) => add(rowId(), wallet, 8, { date: '2025-02-29' }),
      400,
      'Give a day from 2000 up to today',
    ],
    [
      'a day before 2000',
      ({ wallet }) => add(rowId(), wallet, 8, { date: '1999-12-31' }),
      400,
      'Give a day from 2000 up to today',
    ],
    [
      'a day two days ahead',
      ({ wallet }) => add(rowId(), wallet, 8, { date: inTwoDays }),
      400,
      'Give a day from 2000 up to today',
    ],
    [
      'a day of the wrong shape',
      ({ wallet }) => add(rowId(), wallet, 8, { date: '14/10/2025' }),
      400,
      'Give a day from 2000 up to today',
    ],
    [
      'a payee that is too long',
      ({ wallet }) => add(rowId(), wallet, 8, { payee: 'x'.repeat(81) }),
      400,
      'A payee can be up to 80 characters',
    ],
    [
      'a payee that is not text',
      ({ wallet }) => add(rowId(), wallet, 8, { payee: 7 }),
      400,
      'A payee can be up to 80 characters',
    ],
    [
      'a note that is too long',
      ({ wallet }) => add(rowId(), wallet, 8, { note: 'x'.repeat(501) }),
      400,
      'A note can be up to 500 characters',
    ],
    [
      'a transfer, for now',
      ({ wallet }) => add(rowId(), wallet, 8, { kind: 'transfer', categoryId: null }),
      400,
      "Transfers can't be saved yet",
    ],
    [
      'a kind that does not exist',
      ({ wallet }) => add(rowId(), wallet, 8, { kind: 'gift' }),
      400,
      'Unknown kind of transaction',
    ],
    [
      'a field it does not know',
      ({ wallet }) => add(rowId(), wallet, 8, { tip: 1 }),
      400,
      'Unknown field tip',
    ],
    [
      'an id of the wrong shape',
      ({ wallet }) => add('ABC', wallet, 8),
      400,
      'Invalid transaction id',
    ],
    [
      'an id already used',
      ({ wallet, mine }) => add(mine, wallet, 8),
      409,
      'That transaction already exists',
    ],
    [
      'a change to one that does not exist',
      () => ({ op: 'updateTransaction', id: rowId(), amountCents: 5 }),
      404,
      'Transaction not found',
    ],
    [
      "a change to someone else's",
      ({ theirs }) => ({ op: 'updateTransaction', id: theirs, amountCents: 5 }),
      404,
      'Transaction not found',
    ],
    [
      "deleting someone else's",
      ({ theirs }) => ({ op: 'removeTransaction', id: theirs }),
      404,
      'Transaction not found',
    ],
    [
      'a change that changes nothing',
      ({ mine }) => ({ op: 'updateTransaction', id: mine }),
      400,
      'Nothing to change',
    ],
    [
      'a change into a transfer',
      ({ mine }) => ({ op: 'updateTransaction', id: mine, kind: 'transfer', categoryId: null }),
      400,
      "Transfers can't be saved yet",
    ],
    [
      'a move to an archived account',
      ({ mine, archived }) => ({ op: 'updateTransaction', id: mine, accountId: archived }),
      409,
      'Old purse is archived',
    ],
    [
      'a change to an amount over the most',
      ({ mine }) => ({ op: 'updateTransaction', id: mine, amountCents: 1_000_000_001 }),
      400,
      'An amount is more than 0 and up to 10,000,000',
    ],
  ])('refuses %s, saving nothing', async (_what, change, status, error) => {
    const { me, wallet } = await withWallet();
    const [archived, mine] = [rowId(), rowId()];
    await send(me, [
      addAccount(archived, 'cash', 0, 'Old purse'),
      { op: 'archiveAccount', id: archived, archived: true },
      { op: 'archiveCategory', id: transport, archived: true },
      add(mine, wallet, 500),
    ]);
    const other = person('other');
    const [theirAccount, theirCategory, theirs] = [rowId(), rowId(), rowId()];
    await send(other, [
      addAccount(theirAccount),
      {
        op: 'addCategory',
        category: { id: theirCategory, name: 'Theirs', kind: 'expense', parentId: null },
      },
      add(theirs, theirAccount, 300),
    ]);
    const before = [await listed(me, wallet), await balances(me)];

    const res = await send(me, [
      change({ wallet, archived, mine, theirAccount, theirCategory, theirs }),
    ]);
    expect(res).toEqual({ status, data: { error } });
    expect([await listed(me, wallet), await balances(me)]).toEqual(before);
    expect(await listed(other, theirAccount)).toEqual([
      expect.objectContaining({ id: theirs, amountCents: 300 }),
    ]);
  });

  it('takes tomorrow in UTC, which is already today for people ahead of it', async () => {
    const { me, wallet } = await withWallet();
    expect((await send(me, [add(rowId(), wallet, 800, { date: tomorrow })])).status).toBe(200);
  });

  it('pages newest first by a cursor, never skipping or repeating ones on the same day', async () => {
    const { me, wallet } = await withWallet();
    // Saved in one batch, so the five on the same day were saved at the same moment too
    const sameDay = Array.from({ length: 5 }, () => rowId());
    const [older, newer] = [rowId(), rowId()];
    await send(me, [
      add(older, wallet, 1, { date: '2025-10-01' }),
      ...sameDay.map((id) => add(id, wallet, 2)),
      add(newer, wallet, 3, { date: '2025-10-20' }),
    ]);
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const query: string = `account=${wallet}&limit=2${before == null ? '' : `&before=${encodeURIComponent(before)}`}`;
      const res = await page(me, query);
      expect(res.status).toBe(200);
      expect(res.data.transactions.length).toBeLessThanOrEqual(2);
      seen.push(...res.data.transactions.map((t: { id: string }) => t.id));
      before = res.data.nextBefore;
      pages++;
    } while (before != null);
    expect(pages).toBe(4);
    expect(seen).toEqual([newer, ...[...sameDay].reverse(), older]);
    // Fifty to a page unless asked
    expect((await page(me, `account=${wallet}`)).data).toMatchObject({ nextBefore: null });
  });

  it('lists a month across every account, and only the person’s own', async () => {
    const { me, wallet } = await withWallet();
    const bank = rowId();
    const [october, alsoOctober, november] = [rowId(), rowId(), rowId()];
    await send(me, [
      addAccount(bank, 'bank', 0, 'Bank'),
      add(october, wallet, 1, { date: '2025-10-01' }),
      add(alsoOctober, bank, 2, { date: '2025-10-31' }),
      add(november, wallet, 3, { date: '2025-11-01' }),
    ]);
    const other = person('other');
    const theirs = rowId();
    await send(other, [addAccount(theirs), add(rowId(), theirs, 4, { date: '2025-10-15' })]);
    const res = await page(me, 'month=2025-10');
    expect(res.status).toBe(200);
    expect(res.data.transactions.map((t: { id: string }) => t.id)).toEqual([alsoOctober, october]);
    expect((await page(me, 'month=2025-09')).data.transactions).toEqual([]);
  });

  it.each([
    ['nothing to list', ''],
    ['both an account and a month', `account=${'c'.repeat(16)}&month=2025-10`],
    ['a month of the wrong shape', 'month=2025-13'],
    ['a limit of 0', 'month=2025-10&limit=0'],
    ['a limit over 200', 'month=2025-10&limit=201'],
    ['a limit that is not a number', 'month=2025-10&limit=lots'],
    ['a cursor of the wrong shape', 'month=2025-10&before=yesterday'],
  ])('refuses a list with %s', async (_what, query) => {
    const res = await page(person('me'), query);
    expect(res.status).toBe(400);
    expect(typeof res.data.error).toBe('string');
  });

  describe("a month's totals", () => {
    const summary = (who: string, month: string) =>
      api.call(who, 'GET', `/api/summary?month=${month}`);

    it('sums spending and income by category; transfers, other months and other people never count', async () => {
      const { me, wallet } = await withWallet();
      const [bank, coffee] = [rowId(), rowId()];
      await send(me, [
        addAccount(bank, 'bank', 0, 'Bank'),
        {
          op: 'addCategory',
          category: { id: coffee, name: 'Coffee', kind: 'expense', parentId: food },
        },
        add(rowId(), wallet, 800, { date: '2025-10-01' }),
        add(rowId(), bank, 300, { date: '2025-10-31', categoryId: coffee }),
        add(rowId(), wallet, 200, { date: '2025-10-20', categoryId: coffee }),
        add(rowId(), wallet, 120, { date: '2025-10-15', categoryId: transport }),
        add(rowId(), bank, 5_000, { kind: 'income', categoryId: salary, date: '2025-10-25' }),
        // Either side of the month
        add(rowId(), wallet, 7_000, { date: '2025-09-30' }),
        add(rowId(), wallet, 9_000, { date: '2025-11-01' }),
      ]);
      // A transfer between the person's own accounts, written straight to the database so
      // this holds whether or not the Worker saves transfers yet
      await api.sql(
        `INSERT INTO transactions (email, id, kind, account_id, to_account_id, amount_cents,
                                   category_id, date, created_at, updated_at)
         VALUES (?, ?, 'transfer', ?, ?, 40000, NULL, '2025-10-10', 0, 0)`,
        me,
        rowId(),
        wallet,
        bank,
      );
      const other = person('other');
      const theirs = rowId();
      await send(other, [addAccount(theirs), add(rowId(), theirs, 6_600, { date: '2025-10-15' })]);

      expect(await summary(me, '2025-10')).toEqual({
        status: 200,
        data: {
          month: '2025-10',
          incomeCents: 5_000,
          spentCents: 1_420,
          leftCents: 3_580,
          // A subcategory's spending under its own id, never added into its parent's
          spentByCategory: [
            { categoryId: food, cents: 800 },
            { categoryId: coffee, cents: 500 },
            { categoryId: transport, cents: 120 },
          ],
          incomeByCategory: [{ categoryId: salary, cents: 5_000 }],
        },
      });
      // A month with nothing in it, and more spent than came in
      expect((await summary(me, '2025-08')).data).toEqual({
        month: '2025-08',
        incomeCents: 0,
        spentCents: 0,
        leftCents: 0,
        spentByCategory: [],
        incomeByCategory: [],
      });
      expect((await summary(me, '2025-11')).data).toMatchObject({ leftCents: -9_000 });
    });

    it.each([
      ['no month', ''],
      ['a month of the wrong shape', '?month=2025-13'],
      ['a day instead of a month', '?month=2025-10-01'],
      ['a month before 2000', '?month=1999-12'],
    ])('refuses %s', async (_what, query) => {
      const res = await api.call(person('me'), 'GET', `/api/summary${query}`);
      expect(res).toEqual({ status: 400, data: { error: 'Give a month from 2000, like 2026-11' } });
    });
  });

  it("answers someone else's account as one that doesn't exist", async () => {
    const other = person('other');
    const theirs = rowId();
    await send(other, [addAccount(theirs), add(rowId(), theirs, 800)]);
    const res = await page(person('me'), `account=${theirs}`);
    expect(res).toEqual({ status: 404, data: { error: 'Account not found' } });
  });

  it('keeps to 100,000 transactions on an account, every kind counted', async () => {
    const { me, wallet } = await withWallet();
    const bank = rowId();
    const moving = rowId();
    await send(me, [addAccount(bank, 'bank', 0, 'Bank'), add(moving, bank, 1)]);
    // All but one of them, written straight to the database
    await api.sql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 99999)
       INSERT INTO transactions (email, id, kind, account_id, amount_cents, category_id,
                                 date, created_at, updated_at)
       SELECT ?, printf('%016x', i), CASE WHEN i % 2 THEN 'expense' ELSE 'income' END, ?,
              1, CASE WHEN i % 2 THEN ? ELSE ? END, '2025-01-01', 0, 0
       FROM n`,
      me,
      wallet,
      food,
      salary,
    );
    const full = {
      status: 409,
      data: { error: 'An account can hold up to 100,000 transactions' },
    };
    expect(await send(me, [add(rowId(), wallet, 1), add(rowId(), wallet, 1)])).toEqual(full);
    expect((await send(me, [add(rowId(), wallet, 1)])).status).toBe(200);
    expect(await send(me, [add(rowId(), wallet, 1)])).toEqual(full);
    expect(await send(me, [{ op: 'updateTransaction', id: moving, accountId: wallet }])).toEqual(
      full,
    );
    // Room again once one is deleted, and other accounts are never held back
    const [first] = await listed(me, wallet);
    expect(
      (
        await send(me, [
          { op: 'removeTransaction', id: first.id },
          { op: 'updateTransaction', id: moving, accountId: wallet },
          add(rowId(), bank, 1),
        ])
      ).status,
    ).toBe(200);
  }, 60_000);

  it('counts a transaction sent again once', async () => {
    const { me, wallet } = await withWallet();
    const [coffee, changeId] = [rowId(), rowId()];
    await send(me, [add(coffee, wallet, 800)], [changeId]);
    // Its answer lost, the app sends it again, with an edit after it
    const again = await send(
      me,
      [add(coffee, wallet, 800), { op: 'updateTransaction', id: coffee, amountCents: 900 }],
      [changeId, rowId()],
    );
    expect(again).toEqual({ status: 200, data: { ok: true } });
    expect(await listed(me, wallet)).toEqual([expect.objectContaining({ amountCents: 900 })]);
    expect((await balances(me))[wallet]).toBe(9_100);
  });

  it('saves a batch of accounts, categories and transactions all or nothing', async () => {
    const me = person('me');
    const [wallet, coffee] = [rowId(), rowId()];
    const res = await send(me, [
      addAccount(wallet),
      {
        op: 'addCategory',
        category: { id: coffee, name: 'Coffee', kind: 'expense', parentId: food },
      },
      add(rowId(), wallet, 800, { categoryId: coffee }),
      add(rowId(), wallet, 0),
    ]);
    expect(res.status).toBe(400);
    expect((await api.call(me, 'GET', '/api/accounts')).data).toEqual({
      accounts: [],
      categories: [],
    });

    // In order, a transaction can follow the account and subcategory added before it
    const ok = await send(me, [
      addAccount(wallet),
      {
        op: 'addCategory',
        category: { id: coffee, name: 'Coffee', kind: 'expense', parentId: food },
      },
      add(rowId(), wallet, 800, { categoryId: coffee }),
    ]);
    expect(ok.status).toBe(200);
    expect(await listed(me, wallet)).toEqual([expect.objectContaining({ categoryId: coffee })]);
  });
});
