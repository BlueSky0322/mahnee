// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Account, ChangesBody, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  addForm,
  fakeServer,
  holdNext,
  reloadApp,
  renderApp,
  setupAppTests,
  typeAmount,
  addSaveButton,
} from '../../testing/app';

// Accounts (?accounts) and one account (?account=<id>), as R-Accounts, R-Account,
// R-Account-Archived and R-Desk-Accounts draw them. The list: "All together" (every running
// account, less what's owed on cards), what's in accounts and what's owed, the accounts in
// two groups each with its total, and the archived ones behind "Archived · N", each with
// the day it was archived. An account's page: its kind, name and balance, Add here,
// Transfer and Search (Unarchive instead, for an archived one), and its entries by day,
// signed by what each did to its balance. On a computer the two are one page: the list on
// the left, the account picked on the right with a register that shows the balance after
// each entry, a search of the account and "Any date". Phones and tablets show one page at
// a time. Every figure, name and date here is this file's own, never the boards' samples.

vi.hoisted(() => {
  // The person's own zone, whose day differs from UTC's for part of every day
  process.env.TZ = 'Asia/Kuala_Lumpur';
});

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
type Size = (typeof SIZES)[number] | 'tablet';
const ONE_AT_A_TIME = ['phone', 'tablet'] as const;

const [POCKET, SAVER, CURRENT, VISA, GONE] = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(16));
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;

beforeEach(() => {
  // Tuesday 10 November 2026, half past midnight in Kuala Lumpur (still the 9th in UTC)
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 0, 30, 0));
  return () => vi.useRealTimers();
});

function seedAccount(server: FakeServer, account: Partial<Account> & Pick<Account, 'id' | 'name'>) {
  server.accounts.push({
    kind: 'cash',
    currency: 'MYR',
    openingCents: 0,
    position: server.accounts.length,
    archived: false,
    ...account,
  });
}

let seeded = 0;
function seed(server: FakeServer, t: Partial<Transaction>) {
  seeded++;
  server.transactions.push({
    id: seeded.toString(16).padStart(16, '0'),
    kind: 'expense',
    accountId: SAVER,
    toAccountId: null,
    amountCents: 100,
    categoryId: id('Food'),
    payee: null,
    note: null,
    date: '2026-11-09',
    createdAt: seeded,
    ...t,
  });
}

/** 22:40 UTC on Aug 13, which is Aug 14 in Kuala Lumpur */
const GONE_AT = Date.parse('2026-08-13T22:40:00Z');

/**
 * Pocket (cash, 43.10 to start), Saver (bank, 1,000.00 to start), Current (bank, overdrawn
 * 25.00), a Visa card with 331.90 owed, and Gone (an e-wallet with 12.00, archived on Aug
 * 14). Saver's entries, oldest first: Dec 30, 2025 15.00 in from Pocket; Oct 20 13.20 on
 * Transport (no payee, no note); Nov 3 60.00 out to Pocket, note "top-up"; Nov 9 7.25 on
 * Food at "Kedai Ali"; Nov 9 3,250.00 Salary from "Acme". So Saver holds 4,184.55 and
 * Pocket 88.10; 4,247.65 is in accounts, 331.90 owed, 3,915.75 all together.
 */
function withAccounts() {
  const server = fakeServer();
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  seedAccount(server, { id: POCKET, name: 'Pocket', openingCents: 4_310 });
  seedAccount(server, { id: SAVER, name: 'Saver', kind: 'bank', openingCents: 100_000 });
  seedAccount(server, { id: CURRENT, name: 'Current', kind: 'bank', openingCents: -2_500 });
  seedAccount(server, { id: VISA, name: 'Visa', kind: 'card', openingCents: -33_190 });
  seedAccount(server, {
    id: GONE,
    name: 'Gone',
    kind: 'ewallet',
    openingCents: 1_200,
    archived: true,
    archivedAt: GONE_AT,
  });
  seed(server, {
    date: '2025-12-30',
    kind: 'transfer',
    accountId: POCKET,
    toAccountId: SAVER,
    amountCents: 1_500,
    categoryId: null,
  });
  seed(server, { date: '2026-10-20', amountCents: 1_320, categoryId: id('Transport') });
  seed(server, {
    date: '2026-11-03',
    kind: 'transfer',
    toAccountId: POCKET,
    amountCents: 6_000,
    categoryId: null,
    note: 'top-up',
  });
  seed(server, { date: '2026-11-09', amountCents: 725, payee: 'Kedai Ali' });
  seed(server, {
    date: '2026-11-09',
    kind: 'income',
    amountCents: 325_000,
    categoryId: id('Salary'),
    payee: 'Acme',
  });
  return server;
}

