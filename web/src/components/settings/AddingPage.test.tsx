// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { Account, Transaction } from '@shared/api';
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

// Adding entries (R-Set-Adding, R-Desk-Set-Adding; digest 3.13; owner decisions D9, D14):
// what the keypad asks for first, the account Add starts on, suggestions as you type and
// a time on entries, each saved to the account at once and each changing what Add does.
// Names and figures are made up.

setupAppTests();

const SIZES = ['phone', 'desktop'] as const;
const WALLET = 'a'.repeat(16);
const BANK = 'b'.repeat(16);
const OLD = 'c'.repeat(16);
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [FOOD, TRANSPORT, SALARY] = [id('Food'), id('Transport'), id('Salary')];

function account(accountId: string, name: string, more: Partial<Account> = {}) {
  return {
    id: accountId,
    name,
    kind: 'cash' as const,
    currency: 'MYR',
    openingCents: 10_000,
    position: 0,
    archived: false,
    ...more,
  };
}

const spent = (n: number, payee: string, date: string, more: Partial<Transaction> = {}) =>
  ({
    id: n.toString(16).padStart(16, 'd'),
    kind: 'expense',
    accountId: WALLET,
    toAccountId: null,
    amountCents: 900,
    categoryId: FOOD,
    payee,
    note: null,
    date,
    createdAt: n,
    ...more,
  }) satisfies Transaction;

/** Wallet and Bank in use, Old Card archived, and two payees used before */
function withAccounts(): FakeServer {
  const server = fakeServer();
  server.accounts.push(
    account(WALLET, 'Wallet'),
    account(BANK, 'Bank', { kind: 'bank', position: 1 }),
    account(OLD, 'Old Card', { kind: 'card', position: 2, archived: true }),
  );
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  server.transactions.push(
    spent(1, 'Kopi Corner', '2026-01-03'),
    spent(2, 'Kedai Runcit', '2026-01-04'),
  );
  return server;
}

/** The radios of a group (role="radio", as every segmented choice is drawn), each with its state */
const radios = (group: HTMLElement) =>
  within(group)
    .getAllByRole('radio')
    .map((r) => [r.textContent, r.getAttribute('aria-checked')]);

/** Opens Adding entries at its own address */
async function openAdding(server: FakeServer, size: (typeof SIZES)[number]) {
  renderApp(server, '/?settings=adding', { size });
  await screen.findByRole('heading', { name: 'Adding entries', level: 1 });
  return within(await screen.findByRole('region', { name: 'Adding entries' }));
}

/** The app opened again at Accounts with the same server, then Add */
async function openAdd(server: FakeServer, size: (typeof SIZES)[number]) {
  await reloadApp(server, '/?accounts', { size });
  await userEvent.setup().click(await addButton());
  return addForm();
}

/** The payees Add's field suggests, or null when it names no list */
function suggested(form: Within) {
  const field = form.getByLabelText<HTMLInputElement>('Payee or note');
  const listId = field.getAttribute('list');
  if (listId == null) return null;
  const list = document.getElementById(listId);
  return [...(list?.querySelectorAll('option') ?? [])].map((o) => o.value);
}

/** How many times the app asked for the payees used before */
const payeeReads = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([input]) =>
      (input instanceof Request ? input.url : input.toString()).includes('/api/payee-categories'),
    ).length;

