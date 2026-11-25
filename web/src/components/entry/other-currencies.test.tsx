// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { ChangesBody, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer, Within } from '../../testing/app';
import {
  addButton,
  addForm,
  addSaveButton,
  fakeServer,
  reloadApp,
  renderApp,
  settle,
  setupAppTests,
  typeAmount,
} from '../../testing/app';
import { pick } from '../../testing/pick';

// Other currencies (owner request 2026-11-19; R-Set-Money's "Other currencies", R-Add,
// R-Desk-Add): the person keeps a short list of other currencies in Settings › Money, in
// their order. In Add, the amount's currency is a pill before the figure, marked as opening
// a list: a tap opens every currency, the main currency and the list first, then the ones
// used today, so a one-off is found with ordinary taps (owner audit 2026-11-20). Typing in another one says what it comes
// to in the main currency at today's rate (the rate and its source on a tap), from the
// last rate known when offline; the entry is sent in that currency and the server converts
// it at its own day's rate, keeping what was typed. Entries show both amounts. Travel
// sense opens Add in the currency of where the device is, or the one the last two entries
// today were in, for the rest of the day; it can be turned off. Figures are made up.

vi.hoisted(() => {
  process.env.TZ = 'Asia/Kuala_Lumpur';
});

setupAppTests();

const SIZES = ['phone', 'desktop'] as const;
const WALLET = 'a'.repeat(16);
const FOOD = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;
const TODAY = '2026-11-19';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 19, 10, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A wallet with RM 100, the default categories, and these other currencies */
function withWallet(others: string[] = []): FakeServer {
  const server = fakeServer();
  server.accounts.push({
    id: WALLET,
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 10_000,
    position: 0,
    archived: false,
  });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  server.me.settings = { ...server.me.settings, otherCurrencies: others };
  server.rates.set('THBMYR', 0.1275);
  server.rates.set('USDMYR', 4.5);
  return server;
}

/** An entry typed as THB 120.00, saved as RM 15.30 */
function withThbEntry(server: FakeServer, more: Partial<Transaction> = {}) {
  server.transactions.push({
    id: 'd'.repeat(16),
    kind: 'expense',
    accountId: WALLET,
    toAccountId: null,
    amountCents: 1_530,
    categoryId: FOOD,
    payee: 'Night market',
    note: null,
    date: TODAY,
    createdAt: 1,
    original: {
      currency: 'THB',
      cents: 12_000,
      rate: 0.1275,
      source: 'frankfurter',
      at: Date.parse(`${TODAY}T12:00:00Z`),
    },
    ...more,
  });
}

/** The device says it's in `zone` */
function deviceIn(zone: string) {
  const real = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, 'resolvedOptions')!
    .value as (this: Intl.DateTimeFormat) => Intl.ResolvedDateTimeFormatOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...real.call(this), timeZone: zone };
  });
}

function goOffline(server: FakeServer) {
  server.health = 'unreachable';
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  onTestFinished(() => onLine.mockRestore());
  act(() => void window.dispatchEvent(new Event('offline')));
  return () => {
    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
  };
}

/** Every batch of changes the app has sent, as sent */
const sentBodies = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => url === '/api/changes' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(init?.body as string) as ChangesBody);

const optionNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole('option')
    .map((o) => o.textContent);

const moneyCard = async () => within(await screen.findByRole('region', { name: 'Money' }));

/** The chips in the list, in order */
const chips = async () =>
  within((await moneyCard()).getByRole('list', { name: 'Other currencies' }))
    .queryAllByRole('listitem')
    .map((li) => li.textContent);

async function openAdd() {
  const user = userEvent.setup();
  await user.click(await addButton());
  return { user, form: await addForm() };
}

const pill = (form: Within) => form.getByRole('button', { name: /, currency$/ });

/** Taps the pill and picks `code` from the list; Add's form as drawn after */
async function inCurrency(user: ReturnType<typeof userEvent.setup>, form: Within, code: string) {
  await user.click(pill(form));
  await user.click(await screen.findByRole('option', { name: new RegExp(`^${code}`) }));
  await waitFor(() => expect(screen.queryByRole('listbox', { name: 'All currencies' })).toBeNull());
  return addForm();
}