/** A group of accounts on the list, named by its heading */
const group = (name: string) => screen.findByRole('region', { name });

/** The accounts a group lists, each read out as name, kind, balance */
const rows = (region: HTMLElement) =>
  within(within(region).getByRole('list'))
    .getAllByRole('link')
    .map((a) => a.getAttribute('aria-label') ?? a.textContent);

/** An account's row on the list */
const accountRow = (name: string) => screen.findByRole('link', { name: new RegExp(`^${name},`) });

/** The changes each save carried, in order */
const sent = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST')
    .flatMap(([, init]) => (JSON.parse(init!.body as string) as ChangesBody).changes);

/** The register on a computer: each row's cells, read as shown */
async function register() {
  const table = await screen.findByRole('table', { name: 'Transactions' });
  const [head, ...body] = within(table).getAllByRole('row');
  return {
    columns: within(head)
      .getAllByRole('columnheader')
      .map((c) => c.textContent),
    rows: body.map((r) =>
      within(r)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ),
  };
}

describe('Accounts (?accounts)', () => {
  test.each<Size>(['desktop', 'phone', 'tablet'])(
    'shows all together, what is in accounts and owed, and each group with its total (%s)',
    async (size) => {
      renderApp(withAccounts(), '/?accounts', { size });

      expect(await screen.findByRole('heading', { name: 'Accounts', level: 1 })).toBeTruthy();
      const totals = within(await screen.findByRole('group', { name: 'All together' }));
      // The figure, then what's in accounts and owed (R-Accounts); on a computer the two
      // sit in one line, "RM x all together · ..." (R-Desk-Accounts)
      expect(totals.getByText('RM 3,915.75')).toBeTruthy();
      if (size === 'desktop') {
        expect(
          totals.getByText(/^all together · RM 4,247\.65 in accounts · RM 331\.90 owed$/),
        ).toBeTruthy();
      } else {
        expect(totals.getByText('All together')).toBeTruthy();
        expect(totals.getByText('RM 4,247.65 in accounts · RM 331.90 owed')).toBeTruthy();
      }

      const have = await group('Cash, banks and e-wallets');
      expect(within(have).getByText('4,247.65')).toBeTruthy();
      expect(rows(have)).toEqual([
        'Pocket, Cash, 88.10',
        'Saver, Bank, 4,184.55',
        'Current, Bank, −25.00',
      ]);
      const cards = await group('Cards');
      // The group's total, beside its name (a computer's row says "331.90 owed" too)
      expect(
        within(cards)
          .getAllByText('331.90 owed')
          .filter((e) => e.closest('ul') == null),
      ).toHaveLength(1);
      expect(rows(cards)).toEqual(['Visa, Card, 331.90 owed']);
      // The archived one counts in none of it, and is listed only once opened
      expect(screen.queryByRole('link', { name: /^Gone,/ })).toBeNull();
    },
  );

  test.each(SIZES)(
    "a card's row says owed under the amount, or beside it on a computer (%s)",
    async (size) => {
      renderApp(withAccounts(), '/?accounts', { size });
      const visa = within(await accountRow('Visa'));
      // R-Desk-Accounts draws "331.90 owed" as one figure; R-Accounts puts "owed" under it
      if (size === 'desktop') {
        expect(visa.getByText('331.90 owed')).toBeTruthy();
        expect(visa.queryByText('owed')).toBeNull();
      } else {
        expect(visa.getByText('331.90')).toBeTruthy();
        expect(visa.getByText('owed')).toBeTruthy();
      }
    },
  );

  test.each(SIZES)(
    'lists archived ones behind Archived · N, each with the day it was archived (%s)',
    async (size) => {
      renderApp(withAccounts(), '/?accounts', { size });
      const archived = await screen.findByRole('region', { name: 'Archived accounts' });
      const toggle = within(archived).getByRole('button', { name: 'Archived · 1' });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');

      await userEvent.setup().click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(
        within(archived).getByRole('link', { name: 'Gone, E-wallet · archived Aug 14, 12.00' }),
      ).toBeTruthy();
    },
  );

  test('has no Archived toggle while nothing is archived', async () => {
    const server = withAccounts();
    server.accounts = server.accounts.filter((a) => a.id !== GONE);
    renderApp(server, '/?accounts', { size: 'phone' });
    await group('Cards');
    expect(screen.queryByRole('button', { name: /^Archived/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Archived accounts' })).toBeNull();
  });

  test('an archived one with no day kept (archived before days were kept) says only archived', async () => {
    const server = withAccounts();
    server.accounts.find((a) => a.id === GONE)!.archivedAt = null;
    renderApp(server, '/?accounts', { size: 'phone' });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Archived · 1' }));
    expect(
      await screen.findByRole('link', { name: 'Gone, E-wallet · archived, 12.00' }),
    ).toBeTruthy();
  });

  test.each(SIZES)(
    'shows placeholders until the accounts arrive, never figures first (%s)',
    async (size) => {
      const server = withAccounts();
      const held = holdNext(server, 'GET', '/api/accounts');
      renderApp(server, '/?accounts', { size });
      expect(await screen.findByText('Loading your accounts')).toBeTruthy();
      expect(screen.queryByRole('group', { name: 'All together' })).toBeNull();
      held.release();
      expect(await screen.findByRole('group', { name: 'All together' })).toBeTruthy();
      expect(screen.queryByText('Loading your accounts')).toBeNull();
    },
  );

  test.each(SIZES)('adds an account from Accounts (%s)', async (size) => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();
    const add = await screen.findByRole('button', { name: /Add account|^Account$/ });
    // A phone's says "Account" beside its plus (R-Accounts); a computer's "Add account"
    expect(add.textContent).toBe(size === 'phone' ? 'Account' : 'Add account');
    await user.click(add);
    const form = within(await screen.findByRole('dialog', { name: 'Add account' }));
    await user.type(form.getByLabelText('Name'), 'Tin');
    await user.type(form.getByLabelText('Opening balance'), '5');
    await user.click(form.getByRole('button', { name: 'Add account' }));

    expect(rows(await group('Cash, banks and e-wallets'))).toContain('Tin, Cash, 5.00');
    expect((await screen.findByRole('group', { name: 'All together' })).textContent).toContain(
      'RM 3,920.75',
    );
  });

  test.each(ONE_AT_A_TIME)(
    'opens an account on its own page, and goes back up (%s)',
    async (size) => {
      renderApp(withAccounts(), '/?accounts', { size });
      const user = userEvent.setup();
      await user.click(await accountRow('Saver'));
      expect(await screen.findByRole('heading', { name: 'Saver', level: 1 })).toBeTruthy();
      expect(window.location.search).toBe(`?account=${SAVER}`);
      // The list isn't beside it
      expect(screen.queryByRole('group', { name: 'All together' })).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Accounts' }));
      expect(await screen.findByRole('group', { name: 'All together' })).toBeTruthy();
      expect(window.location.search).toBe('?accounts');
    },
  );

  test('on a computer, the first running account opens beside the list, and picking another opens it there', async () => {
    renderApp(withAccounts(), '/?accounts');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Pocket', level: 2 })).toBeTruthy();
    expect((await accountRow('Pocket')).getAttribute('aria-current')).toBe('page');
    const before = window.history.length;

    await user.click(await accountRow('Saver'));
    expect(await screen.findByRole('heading', { name: 'Saver', level: 2 })).toBeTruthy();
    expect((await accountRow('Saver')).getAttribute('aria-current')).toBe('page');
    expect((await accountRow('Pocket')).getAttribute('aria-current')).toBeNull();
    // The list stays, and picking is not a page of its own in history
    expect(screen.getByRole('group', { name: 'All together' })).toBeTruthy();
    expect(window.location.search).toBe(`?account=${SAVER}`);
    expect(window.history.length).toBe(before);
  });

  test("on a computer, an account's own address opens Accounts with it beside the list", async () => {
    renderApp(withAccounts(), `/?account=${CURRENT}`);
    expect(await screen.findByRole('heading', { name: 'Current', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Accounts', level: 1 })).toBeTruthy();
    expect((await accountRow('Current')).getAttribute('aria-current')).toBe('page');
  });

  test("on a computer, an archived account's address opens the archived ones", async () => {
    renderApp(withAccounts(), `/?account=${GONE}`);
    expect(await screen.findByRole('heading', { name: 'Gone', level: 2 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archived · 1' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect((await accountRow('Gone')).getAttribute('aria-current')).toBe('page');
  });

  test.each(SIZES)('says when an account is not found (%s)', async (size) => {
    renderApp(withAccounts(), `/?account=${'9'.repeat(16)}`, { size });
    expect(await screen.findByText('Account not found')).toBeTruthy();
  });

  test.each(SIZES)(
    "says when the accounts couldn't be loaded, with Try again (%s)",
    async (size) => {
      const server = withAccounts();
      server.pathsDown.add('/api/accounts');
      renderApp(server, '/?accounts', { size });
      expect(await screen.findByText("Couldn't load your accounts.")).toBeTruthy();
      server.pathsDown.delete('/api/accounts');
      await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('group', { name: 'All together' })).toBeTruthy();
    },
  );
});

describe("an account's page", () => {
  test.each(ONE_AT_A_TIME)(
    'shows its kind, name and balance, its actions, and its entries by day (%s)',
    async (size) => {
      renderApp(withAccounts(), `/?account=${SAVER}`, { size });
      expect(await screen.findByRole('heading', { name: 'Saver', level: 1 })).toBeTruthy();
      expect(screen.getByText('Bank')).toBeTruthy();
      expect(screen.getByLabelText('Balance RM 4,184.55').textContent).toBe('RM 4,184.55');
      for (const name of ['Accounts', 'Edit', 'Add here', 'Transfer', 'Search']) {
        expect(screen.getByRole('button', { name })).toBeTruthy();
      }
      expect(screen.queryByText('Hidden when adding entries')).toBeNull();

      const entries = await screen.findByRole('region', { name: 'Transactions' });
      const days = within(entries).getAllByRole('list');
      expect(days.map((d) => d.getAttribute('aria-label'))).toEqual([
        'Yesterday',
        'Tue, Nov 3',
        'Tue, Oct 20',
        'Tue, Dec 30, 2025',
      ]);
      const read = (list: HTMLElement) =>
        within(list)
          .getAllByRole('button')
          .map((b) => b.getAttribute('aria-label'));
      expect(days.map(read)).toEqual([
        ['Acme, Salary, +3,250.00', 'Kedai Ali, Food, −7.25'],
        ['To Pocket, Transfer · top-up, −60.00'],
        ['Transport, Transport, −13.20'],
        ['From Pocket, Transfer, +15.00'],
      ]);
    },
  );

  test.each(SIZES)("a card's balance is what's owed on it (%s)", async (size) => {
    renderApp(withAccounts(), `/?account=${VISA}`, { size });
    expect(await screen.findByLabelText('Balance RM 331.90 owed')).toBeTruthy();
  });

  test.each(SIZES)('Add here opens Add on this account (%s)', async (size) => {
    const server = withAccounts();
    renderApp(server, `/?account=${CURRENT}`, { size });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add here' }));
    const form = await addForm();
    expect(form.getByRole('radio', { name: 'Expense' }).getAttribute('aria-checked')).toBe('true');
    expect(form.getByRole('button', { name: /^From Current/ })).toBeTruthy();
    await typeAmount(form, '4');
    await user.click(addSaveButton(form));
    expect(await screen.findByLabelText('Balance −RM 29.00')).toBeTruthy();
    await waitFor(() =>
      expect(server.transactions.at(-1)).toMatchObject({ accountId: CURRENT, amountCents: 400 }),
    );
  });

  test.each(SIZES)('Transfer opens Add on Transfer, from this account (%s)', async (size) => {
    renderApp(withAccounts(), `/?account=${SAVER}`, { size });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Transfer' }));
    const form = await addForm();
    expect(form.getByRole('radio', { name: 'Transfer' }).getAttribute('aria-checked')).toBe('true');
    expect(form.getByRole('button', { name: /^From Saver/ })).toBeTruthy();
    // Closed before the next test: a phone's open Add holds a history entry of its own
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );
  });

  test('Transfer and Add here put this account in From, over the account a kept draft had', async () => {
    renderApp(withAccounts(), `/?account=${POCKET}`, { size: 'phone' });
    const user = userEvent.setup();
    // A draft on Saver, closed and kept
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    let form = await addForm();
    await user.click(form.getByRole('button', { name: /^From Pocket/ }));
    await user.click(await screen.findByRole('radio', { name: /^Saver/ }));
    await typeAmount(form, '3');
    await user.click(form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }));
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );

    await user.click(screen.getByRole('button', { name: 'Transfer' }));
    form = await addForm();
    expect(form.getByRole('radio', { name: 'Transfer' }).getAttribute('aria-checked')).toBe('true');
    expect(form.getByRole('button', { name: /^From Pocket/ })).toBeTruthy();
    // What was typed is kept
    expect(form.getByRole('status', { name: 'Amount, RM 3.00' })).toBeTruthy();
    // Closed before the next test: a phone's open Add holds a history entry of its own
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );
  });

  test('Search on a phone opens Activity on this account, every month', async () => {
    renderApp(withAccounts(), `/?account=${SAVER}`, { size: 'phone' });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(window.location.search).toBe(`?activity&account=${SAVER}&dates=all`),
    );
    expect(await screen.findByRole('button', { name: /^Saver/ })).toBeTruthy();
    expect(await screen.findByText('Kedai Ali')).toBeTruthy();
  });

  test.each(SIZES)(
    'Show 50 more loads the next 50, newest first all the way down (%s)',
    async (size) => {
      const server = fakeServer();
      server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
      seedAccount(server, { id: POCKET, name: 'Pocket' });
      for (let i = 0; i < 60; i++) {
        seed(server, { accountId: POCKET, date: '2026-10-01', amountCents: 100 + i });
      }
      renderApp(server, `/?account=${POCKET}`, { size });
      const user = userEvent.setup();
      const shown = async () =>
        size === 'desktop'
          ? (await register()).rows
          : within(await screen.findByRole('region', { name: 'Transactions' }))
              .getAllByRole('listitem')
              .map((li) => [li.textContent]);

      await screen.findByRole('button', { name: 'Show 50 more' });
      expect(await shown()).toHaveLength(50);
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Show 50 more' }));
      await waitFor(async () => expect(await shown()).toHaveLength(60));
      expect(screen.queryByRole('button', { name: 'Show 50 more' })).toBeNull();
      const last = (await shown()).at(-1)!;
      if (size === 'desktop') {
        // The first one spent: 1.00 out of nothing
        expect(last).toEqual(['Oct 1', 'Food', 'Food', '−1.00', '−1.00']);
      } else {
        expect(last[0]).toContain('−1.00');
      }
    },
  );

  test.each(ONE_AT_A_TIME)('tapping an entry opens it to change (%s)', async (size) => {
    renderApp(withAccounts(), `/?account=${SAVER}`, { size });
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Kedai Ali, Food, −7.25' }));
    expect(await screen.findByRole('dialog', { name: 'Edit transaction' })).toBeTruthy();
    // Closed before the next test: an open sheet holds a history entry of its own
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('an archived account', () => {
  test.each(SIZES)(
    'says when it was archived and that it is hidden when adding, with Unarchive in place of the actions (%s)',
    async (size) => {
      const server = withAccounts();
      renderApp(server, `/?account=${GONE}`, { size });
      const user = userEvent.setup();
      expect(await screen.findByRole('heading', { name: 'Gone' })).toBeTruthy();
      expect(screen.getAllByText('E-wallet · archived Aug 14').length).toBeGreaterThan(0);
      expect(screen.getByText('Hidden when adding entries')).toBeTruthy();
      for (const name of ['Add here', 'Transfer', 'Search']) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
      expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'Unarchive' }));
      expect(await screen.findByRole('button', { name: 'Add here' })).toBeTruthy();
      expect(screen.queryByText('Hidden when adding entries')).toBeNull();
      expect(screen.queryByText(/archived/)).toBeNull();
      await waitFor(() =>
        expect(server.accounts.find((a) => a.id === GONE)).toMatchObject({
          archived: false,
          archivedAt: null,
        }),
      );
      expect(sent()).toEqual([{ op: 'archiveAccount', id: GONE, archived: false }]);
    },
  );

  test.each(SIZES)(
    "archiving from Edit says today's day at once and after a reload, and Undo takes it away (%s)",
    async (size) => {
      const server = withAccounts();
      renderApp(server, `/?account=${CURRENT}`, { size });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Edit' }));
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Archive' }),
      );
      // Half past midnight on the 10th here, though UTC is still on the 9th
      expect((await screen.findAllByText('Bank · archived Nov 10')).length).toBeGreaterThan(0);
      await waitFor(() =>
        expect(server.accounts.find((a) => a.id === CURRENT)?.archivedAt).toEqual(
          expect.any(Number),
        ),
      );

      await reloadApp(server, `/?account=${CURRENT}`, { size });
      expect((await screen.findAllByText('Bank · archived Nov 10')).length).toBeGreaterThan(0);

      await user.click(screen.getByRole('button', { name: 'Unarchive' }));
      expect(await screen.findByRole('button', { name: 'Add here' })).toBeTruthy();
      await waitFor(() =>
        expect(server.accounts.find((a) => a.id === CURRENT)?.archivedAt).toBeNull(),
      );
    },
  );

  test('Undo after archiving takes the day away again', async () => {
    const server = withAccounts();
    renderApp(server, `/?account=${CURRENT}`, { size: 'phone' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Archive' }),
    );
    await screen.findByText('Bank · archived Nov 10');
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Bank')).toBeTruthy();
    expect(screen.queryByText(/archived/)).toBeNull();
    await waitFor(() =>
      expect(server.accounts.find((a) => a.id === CURRENT)).toMatchObject({
        archived: false,
        archivedAt: null,
      }),
    );
  });

  test('Edit offers no second way to bring it back: Unarchive is on the page', async () => {
    renderApp(withAccounts(), `/?account=${GONE}`, { size: 'phone' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = within(await screen.findByRole('dialog'));
    expect(form.getByLabelText('Name')).toBeTruthy();
    expect(form.queryByRole('button', { name: 'Bring back' })).toBeNull();
    expect(form.queryByRole('button', { name: 'Archive' })).toBeNull();
    // Closed before the next test: a phone's open sheet holds a history entry of its own
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('the register on a computer', () => {
  test('beside the list: the name, what it started at, the balance, its actions and the register', async () => {
    renderApp(withAccounts(), `/?account=${SAVER}`);
    const pane = await screen.findByRole('region', { name: 'Saver' });
    expect(within(pane).getByText('Bank · started at RM 1,000.00')).toBeTruthy();
    expect(within(pane).getByLabelText('Balance RM 4,184.55')).toBeTruthy();
    for (const name of ['Add here', 'Transfer', 'Edit']) {
      expect(within(pane).getByRole('button', { name })).toBeTruthy();
    }
    expect(within(pane).getByRole('searchbox', { name: 'Search this account' })).toHaveProperty(
      'placeholder',
      'Search this account',
    );
    expect(within(pane).getByRole('button', { name: 'Any date' })).toBeTruthy();

    const { columns, rows: shown } = await register();
    expect(columns).toEqual([
      'Date',
      'Payee or transfer',
      'Category',
      'Amount',
      'Balance afterNew',
    ]);
    expect(shown).toEqual([
      ['Nov 9', 'Acme', 'Salary', '+3,250.00', '4,184.55'],
      ['Nov 9', 'Kedai Ali', 'Food', '−7.25', '934.55'],
      ['Nov 3', 'To Pocket', 'Transfer · top-up', '−60.00', '941.80'],
      ['Oct 20', 'Transport', 'Transport', '−13.20', '1,001.80'],
      ['Dec 30, 2025', 'From Pocket', 'Transfer', '+15.00', '1,015.00'],
    ]);
  });

  test('a change shows in the register at once, every balance after moving with it', async () => {
    const server = withAccounts();
    const held = holdNext(server, 'POST', '/api/changes');
    renderApp(server, `/?account=${SAVER}`);
    const user = userEvent.setup();
    await register();
    await user.click(await screen.findByRole('button', { name: 'Add here' }));
    const form = await addForm();
    await typeAmount(form, '0.55');
    await user.click(addSaveButton(form));

    // Today's, newest of all, before the server has answered
    await waitFor(async () =>
      expect((await register()).rows.slice(0, 3)).toEqual([
        ['Nov 10', expect.any(String), expect.any(String), '−0.55', '4,184.00'],
        ['Nov 9', 'Acme', 'Salary', '+3,250.00', '4,184.55'],
        ['Nov 9', 'Kedai Ali', 'Food', '−7.25', '934.55'],
      ]),
    );
    held.release();
    await waitFor(() => expect(server.transactions).toHaveLength(6));
  });

  test('picking an entry in the register opens it to change', async () => {
    renderApp(withAccounts(), `/?account=${SAVER}`);
    await register();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Kedai Ali' }));
    expect(await screen.findByRole('dialog', { name: 'Edit transaction' })).toBeTruthy();
  });

  test('searching the account shows what matches, without balances after', async () => {
    renderApp(withAccounts(), `/?account=${SAVER}`);
    const user = userEvent.setup();
    await register();
    await user.type(screen.getByRole('searchbox', { name: 'Search this account' }), 'kedai');
    await waitFor(async () =>
      expect(await register()).toEqual({
        columns: ['Date', 'Payee or transfer', 'Category', 'Amount'],
        rows: [['Nov 9', 'Kedai Ali', 'Food', '−7.25']],
      }),
    );
    const asked = vi
      .mocked(fetch)
      .mock.calls.map(([path]) => (typeof path === 'string' ? path : ''))
      .filter((p) => p.startsWith('/api/search'));
    expect(asked.at(-1)).toContain(`account=${SAVER}`);
    expect(asked.at(-1)).toContain('q=kedai');

    await user.clear(screen.getByRole('searchbox', { name: 'Search this account' }));
    await waitFor(async () => expect((await register()).rows).toHaveLength(5));
    expect((await register()).columns.at(-1)).toBe('Balance afterNew');
  });

  test('Any date narrows the register to the days picked', async () => {
    renderApp(withAccounts(), `/?account=${SAVER}`);
    const user = userEvent.setup();
    await register();
    await user.click(screen.getByRole('button', { name: 'Any date' }));
    const picker = within(await screen.findByRole('dialog'));
    expect(picker.getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual([
      'Any date',
      'This month',
      'Last month',
      'Pick dates',
    ]);
    await user.click(picker.getByRole('radio', { name: 'Last month' }));

    await waitFor(async () =>
      expect((await register()).rows).toEqual([['Oct 20', 'Transport', 'Transport', '−13.20']]),
    );
    expect(screen.getByRole('button', { name: 'Last month' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Last month' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('radio', { name: 'Any date' }),
    );
    await waitFor(async () => expect((await register()).rows).toHaveLength(5));
  });

  test('says when nothing on the account matches', async () => {
    renderApp(withAccounts(), `/?account=${SAVER}`);
    const user = userEvent.setup();
    await register();
    await user.type(screen.getByRole('searchbox', { name: 'Search this account' }), 'zzz');
    expect(await screen.findByText('Nothing on this account matches.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Transactions' })).toBeNull();
  });

  test('the search starts afresh on another account', async () => {
    renderApp(withAccounts(), `/?account=${SAVER}`);
    const user = userEvent.setup();
    await register();
    await user.type(screen.getByRole('searchbox', { name: 'Search this account' }), 'kedai');
    await waitFor(async () => expect((await register()).rows).toHaveLength(1));
    await user.click(await accountRow('Pocket'));
    await screen.findByRole('heading', { name: 'Pocket', level: 2 });
    expect(screen.getByRole('searchbox', { name: 'Search this account' })).toHaveProperty(
      'value',
      '',
    );
    expect(screen.getByRole('button', { name: 'Any date' })).toBeTruthy();
  });
});