describe.each(SIZES)('Adding entries (%s)', (size) => {
  test('shows each setting as drawn, before anything is chosen', async () => {
    const page = await openAdding(withAccounts(), size);
    expect(radios(page.getByRole('radiogroup', { name: 'Start with' }))).toEqual([
      ['Amount', 'true'],
      ['Category', 'false'],
    ]);
    expect(page.getByText('What the keypad asks for first')).toBeTruthy();
    expect(page.getByText('Until you pick another')).toBeTruthy();
    expect(page.getByRole('button', { name: /^Account to use/ }).textContent).toMatch(/Last used/);
    if (size === 'desktop') {
      expect(page.getByRole('button', { name: 'Account to use: Last used' })).toBeTruthy();
    }
    expect(page.getByRole('switch', { name: 'Suggest as you type' })).toHaveProperty(
      'checked',
      true,
    );
    expect(page.getByText('Payees and notes you have used before')).toBeTruthy();
    expect(page.getByRole('switch', { name: 'Ask for a time' })).toHaveProperty('checked', false);
    expect(page.getByText('Adds a time to entries')).toBeTruthy();
  });

  test('Start with Category: saved, Add opens on the category list, then the keypad, and saves', async () => {
    const server = withAccounts();
    const page = await openAdding(server, size);
    const user = userEvent.setup();
    await user.click(page.getByRole('radio', { name: 'Category' }));
    expect(radios(page.getByRole('radiogroup', { name: 'Start with' }))).toEqual([
      ['Amount', 'false'],
      ['Category', 'true'],
    ]);
    await waitFor(() => expect(server.me.settings.startWith).toBe('category'));

    // On a phone the category list is all Add shows to start with, so no form to wait for
    await reloadApp(server, '/?accounts', { size });
    await user.click(await addButton());
    const search = await screen.findByLabelText('Find or create a category');
    // Opened and settled, the keyboard in its search (as AddEntry.test waits)
    await waitFor(() => expect(document.activeElement).toBe(search));
    await user.click(await screen.findByRole('button', { name: 'Transport' }));
    // The category picked, the keypad (or the Amount field) is next
    await waitFor(() => expect(screen.queryByLabelText('Find or create a category')).toBeNull());
    const form = await addForm();
    expect(form.getByRole('button', { name: /^For Transport/ })).toBeTruthy();
    await typeAmount(form, '6');
    await user.click(addSaveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(3));
    expect(server.transactions[2]).toMatchObject({ categoryId: TRANSPORT, amountCents: 600 });
  });

  test('Start with Amount keeps Add on the keypad', async () => {
    const server = withAccounts();
    server.me.settings.startWith = 'category';
    const page = await openAdding(server, size);
    await userEvent.setup().click(page.getByRole('radio', { name: 'Amount' }));
    await waitFor(() => expect(server.me.settings.startWith).toBe('amount'));
    const form = await openAdd(server, size);
    expect(screen.queryByLabelText('Find or create a category')).toBeNull();
    expect(form.getByRole('button', { name: /^From Wallet/ })).toBeTruthy();
  });

  test('Account to use offers Last used and the accounts in use, and Add starts on the one picked', async () => {
    const server = withAccounts();
    const page = await openAdding(server, size);
    const user = userEvent.setup();
    await user.click(page.getByRole('button', { name: /^Account to use/ }));
    const list = await screen.findByRole('radiogroup', { name: 'Account to use' });
    expect(radios(list)).toEqual([
      ['Last used', 'true'],
      ['Wallet', 'false'],
      ['Bank', 'false'],
    ]);
    await user.click(within(list).getByRole('radio', { name: 'Bank' }));
    await waitFor(() => expect(server.me.settings.defaultAccountId).toBe(BANK));
    await waitFor(() =>
      expect(screen.queryByRole('radiogroup', { name: 'Account to use' })).toBeNull(),
    );
    expect(page.getByRole('button', { name: /^Account to use/ }).textContent).toMatch(/Bank/);
    if (size === 'desktop') {
      expect(page.getByRole('button', { name: 'Account to use: Bank' })).toBeTruthy();
    }

    const form = await openAdd(server, size);
    expect(form.getByRole('button', { name: /^From Bank/ }).textContent).not.toMatch(/last used/);
  });

  test('Account to use back on Last used saves none', async () => {
    const server = withAccounts();
    server.me.settings.defaultAccountId = BANK;
    const page = await openAdding(server, size);
    const user = userEvent.setup();
    await user.click(page.getByRole('button', { name: /^Account to use/ }));
    const list = await screen.findByRole('radiogroup', { name: 'Account to use' });
    expect(radios(list)).toEqual([
      ['Last used', 'false'],
      ['Wallet', 'false'],
      ['Bank', 'true'],
    ]);
    await user.click(within(list).getByRole('radio', { name: 'Last used' }));
    await waitFor(() => expect(server.me.settings.defaultAccountId).toBeNull());
  });

  test('an account chosen and archived since reads as Last used', async () => {
    const server = withAccounts();
    server.me.settings.defaultAccountId = OLD;
    const page = await openAdding(server, size);
    expect(page.getByRole('button', { name: /^Account to use/ }).textContent).toMatch(/Last used/);
    expect(page.getByRole('button', { name: /^Account to use/ }).textContent).not.toMatch(
      /Old Card/,
    );
  });

  test('the account chosen wins over the one used last', async () => {
    const server = withAccounts();
    server.me.settings.defaultAccountId = BANK;
    renderApp(server, '/', { size });
    const user = userEvent.setup();
    // Used last: Wallet, picked for an entry by hand
    await user.click(await addButton());
    let form = await addForm();
    await user.click(form.getByRole('button', { name: /^From Bank/ }));
    await user.click(await screen.findByRole('radio', { name: /^Wallet/ }));
    await typeAmount(form, '2');
    await user.click(addSaveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(3));
    expect(server.transactions[2]).toMatchObject({ accountId: WALLET });

    await user.click(await addButton());
    form = await addForm();
    expect(form.getByRole('button', { name: /^From Bank/ })).toBeTruthy();
  });

  test('a setting that could not be saved goes back, and says so', async () => {
    const server = withAccounts();
    const page = await openAdding(server, size);
    server.failNext.profile = 500;
    await userEvent.setup().click(page.getByRole('switch', { name: 'Suggest as you type' }));
    expect(await screen.findByText('Something went wrong. Try again in a moment.')).toBeTruthy();
    await waitFor(() =>
      expect(page.getByRole('switch', { name: 'Suggest as you type' })).toHaveProperty(
        'checked',
        true,
      ),
    );
    expect(server.me.settings.suggestAsYouType).toBe(true);
  });
});

describe('suggestions as you type', () => {
  test.each(SIZES)('on: Add suggests payees used before, the latest first (%s)', async (size) => {
    renderApp(withAccounts(), '/', { size });
    await userEvent.setup().click(await addButton());
    const form = await addForm();
    await waitFor(() => expect(suggested(form)).toEqual(['Kedai Runcit', 'Kopi Corner']));
  });

  test.each(SIZES)(
    'a payee used for spending and for income, in other letters, is offered once (%s)',
    async (size) => {
      const server = withAccounts();
      server.transactions.push(
        spent(3, 'KOPI CORNER', '2026-01-05', { kind: 'income', categoryId: SALARY }),
      );
      renderApp(server, '/', { size });
      await userEvent.setup().click(await addButton());
      const form = await addForm();
      // The latest writing of it, once
      await waitFor(() => expect(suggested(form)).toEqual(['KOPI CORNER', 'Kedai Runcit']));
    },
  );

  test.each(SIZES)('off: Add suggests nothing, and never reads the payees (%s)', async (size) => {
    const server = withAccounts();
    const page = await openAdding(server, size);
    await userEvent.setup().click(page.getByRole('switch', { name: 'Suggest as you type' }));
    await waitFor(() => expect(server.me.settings.suggestAsYouType).toBe(false));
    const form = await openAdd(server, size);
    await settle();
    expect(suggested(form)).toBeNull();
    expect(payeeReads()).toBe(0);
  });
});