describe('Settings › Money › Other currencies', () => {
  test.each(SIZES)('adds from a searchable list, reorders and removes (%s)', async (size) => {
    const server = withWallet();
    renderApp(server, '/?settings=money', { size });
    const user = userEvent.setup();
    const card = await moneyCard();
    expect(card.getByText('Other currencies')).toBeTruthy();
    expect(card.getByText('Each entry keeps its rate')).toBeTruthy();
    expect(await chips()).toEqual([]);

    const add = async (search: string, code: RegExp) => {
      await user.click(card.getByRole('button', { name: 'Add a currency' }));
      const dialog = within(await screen.findByRole('dialog', { name: 'Add a currency' }));
      const box = dialog.getByRole('searchbox', { name: 'Search currencies' });
      expect(box.getAttribute('placeholder')).toBe('Search by name or code');
      await user.type(box, search);
      await user.click(dialog.getByRole('option', { name: code }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Add a currency' })).toBeNull(),
      );
    };
    await add('baht', /^THB/);
    await waitFor(() => expect(server.me.settings.otherCurrencies).toEqual(['THB']));
    await add('usd', /^USD/);
    await waitFor(() => expect(server.me.settings.otherCurrencies).toEqual(['THB', 'USD']));
    expect(await chips()).toEqual(['THB', 'USD']);

    // The main currency and the ones added already aren't offered again
    await user.click(card.getByRole('button', { name: 'Add a currency' }));
    const all = within(await screen.findByRole('dialog', { name: 'Add a currency' })).getByRole(
      'listbox',
      { name: 'All currencies' },
    );
    expect(optionNames(all)).toEqual(expect.arrayContaining(['VNDVietnamese dong₫']));
    expect(optionNames(all).filter((o) => /^(MYR|THB|USD)/.test(o ?? ''))).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add a currency' })).toBeNull(),
    );

    await user.click(card.getByRole('button', { name: 'USD, US dollar' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move earlier' }));
    await waitFor(() => expect(server.me.settings.otherCurrencies).toEqual(['USD', 'THB']));
    expect(await chips()).toEqual(['USD', 'THB']);

    await user.click(card.getByRole('button', { name: 'THB, Thai baht' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove THB' }));
    await waitFor(() => expect(server.me.settings.otherCurrencies).toEqual(['USD']));
    expect(await chips()).toEqual(['USD']);
  });

  test('stops at eight, saying so', async () => {
    const eight = ['THB', 'USD', 'SGD', 'JPY', 'EUR', 'GBP', 'AUD', 'IDR'];
    renderApp(withWallet(eight), '/?settings=money', { size: 'phone' });
    const card = await moneyCard();
    expect(await chips()).toEqual(eight);
    expect(card.getByRole<HTMLButtonElement>('button', { name: 'Add a currency' }).disabled).toBe(
      true,
    );
    expect(card.getByText('Up to 8 other currencies')).toBeTruthy();
  });

  test.each(SIZES)(
    'Follow where I am is on, can be turned off, and needs a list (%s)',
    async (size) => {
      const server = withWallet();
      renderApp(server, '/?settings=money', { size });
      const card = await moneyCard();
      await screen.findByText('Other currencies');
      expect(card.queryByRole('switch', { name: 'Follow where I am' })).toBeNull();

      server.me.settings = { ...server.me.settings, otherCurrencies: ['THB'] };
      await reloadApp(server, '/?settings=money', { size });
      const again = await moneyCard();
      expect(again.getByText('Add opens in the local currency for the day')).toBeTruthy();
      const on = again.getByRole<HTMLInputElement>('switch', { name: 'Follow where I am' });
      expect(on.checked).toBe(true);
      await userEvent.setup().click(on);
      await waitFor(() => expect(server.me.settings.travelSense).toBe(false));
    },
  );
});

describe('Add in another currency', () => {
  test.each(SIZES)(
    'one tap on the pill opens every currency, the main one and yours first (%s)',
    async (size) => {
      // Only the main currency offered: a first foreign entry
      renderApp(withWallet(), '/', { size });
      const { user, form } = await openAdd();
      const button = pill(form);
      expect(button.textContent).toBe('RM');
      // Marked as opening a list, with an arrow drawn beside the currency
      expect(button.getAttribute('aria-haspopup')).toBe('listbox');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.querySelector('svg')).not.toBeNull();
      await user.click(button);
      const all = await screen.findByRole('listbox', { name: 'All currencies' });
      expect(optionNames(screen.getByRole('listbox', { name: 'Yours' }))).toEqual([
        'MYRMalaysian ringgitRM',
      ]);
      expect(optionNames(all)).toEqual(expect.arrayContaining(['JPYJapanese yen¥']));
      await user.type(screen.getByRole('searchbox', { name: 'Search currencies' }), 'baht');
      await user.click(screen.getByRole('option', { name: /^THB/ }));
      await waitFor(() =>
        expect(screen.queryByRole('listbox', { name: 'All currencies' })).toBeNull(),
      );
      const open = await addForm();
      expect(pill(open).getAttribute('aria-label')).toBe('THB, currency');
      expect(pill(open).textContent).toBe('THB');
      // Another tap opens the list again, never stepping to another currency
      await user.click(pill(open));
      expect(await screen.findByRole('listbox', { name: 'All currencies' })).toBeTruthy();
      expect(screen.getByRole('option', { name: /^THB/ }).getAttribute('aria-selected')).toBe(
        'true',
      );
    },
  );

  test.each(SIZES)(
    'the list starts with your currencies, then the ones used today (%s)',
    async (size) => {
      const server = withWallet(['USD']);
      renderApp(server, '/', { size });
      let { user, form } = await openAdd();
      form = await inCurrency(user, form, 'THB');
      await typeAmount(form, '50');
      await user.click(addSaveButton(form));
      await waitFor(() => expect(server.transactions).toHaveLength(1));

      ({ user, form } = await openAdd());
      await user.click(pill(form));
      expect(optionNames(await screen.findByRole('listbox', { name: 'Yours' }))).toEqual([
        'MYRMalaysian ringgitRM',
        'USDUS dollar$',
      ]);
      expect(optionNames(screen.getByRole('listbox', { name: 'Used today' }))).toEqual([
        'THBThai baht฿',
      ]);
      expect(optionNames(screen.getByRole('listbox', { name: 'All currencies' }))).not.toContain(
        'THBThai baht฿',
      );
    },
  );

  test('from the keyboard, Enter on the pill opens the list', async () => {
    renderApp(withWallet(['THB']), '/', { size: 'desktop' });
    const { user, form } = await openAdd();
    pill(form).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('listbox', { name: 'All currencies' })).toBeTruthy();
    expect(pill(form).getAttribute('aria-expanded')).toBe('true');
  });

  test.each(SIZES)('Alt+Down on the pill opens the list too (%s)', async (size) => {
    renderApp(withWallet(['THB']), '/', { size });
    const { user, form } = await openAdd();
    expect(pill(form).getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowDown');
    pill(form).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(await screen.findByRole('listbox', { name: 'All currencies' })).toBeTruthy();
  });

  test('the pill is named by what it shows', async () => {
    renderApp(withWallet(['THB']), '/', { size: 'phone' });
    const { user, form } = await openAdd();
    await user.click(form.getByRole('radio', { name: 'Income' }));
    const button = pill(form);
    expect(button.textContent).toBe('+ RM');
    expect(button.getAttribute('aria-label')).toBe('+ RM, currency');
  });

  test('a backdated entry says it is saved at its own day’s rate', async () => {
    const server = withWallet(['THB']);
    renderApp(server, '/', { size: 'desktop' });
    const { user, form: opened } = await openAdd();
    const form = await inCurrency(user, opened, 'THB');
    await typeAmount(form, '120');
    await user.click(form.getByRole('button', { name: /^Today/ }));
    fireEvent.change(form.getByLabelText('Date'), { target: { value: '2026-11-12' } });
    expect(
      await form.findByRole('button', {
        name: "about RM 15.30 at today's rate, saved at the rate of Nov 12",
      }),
    ).toBeTruthy();
  });

  test.each(SIZES)(
    "says what it comes to at today's rate, then saves what was typed (%s)",
    async (size) => {
      const server = withWallet(['THB']);
      renderApp(server, '/', { size });
      const { user, form: opened } = await openAdd();
      const form = await inCurrency(user, opened, 'THB');
      await typeAmount(form, '120');
      expect(form.getByRole('status', { name: /^Amount, / }).getAttribute('aria-label')).toBe(
        'Amount, THB 120.00',
      );
      const hint = await form.findByRole('button', { name: "about RM 15.30 at today's rate" });
      await user.click(hint);
      expect(form.getByText('1 THB = 0.1275 MYR, from Wise')).toBeTruthy();
      const save = addSaveButton(form);
      expect(save.textContent).toContain('Save THB 120.00');
      await user.click(save);
      await waitFor(() => expect(server.transactions).toHaveLength(1));
      expect(server.transactions[0]).toMatchObject({
        amountCents: 1_530,
        original: { currency: 'THB', cents: 12_000, rate: 0.1275, source: 'wise' },
      });
      const body = sentBodies().find((b) => b.changes.some((c) => c.op === 'addTransaction'))!;
      expect(body.changes).toEqual([
        expect.objectContaining({
          op: 'addTransaction',
          transaction: expect.objectContaining({ amountCents: 12_000, date: TODAY }),
        }),
      ]);
      expect(body.currencies).toEqual(['THB']);
    },
  );

  test.each(SIZES)(
    'takes a figure past 10,000,000 in another currency when what it comes to fits (%s)',
    async (size) => {
      const server = withWallet(['IDR']);
      server.rates.set('IDRMYR', 0.00028);
      renderApp(server, '/', { size });
      const { user, form: opened } = await openAdd();
      const form = await inCurrency(user, opened, 'IDR');
      await typeAmount(form, '15000000');
      expect(
        await form.findByRole('button', { name: "about RM 4,200.00 at today's rate" }),
      ).toBeTruthy();
      const save = addSaveButton(form);
      expect(save.textContent).toMatch(/^Save IDR 15,000,000/);
      await user.click(save);
      await waitFor(() => expect(server.transactions).toHaveLength(1));
      expect(server.transactions[0]).toMatchObject({
        amountCents: 420_000,
        original: { currency: 'IDR', cents: 1_500_000_000 },
      });
    },
  );

  test('refuses a figure that comes to more than an entry can be, naming the limit', async () => {
    const server = withWallet(['EUR']);
    server.rates.set('EURMYR', 4.9);
    renderApp(server, '/', { size: 'phone' });
    const { user, form: opened } = await openAdd();
    let form = await inCurrency(user, opened, 'EUR');
    await typeAmount(form, '12000000');
    const save = await form.findByRole('button', { name: /^Comes to more than/ });
    expect(save.textContent).toBe('Comes to more than 10,000,000 MYR');
    expect(save.getAttribute('aria-disabled')).toBe('true');
    // Back in ringgit, the figure is past its own limit
    form = await inCurrency(user, form, 'MYR');
    expect(form.getByRole('button', { name: 'Up to 10,000,000' })).toBeTruthy();
    await user.click(form.getByRole('button', { name: 'Up to 10,000,000' }));
    await settle();
    expect(server.transactions).toEqual([]);
  });

  test('offline, the hint uses the last rate known, and the entry is saved once back', async () => {
    const server = withWallet(['THB']);
    renderApp(server, '/', { size: 'phone' });
    let { user, form } = await openAdd();
    form = await inCurrency(user, form, 'THB');
    await typeAmount(form, '1');
    await form.findByRole('button', { name: "about RM 0.13 at today's rate" });
    await user.click(form.getByRole('button', { name: 'Keep draft and close' }));
    await settle();

    const back = goOffline(server);
    await reloadApp(server, '/', { size: 'phone' });
    ({ user, form } = await openAdd());
    // The draft kept what it was typed in
    expect(pill(form).getAttribute('aria-label')).toBe('THB, currency');
    await user.click(form.getByRole('button', { name: 'Delete, hold to clear' }));
    await typeAmount(form, '120');
    expect(
      await form.findByRole('button', { name: 'about RM 15.30 at the last rate known' }),
    ).toBeTruthy();
    await user.click(addSaveButton(form));
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );
    expect(server.transactions).toEqual([]);

    back();
    await waitFor(() => expect(server.transactions).toHaveLength(1), { timeout: 10_000 });
    expect(server.transactions[0]).toMatchObject({
      amountCents: 1_530,
      original: { currency: 'THB', cents: 12_000 },
    });
  });

  test('online, a currency with no rate still needs one: never saved as pending', async () => {
    // JPY has no rate anywhere: the lookup fails while the connection is fine
    const server = withWallet(['JPY']);
    renderApp(server, '/', { size: 'phone' });
    const { user, form: opened } = await openAdd();
    const form = await inCurrency(user, opened, 'JPY');
    await typeAmount(form, '500');
    const save = await form.findByRole('button', { name: 'Needs a rate for JPY' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(form.queryByText(/Conversion pending/)).toBeNull();
    await user.click(save);
    await settle();
    expect(sentBodies()).toEqual([]);
  });

  test('offline with no rate for it, saves what was typed with conversion pending, then converts it once at its own day’s rate', async () => {
    const server = withWallet(['THB']);
    // Never asked for on this device: the rate on the entry's own day differs from today's
    server.rates.set('THBMYR@2026-11-12', 0.12);
    renderApp(server, `/?account=${WALLET}`, { size: 'phone' });
    await screen.findByLabelText('Balance RM 100.00');
    // Opened again as a fresh page, so the ledger read below is the one this page runs
    await reloadApp(server, `/?account=${WALLET}`, { size: 'phone' });
    expect(await screen.findByLabelText('Balance RM 100.00')).toBeTruthy();
    // The history downloaded, as the app does in the background once online
    const { syncHistory } = await import('../../ledger/ledger');
    await act(() => syncHistory());
    const back = goOffline(server);

    const { user, form: opened } = await openAdd();
    const form = await inCurrency(user, opened, 'THB');
    await typeAmount(form, '120');
    await user.click(form.getByRole('button', { name: /^Today/ }));
    fireEvent.change(form.getByLabelText('Date'), { target: { value: '2026-11-12' } });
    expect(
      await form.findByText('Conversion pending: converted at the rate of Nov 12 once online'),
    ).toBeTruthy();
    const save = addSaveButton(form);
    expect(save.textContent).toContain('Save THB 120.00');
    expect(save.getAttribute('aria-disabled')).not.toBe('true');
    await user.click(save);
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );

    // Closed and opened again offline: still there, as typed, and out of the balance
    await reloadApp(server, `/?account=${WALLET}`, { size: 'phone' });
    const entry = await screen.findByRole('button', {
      name: /, −THB 120\.00, conversion pending$/,
    });
    expect(within(entry).getByText('−THB 120.00')).toBeTruthy();
    expect(within(entry).getByText('conversion pending')).toBeTruthy();
    expect(screen.getByLabelText('Balance RM 100.00')).toBeTruthy();
    expect(server.transactions).toEqual([]);
    // Activity offline, from the history kept on the device, lists it the same way
    await reloadApp(server, '/?activity', { size: 'phone' });
    const listed = await screen.findByRole(
      'button',
      { name: /, −THB 120\.00, conversion pending$/ },
      { timeout: 6000 },
    );
    expect(within(listed).getByText('conversion pending')).toBeTruthy();
    await reloadApp(server, `/?account=${WALLET}`, { size: 'phone' });
    await screen.findByLabelText('Balance RM 100.00');

    back();
    await waitFor(() => expect(server.transactions).toHaveLength(1), { timeout: 10_000 });
    expect(server.transactions[0]).toMatchObject({
      amountCents: 1_440,
      date: '2026-11-12',
      original: { currency: 'THB', cents: 12_000, rate: 0.12, day: '2026-11-12' },
    });
    // Sent once, as typed
    const sent = sentBodies().filter((b) => b.changes.some((c) => c.op === 'addTransaction'));
    expect(sent).toHaveLength(1);
    expect(sent[0].currencies).toEqual(['THB']);
    expect(await screen.findByLabelText('Balance RM 85.60')).toBeTruthy();
    // The entry as the server converted it, in place of the pending one
    expect(await screen.findByRole('button', { name: /, −THB 120\.00, RM 14\.40$/ })).toBeTruthy();
    expect(screen.queryByText('conversion pending')).toBeNull();
  });
});

describe('an entry waiting for a rate, offline', () => {
  /** Offline with no rate for THB, Night market THB 120.00 added today, then Activity opened */
  async function pendingEntry(server: FakeServer) {
    renderApp(server, `/?account=${WALLET}`, { size: 'phone' });
    await screen.findByLabelText('Balance RM 100.00');
    await reloadApp(server, `/?account=${WALLET}`, { size: 'phone' });
    await screen.findByLabelText('Balance RM 100.00');
    const { syncHistory } = await import('../../ledger/ledger');
    await act(() => syncHistory());
    const back = goOffline(server);
    const { user, form: opened } = await openAdd();
    const form = await inCurrency(user, opened, 'THB');
    await typeAmount(form, '120');
    // On a short phone the payee folds under Details
    const details = form.queryByRole('button', { name: /^Details/ });
    if (details?.getAttribute('aria-expanded') === 'false') await user.click(details);
    await user.type(form.getByLabelText('Payee'), 'Night market');
    await form.findByText(/^Conversion pending/);
    await user.click(addSaveButton(form));
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );
    await reloadApp(server, '/?activity', { size: 'phone' });
    return { user: userEvent.setup(), back };
  }

  test('totals say they leave it out; edited, it stays pending, and is converted once back', async () => {
    const server = withWallet(['THB']);
    const { user, back } = await pendingEntry(server);
    expect(await screen.findByText('Leaves out 1 entry waiting for a rate')).toBeTruthy();

    await user.click(
      await screen.findByRole('button', {
        name: /^Night market, .*−THB 120\.00, conversion pending$/,
      }),
    );
    const editor = within(await screen.findByRole('dialog', { name: 'Night market' }));
    const amount = editor.getByRole<HTMLInputElement>('textbox', { name: 'Amount' });
    await user.clear(amount);
    await user.type(amount, '150');
    await user.click(editor.getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      await screen.findByRole('button', {
        name: /^Night market, .*−THB 150\.00, conversion pending$/,
      }),
    ).toBeTruthy();
    expect(screen.getByText('Leaves out 1 entry waiting for a rate')).toBeTruthy();

    back();
    await waitFor(() =>
      expect(server.transactions).toEqual([
        expect.objectContaining({
          payee: 'Night market',
          amountCents: 1_913,
          original: expect.objectContaining({ currency: 'THB', cents: 15_000 }),
        }),
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByText('Leaves out 1 entry waiting for a rate')).toBeNull(),
    );
  });

  test('selected, the total says it leaves the entry out, until it is converted', async () => {
    const server = withWallet(['THB']);
    const { user, back } = await pendingEntry(server);
    const row = await screen.findByRole('button', { name: /^Night market, .*conversion pending$/ });
    fireEvent.pointerDown(row, { pointerType: 'touch', pointerId: 3, clientX: 50, clientY: 50 });
    await act(() => new Promise((r) => setTimeout(r, 550)));
    fireEvent.pointerUp(row, { pointerType: 'touch', pointerId: 3, clientX: 50, clientY: 50 });
    const bar = within(await screen.findByRole('region', { name: 'Selected' }));
    const summary = bar.getByRole('button', {
      name: '1 selected · Net RM 0.00 · 1 waiting for a rate',
    });
    await user.click(summary);
    expect(bar.getByText('Leaves out 1 entry waiting for a rate')).toBeTruthy();

    back();
    expect(
      await bar.findByRole('button', { name: '1 selected · Net −RM 15.30' }, { timeout: 10_000 }),
    ).toBeTruthy();
    expect(bar.queryByText('Leaves out 1 entry waiting for a rate')).toBeNull();
  });

  test('deleted and put back with Undo, it is still waiting, and saved once', async () => {
    const server = withWallet(['THB']);
    const { user, back } = await pendingEntry(server);
    await user.click(
      await screen.findByRole('button', { name: /^Night market, .*conversion pending$/ }),
    );
    const editor = within(await screen.findByRole('dialog', { name: 'Night market' }));
    await user.click(editor.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Night market, / })).toBeNull(),
    );
    expect(screen.queryByText(/waiting for a rate/)).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(
      await screen.findByRole('button', {
        name: /^Night market, .*−THB 120\.00, conversion pending$/,
      }),
    ).toBeTruthy();

    back();
    await waitFor(() => expect(server.transactions).toHaveLength(1), { timeout: 10_000 });
    expect(server.transactions[0]).toMatchObject({
      payee: 'Night market',
      amountCents: 1_530,
      original: { currency: 'THB', cents: 12_000 },
    });
  });
});

describe('entries in another currency', () => {
  test.each(SIZES)('show both amounts in Activity and the account (%s)', async (size) => {
    const server = withWallet(['THB']);
    withThbEntry(server);
    renderApp(server, '/?activity', { size });
    const row = await screen.findByRole(size === 'desktop' ? 'row' : 'button', {
      name: /Night market/,
    });
    expect(within(row).getByText('−THB 120.00')).toBeTruthy();
    expect(within(row).getByText('RM 15.30')).toBeTruthy();

    await reloadApp(server, `/?account=${WALLET}`, { size });
    const entry =
      size === 'desktop'
        ? await screen.findByRole('row', { name: /Night market/ })
        : await screen.findByRole('button', {
            name: /^Night market, .*−THB 120\.00, RM 15\.30$/,
          });
    expect(within(entry).getByText('−THB 120.00')).toBeTruthy();
    expect(within(entry).getByText('RM 15.30')).toBeTruthy();
  });

  test.each(SIZES)('the entry says the rate and the day it is from (%s)', async (size) => {
    const server = withWallet(['THB']);
    withThbEntry(server, {
      original: {
        currency: 'THB',
        cents: 12_000,
        rate: 0.1275,
        source: 'wise',
        at: Date.parse('2026-11-12T12:00:00Z'),
      },
    });
    renderApp(server, '/?activity', { size });
    if (size === 'phone') {
      await userEvent.setup().click(await screen.findByRole('button', { name: /^Night market, / }));
    }
    const editor = within(
      size === 'desktop'
        ? await screen.findByRole('complementary', { name: /^Night market/ })
        : await screen.findByRole('dialog', { name: 'Night market' }),
    );
    expect(editor.getByText('1 THB = 0.1275 MYR, rate of Nov 12, from Wise')).toBeTruthy();
  });

  test.each(SIZES)('can change currency and amount when edited (%s)', async (size) => {
    const server = withWallet(['THB', 'USD']);
    withThbEntry(server);
    renderApp(server, '/?activity', { size });
    const user = userEvent.setup();
    if (size === 'phone') {
      await user.click(await screen.findByRole('button', { name: /^Night market, / }));
    }
    // A computer opens the first entry beside the register
    const editor = within(
      size === 'desktop'
        ? await screen.findByRole('complementary', { name: /^Night market/ })
        : await screen.findByRole('dialog', { name: 'Night market' }),
    );
    const currency = editor.getByRole('combobox', { name: /^Currency / });
    expect(currency.textContent).toBe('THB');
    const amount = editor.getByRole<HTMLInputElement>('textbox', { name: 'Amount' });
    expect(amount.value).toMatch(/^120(\.00)?$/);
    await pick(user, currency, 'USD');
    await user.clear(amount);
    await user.type(amount, '20');
    await user.click(editor.getByRole('button', { name: /^Save/ }));
    await waitFor(() =>
      expect(server.transactions[0]).toMatchObject({
        amountCents: 9_000,
        original: { currency: 'USD', cents: 2_000, rate: 4.5 },
      }),
    );
    const body = sentBodies().at(-1)!;
    expect(body.changes).toEqual([
      expect.objectContaining({ op: 'updateTransaction', amountCents: 2_000 }),
    ]);
    expect(body.currencies).toEqual(['USD']);
  });

  test('changed back to the main currency, it keeps only the main amount', async () => {
    const server = withWallet(['THB']);
    withThbEntry(server);
    renderApp(server, '/?activity', { size: 'phone' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Night market, / }));
    const editor = within(await screen.findByRole('dialog', { name: 'Night market' }));
    await pick(user, editor.getByRole('combobox', { name: /^Currency / }), 'MYR');
    const amount = editor.getByRole<HTMLInputElement>('textbox', { name: 'Amount' });
    await user.clear(amount);
    await user.type(amount, '15.30');
    await user.click(editor.getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(server.transactions[0].original).toBeUndefined());
    expect(server.transactions[0].amountCents).toBe(1_530);
    expect(sentBodies().at(-1)!.currencies).toEqual(['MYR']);
  });
});

// Rate days are calendar days: an earlier day's rate names its day, as its time (noon UTC) is
// already the next day from UTC+12 to +14
describe.each(['Pacific/Kiritimati', 'Pacific/Auckland'])('rate days in %s', (zone) => {
  beforeEach(() => {
    process.env.TZ = zone;
    vi.setSystemTime(new Date(2026, 10, 19, 10, 0, 0));
  });
  afterEach(() => {
    process.env.TZ = 'Asia/Kuala_Lumpur';
  });

  test.each(SIZES)('the entry says the day its rate is from (%s)', async (size) => {
    const server = withWallet(['THB']);
    withThbEntry(server, {
      original: {
        currency: 'THB',
        cents: 12_000,
        rate: 0.1275,
        source: 'wise',
        at: Date.parse('2026-11-12T12:00:00Z'),
        day: '2026-11-12',
      },
    });
    renderApp(server, '/?activity', { size });
    if (size === 'phone') {
      await userEvent.setup().click(await screen.findByRole('button', { name: /^Night market, / }));
    }
    const editor = within(
      size === 'desktop'
        ? await screen.findByRole('complementary', { name: /^Night market/ })
        : await screen.findByRole('dialog', { name: 'Night market' }),
    );
    expect(editor.getByText('1 THB = 0.1275 MYR, rate of Nov 12, from Wise')).toBeTruthy();
  });

  test('a backdated entry names its own day', async () => {
    renderApp(withWallet(['THB']), '/', { size: 'desktop' });
    const { user, form: opened } = await openAdd();
    const form = await inCurrency(user, opened, 'THB');
    await typeAmount(form, '120');
    await user.click(form.getByRole('button', { name: /^Today/ }));
    fireEvent.change(form.getByLabelText('Date'), { target: { value: '2026-11-12' } });
    expect(
      await form.findByRole('button', {
        name: "about RM 15.30 at today's rate, saved at the rate of Nov 12",
      }),
    ).toBeTruthy();
  });
});

describe('travel sense', () => {
  test.each(SIZES)('opens Add in the currency of where the device is (%s)', async (size) => {
    deviceIn('Asia/Bangkok');
    renderApp(withWallet(['USD', 'THB']), '/', { size });
    const { form } = await openAdd();
    expect(pill(form).getAttribute('aria-label')).toBe('THB, currency');
    expect(form.getByRole('button', { name: 'In THB today. Tap to change.' })).toBeTruthy();
  });

  test('never picks a currency outside the list', async () => {
    deviceIn('Asia/Tokyo');
    renderApp(withWallet(['THB']), '/', { size: 'phone' });
    const { form } = await openAdd();
    expect(pill(form).getAttribute('aria-label')).toBe('RM, currency');
    expect(form.queryByRole('button', { name: /today\. Tap to change\.$/ })).toBeNull();
  });

  test('is quiet when turned off', async () => {
    deviceIn('Asia/Bangkok');
    const server = withWallet(['THB']);
    server.me.settings = { ...server.me.settings, travelSense: false };
    renderApp(server, '/', { size: 'phone' });
    const { form } = await openAdd();
    expect(pill(form).getAttribute('aria-label')).toBe('RM, currency');
    expect(form.queryByRole('button', { name: /Tap to change/ })).toBeNull();
  });

  test('follows the last two entries today, and Tap to change sets the day', async () => {
    const server = withWallet(['USD', 'THB']);
    renderApp(server, '/', { size: 'phone' });
    const addIn = async (code: string) => {
      const { user, form: opened } = await openAdd();
      const form = await inCurrency(user, opened, code);
      await typeAmount(form, '5');
      await user.click(addSaveButton(form));
      await waitFor(() =>
        expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
      );
    };
    await addIn('USD');
    let { user, form } = await openAdd();
    // One alone isn't enough
    expect(pill(form).getAttribute('aria-label')).toBe('RM, currency');
    await user.click(form.getByRole('button', { name: 'Close' }));
    await addIn('USD');

    ({ user, form } = await openAdd());
    expect(pill(form).getAttribute('aria-label')).toBe('USD, currency');
    await user.click(form.getByRole('button', { name: 'In USD today. Tap to change.' }));
    await user.click(await screen.findByRole('option', { name: /^MYR/ }));
    const open = await addForm();
    expect(pill(open).getAttribute('aria-label')).toBe('RM, currency');
    await user.click(open.getByRole('button', { name: 'Close' }));

    // For the rest of the day
    ({ form } = await openAdd());
    expect(pill(form).getAttribute('aria-label')).toBe('RM, currency');
    expect(form.queryByRole('button', { name: /Tap to change/ })).toBeNull();
  });
});
