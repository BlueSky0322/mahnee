// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Account, ChangesBody, LedgerChange, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer, Within } from '../../testing/app';
import {
  addButton,
  fakeServer,
  holdNext,
  reloadApp,
  renderApp,
  settle,
  setupAppTests,
} from '../../testing/app';

// Add, redesigned (R-Add, R-Desk-Add, R-Add-Pick, R-Desk-Add-Pick; digest 3.5, 4.7, 4.8;
// owner decisions D9 and D10): a full-screen form on phones and tablets with the keypad,
// a dialog on computers typed into from the keyboard; the amount worked out in whole
// cents; From and For; recent categories; one "Payee or note" field that fills the
// payee; Today and Repeat; a draft kept on close; a new category made from Add with the
// payee's hint; and a Save label that says what it will do. Saving goes through the
// ledger's change() and the outbox as before. The figures and names are made up.

// The owner's own zone, set before any date is made. Half past midnight there is still
// the day before in UTC, so a day taken from UTC rather than the person's clock shows.
vi.hoisted(() => {
  process.env.TZ = 'Asia/Kuala_Lumpur';
});

setupAppTests();

const NOW = new Date(2026, 7, 19, 0, 30);
const TODAY = '2026-08-19';
const YESTERDAY = '2026-08-18';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const SIZES = ['desktop', 'phone'] as const;
const WALLET = 'a'.repeat(16);
const BANK = 'b'.repeat(16);
const categoryId = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;

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

/** A server with RM 70 in a cash Wallet and RM 430 in a Bank account */
function withAccounts() {
  const server = fakeServer();
  seedAccount(server, { id: WALLET, name: 'Wallet', openingCents: 7_000 });
  seedAccount(server, { id: BANK, name: 'Bank', kind: 'bank', openingCents: 43_000 });
  return server;
}

let seeded = 0;
function seedTransaction(server: FakeServer, t: Partial<Transaction> = {}) {
  seeded++;
  server.transactions.push({
    id: seeded.toString(16).padStart(16, 'd'),
    kind: 'expense',
    accountId: WALLET,
    toAccountId: null,
    amountCents: 1_300,
    categoryId: categoryId('Groceries'),
    payee: null,
    note: null,
    date: '2026-08-02',
    createdAt: seeded,
    ...t,
  });
}

/** The server's categories as saved: the defaults, and Coffee under Food */
const COFFEE = 'e'.repeat(16);
function withCoffee(server: FakeServer) {
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  server.categories.push({
    id: COFFEE,
    name: 'Coffee',
    kind: 'expense',
    parentId: categoryId('Food'),
    position: 0,
    archived: false,
  });
}

/** An account's row on Accounts, read out with its balance, where a list drops the RM */
const accountRow = (name: string, balance: string) =>
  screen.findByRole('link', {
    name: new RegExp(`^${name}, [\\w-]+, ${balance.replace(/^(−?)RM /, '$1')}$`),
  });

/** Opens Add from the tab bar or the sidebar; the form, named as drawn */
async function openAdd(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await addButton());
  return within(await screen.findByRole('form', { name: 'Add a transaction' }));
}

const KEY_NAMES: Record<string, string> = {
  '.': 'Decimal point',
  '+': 'Plus',
  '-': 'Minus',
  '*': 'Times',
  '=': 'Work it out',
};

/** The Amount field computers type into (no keypad) */
const amountField = (form: Within) =>
  form.getByRole<HTMLInputElement>('textbox', { name: 'Amount' });

/** Types a sum: on the keypad where there is one, else into the Amount field */
async function typeAmount(user: ReturnType<typeof userEvent.setup>, form: Within, text: string) {
  const keypad = form.queryByRole('group', { name: 'Keypad' });
  if (keypad == null) {
    await user.type(amountField(form), text);
    return;
  }
  for (const c of text) {
    await user.click(within(keypad).getByRole('button', { name: KEY_NAMES[c] ?? c }));
  }
}

/** The amount as the display reads it out */
const amount = (form: Within) =>
  form.getByRole('status', { name: /^Amount, / }).getAttribute('aria-label');

/** The one button that saves, whatever it says */
const SAVE = /^(Save |Move |Type an amount|The total is below zero|Up to |Pick a day from 2000)/;
const saveButton = (form: Within) => form.getByRole('button', { name: SAVE });

/** Whether a button can't be used, by either way of saying so */
const unusable = (button: HTMLElement) =>
  (button as HTMLButtonElement).disabled || button.getAttribute('aria-disabled') === 'true';

/** The requests that carried changes */
const changePosts = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST');

/**
 * Save can't be used, and neither tapping it nor (on a computer) Enter in the Amount sends
 * anything or closes Add
 */
async function refusesToSave(user: ReturnType<typeof userEvent.setup>, form: Within) {
  expect(unusable(saveButton(form))).toBe(true);
  const before = changePosts().length;
  await user.click(saveButton(form));
  if (form.queryByRole('group', { name: 'Keypad' }) == null) {
    await user.click(amountField(form));
    await user.keyboard('{Enter}');
  }
  await settle();
  expect(changePosts().length).toBe(before);
  expect(screen.getByRole('form', { name: 'Add a transaction' })).toBeTruthy();
}

/** Every change each save carried, in order */
const sentChanges = (): LedgerChange[] =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST')
    .flatMap(([, init]) => (JSON.parse(init!.body as string) as ChangesBody).changes);

const checked = (group: HTMLElement) =>
  within(group)
    .getAllByRole('radio')
    .filter((r) => r.getAttribute('aria-checked') === 'true')
    .map((r) => r.textContent);

describe('the form', () => {
  test('on a phone: Close, Which way, the amount, From and For, the note, chips, the keypad', async () => {
    renderApp(withAccounts(), '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);

    expect(
      form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }),
    ).toBeTruthy();
    const way = form.getByRole('radiogroup', { name: 'Which way' });
    expect(
      within(way)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Expense', 'Income', 'Transfer']);
    expect(checked(way)).toEqual(['Expense']);
    expect(amount(form)).toBe('Amount, RM 0.00');
    expect(form.getByRole('button', { name: /^From Wallet/ })).toBeTruthy();
    expect(form.getByRole('button', { name: /^For Food/ })).toBeTruthy();
    const note = form.getByLabelText<HTMLInputElement>('Payee or note');
    expect(note.getAttribute('placeholder')).toBe('Payee or note, optional');
    expect(form.getByRole('radiogroup', { name: 'Recent categories' })).toBeTruthy();
    expect(form.getByRole('button', { name: 'Today' })).toBeTruthy();
    expect(form.getByRole('button', { name: 'Repeat' })).toBeTruthy();

    // The keys as drawn, 1-2-3 on top (D9: digits stay as drawn)
    const keypad = form.getByRole('group', { name: 'Keypad' });
    expect(
      within(keypad)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      '1',
      '2',
      '3',
      'Delete, hold to clear',
      '4',
      '5',
      '6',
      'Times',
      '7',
      '8',
      '9',
      'Minus',
      'Decimal point',
      '0',
      'Work it out',
      'Plus',
    ]);
    expect(
      within(keypad)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['1', '2', '3', '⌫', '4', '5', '6', '×', '7', '8', '9', '−', '.', '0', '=', '+']);
    // Nothing typed: the Save button says so and saves nothing
    expect(saveButton(form).textContent).toBe('Type an amount');
    await refusesToSave(user, form);
  });

  test('on a computer: a dialog, New entry, with no keypad, the hint, Cancel and Save', async () => {
    renderApp(withAccounts(), '/?accounts');
    const user = userEvent.setup();
    await user.click(await addButton());
    const dialog = within(await screen.findByRole('dialog', { name: 'New entry' }));
    const form = within(dialog.getByRole('form', { name: 'Add a transaction' }));
    expect(form.queryByRole('group', { name: 'Keypad' })).toBeNull();
    // The amount is a field of its own, ready to type into, and the hint describes it
    const field = amountField(form);
    await waitFor(() => expect(document.activeElement).toBe(field));
    const hint = document.getElementById(field.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('Sums work: 8+4.5');
    expect(form.getByRole('status', { name: 'Amount, RM 0.00' })).toBeTruthy();
    expect(form.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(
      form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }),
    ).toBeTruthy();
    expect(saveButton(form).textContent).toMatch(/^Type an amount/);
    // The keys beside them
    expect(form.getByText('Esc')).toBeTruthy();
    expect(form.getByText('Enter')).toBeTruthy();
  });

  test('on a tablet: the phone’s full-screen form, with the keypad', async () => {
    renderApp(withAccounts(), '/?accounts', { size: 'tablet' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    expect(form.getByRole('group', { name: 'Keypad' })).toBeTruthy();
    expect(form.queryByText('Sums work: 8+4.5')).toBeNull();
  });
});

describe('the amount', () => {
  test.each(SIZES)('works out a sum in whole cents and saves its total (%s)', async (size) => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();
    const form = await openAdd(user);

    await typeAmount(user, form, '7+2.35*2');
    expect(form.getByText('7 + 2.35 × 2 =')).toBeTruthy();
    expect(amount(form)).toBe('Amount, RM 11.70');
    expect(saveButton(form).textContent).toMatch(/^Save RM 11\.70/);
    await typeAmount(user, form, '=');
    expect(form.queryByText('7 + 2.35 × 2 =')).toBeNull();
    expect(amount(form)).toBe('Amount, RM 11.70');
    await user.click(saveButton(form));

    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );
    expect(await accountRow('Wallet', 'RM 58.30')).toBeTruthy();
    await waitFor(() =>
      expect(server.transactions).toEqual([
        expect.objectContaining({
          kind: 'expense',
          accountId: WALLET,
          amountCents: 1_170,
          categoryId: categoryId('Food'),
          payee: null,
          note: null,
          date: TODAY,
        }),
      ]),
    );
  });

  test('on a computer the amount takes the keys straight away, and Enter saves', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts');
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.keyboard('6.4');
    expect(amount(form)).toBe('Amount, RM 6.40');
    await user.keyboard('{Backspace}');
    expect(amount(form)).toBe('Amount, RM 6.00');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    expect(server.transactions[0].amountCents).toBe(600);
  });

  test('on a computer the Amount takes a pasted figure, and passes over letters', async () => {
    renderApp(withAccounts(), '/?accounts');
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.paste('1,250.75');
    expect(amountField(form).value).toBe('1250.75');
    expect(amount(form)).toBe('Amount, RM 1,250.75');
    await user.keyboard('abc*2');
    expect(amountField(form).value).toBe('1250.75×2');
    expect(form.getByText('1,250.75 × 2 =')).toBeTruthy();
    expect(amount(form)).toBe('Amount, RM 2,501.50');
    expect(saveButton(form).textContent).toMatch(/^Save RM 2,501\.50/);
  });

  test('on a computer, keys typed in the note are the note’s, not the amount’s', async () => {
    renderApp(withAccounts(), '/?accounts');
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.keyboard('3');
    await user.click(form.getByLabelText<HTMLInputElement>('Payee or note'));
    await user.keyboard('7-Eleven');
    expect(form.getByLabelText<HTMLInputElement>('Payee or note')).toHaveProperty(
      'value',
      '7-Eleven',
    );
    expect(amount(form)).toBe('Amount, RM 3.00');
  });

  test.each(SIZES)('a total below zero can not be saved, and says so (%s)', async (size) => {
    renderApp(withAccounts(), '/?accounts', { size });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '3-5.5');
    expect(amount(form)).toBe('Amount, RM −2.50');
    expect(saveButton(form).textContent).toMatch(/^The total is below zero/);
    await refusesToSave(user, form);
    await typeAmount(user, form, '+9');
    expect(saveButton(form).textContent).toMatch(/^Save RM 6\.50/);
  });

  test.each(SIZES)('a total of nothing can not be saved (%s)', async (size) => {
    renderApp(withAccounts(), '/?accounts', { size });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '4-4');
    expect(saveButton(form).textContent).toMatch(/^Type an amount/);
    await refusesToSave(user, form);
  });

  test.each(SIZES)(
    'refuses a key past the largest amount, and says what it is (%s)',
    async (size) => {
      const server = withAccounts();
      renderApp(server, '/?accounts', { size });
      const user = userEvent.setup();
      const form = await openAdd(user);
      await typeAmount(user, form, '10000000');
      expect(amount(form)).toBe('Amount, RM 10,000,000.00');
      expect(saveButton(form).textContent).toMatch(/^Save RM 10,000,000\.00/);
      await typeAmount(user, form, '5');
      // Refused, and said where it's heard as well as on the button
      expect(amount(form)).toBe('Amount, RM 10,000,000.00. Up to 10,000,000');
      // In the live region's own words, which is what a screen reader speaks as it changes
      const live = form.getByRole('status', { name: /^Amount, / });
      expect(live.getAttribute('aria-live')).toBe('polite');
      expect(live.textContent).toContain('Up to 10,000,000');
      expect(saveButton(form).textContent).toMatch(/^Up to 10,000,000/);
      await refusesToSave(user, form);
      // The next key taken clears it
      await typeAmount(user, form, '-1');
      expect(saveButton(form).textContent).toMatch(/^Save RM 9,999,999\.00/);
      expect(live.textContent).not.toContain('Up to');
      await user.click(saveButton(form));
      await waitFor(() => expect(server.transactions).toHaveLength(1));
      expect(server.transactions[0].amountCents).toBe(999_999_900);
    },
  );

  test('on a phone, Delete takes off one character, and holding it clears the amount', async () => {
    renderApp(withAccounts(), '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '45+6');
    const del = form.getByRole('button', { name: 'Delete, hold to clear' });
    await user.click(del);
    expect(amount(form)).toBe('Amount, RM 45.00');
    expect(form.getByText('45 +')).toBeTruthy();
    await user.pointer({ keys: '[MouseLeft>]', target: del });
    await act(() => new Promise((done) => setTimeout(done, 900)));
    await user.pointer({ keys: '[/MouseLeft]', target: del });
    expect(amount(form)).toBe('Amount, RM 0.00');
    expect(saveButton(form).textContent).toBe('Type an amount');
  });
});

describe('From and For', () => {
  test.each(SIZES)('saves an expense from the account and category picked (%s)', async (size) => {
    const server = withAccounts();
    withCoffee(server);
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();
    const form = await openAdd(user);

    await user.click(form.getByRole('button', { name: /^From Wallet/ }));
    await user.click(await screen.findByRole('radio', { name: /^Bank/ }));
    expect(form.getByRole('button', { name: /^From Bank/ })).toBeTruthy();

    await user.click(form.getByRole('button', { name: /^For Food/ }));
    await user.click(await screen.findByRole('button', { name: 'Food › Coffee' }));
    expect(form.getByRole('button', { name: /^For Food › Coffee/ })).toBeTruthy();

    await typeAmount(user, form, '9.9');
    await user.click(saveButton(form));
    await waitFor(() =>
      expect(server.transactions).toEqual([
        expect.objectContaining({ accountId: BANK, categoryId: COFFEE, amountCents: 990 }),
      ]),
    );
    expect(await accountRow('Bank', 'RM 420.10')).toBeTruthy();
  });

  test.each(SIZES)(
    'income: Into and From, + RM, its own chips, saved as income (%s)',
    async (size) => {
      const server = withAccounts();
      renderApp(server, '/?accounts', { size });
      const user = userEvent.setup();
      const form = await openAdd(user);
      await user.click(form.getByRole('radio', { name: 'Income' }));

      expect(form.getByRole('button', { name: /^Into Wallet/ })).toBeTruthy();
      expect(form.getByRole('button', { name: /^From Salary/ })).toBeTruthy();
      expect(
        within(form.getByRole('status', { name: /^Amount, / })).getByText('+ RM'),
      ).toBeTruthy();
      const recent = form.getByRole('radiogroup', { name: 'Recent categories' });
      expect(
        within(recent)
          .getAllByRole('radio')
          .map((r) => r.textContent),
      ).toEqual(['Salary', 'Other income']);
      await user.click(within(recent).getByRole('radio', { name: 'Other income' }));
      expect(form.getByRole('button', { name: /^From Other income/ })).toBeTruthy();

      await typeAmount(user, form, '1250.5');
      expect(saveButton(form).textContent).toMatch(/^Save RM 1,250\.50/);
      await user.click(saveButton(form));
      await waitFor(() =>
        expect(server.transactions).toEqual([
          expect.objectContaining({
            kind: 'income',
            accountId: WALLET,
            amountCents: 125_050,
            categoryId: categoryId('Other income'),
          }),
        ]),
      );
    },
  );

  test.each(SIZES)(
    'a transfer: From and To with balances, no chips, Move RM (%s)',
    async (size) => {
      const server = withAccounts();
      renderApp(server, '/?accounts', { size });
      const user = userEvent.setup();
      const form = await openAdd(user);
      await user.click(form.getByRole('radio', { name: 'Transfer' }));

      expect(form.getByRole('button', { name: /^From Wallet RM 70\.00/ })).toBeTruthy();
      expect(form.getByRole('button', { name: /^To Bank RM 430\.00/ })).toBeTruthy();
      expect(form.queryByRole('radiogroup', { name: 'Recent categories' })).toBeNull();

      // From the bank to the wallet: To is never the account it comes from
      await user.click(form.getByRole('button', { name: /^From Wallet/ }));
      await user.click(await screen.findByRole('radio', { name: /^Bank/ }));
      expect(form.getByRole('button', { name: /^To Wallet RM 70\.00/ })).toBeTruthy();

      await typeAmount(user, form, '25');
      expect(saveButton(form).textContent).toMatch(/^Move RM 25\.00/);
      await user.click(saveButton(form));
      await waitFor(() =>
        expect(server.transactions).toEqual([
          expect.objectContaining({
            kind: 'transfer',
            accountId: BANK,
            toAccountId: WALLET,
            amountCents: 2_500,
            categoryId: null,
          }),
        ]),
      );
      expect(await accountRow('Wallet', 'RM 95.00')).toBeTruthy();
      expect(await accountRow('Bank', 'RM 405.00')).toBeTruthy();
    },
  );

  test('with one account, a transfer says it needs another, and can not be moved', async () => {
    const server = fakeServer();
    seedAccount(server, { id: WALLET, name: 'Wallet' });
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.click(form.getByRole('radio', { name: 'Transfer' }));
    await typeAmount(user, form, '5');
    expect(form.getByText('Add another account to move money to')).toBeTruthy();
    await refusesToSave(user, form);
  });

  test('From says "last used" for the account used last, and Add opens on it', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    // Nothing used yet: the first account, with no hint
    expect(form.getByRole('button', { name: /^From Wallet/ }).textContent).not.toMatch(/last used/);
    await user.click(form.getByRole('button', { name: /^From Wallet/ }));
    await user.click(await screen.findByRole('radio', { name: /^Bank/ }));
    await typeAmount(user, form, '2');
    await user.click(saveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));

    await reloadApp(server, '/?accounts', { size: 'phone' });
    form = await openAdd(user);
    expect(form.getByRole('button', { name: /^From Bank/ }).textContent).toMatch(/last used/);
  });

  test('opens on the account set as the one to use, when it is running', async () => {
    const server = withAccounts();
    server.me.settings = { ...server.me.settings, defaultAccountId: BANK };
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    expect(form.getByRole('button', { name: /^From Bank/ })).toBeTruthy();
  });

  test("on an account's page, Add opens on that account", async () => {
    renderApp(withAccounts(), `/?account=${BANK}`, { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    expect(form.getByRole('button', { name: /^From Bank/ })).toBeTruthy();
  });
});

describe('recent categories', () => {
  test('start as the first five of the kind, the one used last chosen', async () => {
    renderApp(withAccounts(), '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    const recent = form.getByRole('radiogroup', { name: 'Recent categories' });
    expect(
      within(recent)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Food', 'Transport', 'Groceries', 'Bills', 'Shopping']);
    expect(checked(recent)).toEqual(['Food']);
  });

  test.each(SIZES)('put the ones used on this device first, newest first (%s)', async (size) => {
    const server = withAccounts();
    withCoffee(server);
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();

    for (const [pick, typed] of [
      ['Fun', '3'],
      ['Food › Coffee', '4'],
    ] as const) {
      const form = await openAdd(user);
      await user.click(form.getByRole('button', { name: /^For / }));
      await user.click(await screen.findByRole('button', { name: pick }));
      await typeAmount(user, form, typed);
      await user.click(saveButton(form));
      await waitFor(() =>
        expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
      );
    }

    await reloadApp(server, '/?accounts', { size });
    const form = await openAdd(user);
    const recent = form.getByRole('radiogroup', { name: 'Recent categories' });
    expect(
      within(recent)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Coffee', 'Fun', 'Food', 'Transport', 'Groceries']);
    expect(checked(recent)).toEqual(['Coffee']);
    expect(form.getByRole('button', { name: /^For Food › Coffee/ })).toBeTruthy();
    // Tapping one makes it the category
    await user.click(within(recent).getByRole('radio', { name: 'Fun' }));
    expect(checked(recent)).toEqual(['Fun']);
    expect(form.getByRole('button', { name: /^For Fun/ })).toBeTruthy();
  });

  test('leave out archived categories', async () => {
    const server = withAccounts();
    server.categories = DEFAULT_CATEGORIES.map((c) => ({
      ...c,
      archived: c.name === 'Transport',
    }));
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    const recent = form.getByRole('radiogroup', { name: 'Recent categories' });
    expect(
      within(recent)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Food', 'Groceries', 'Bills', 'Shopping', 'Health']);
  });
});

describe('Payee or note (D10)', () => {
  test.each(SIZES)('fills the payee, trimmed, and leaves the note empty (%s)', async (size) => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '12');
    await user.type(form.getByLabelText<HTMLInputElement>('Payee or note'), '  Kedai Mesra ');
    await user.click(saveButton(form));
    await waitFor(() =>
      expect(server.transactions).toEqual([
        expect.objectContaining({ payee: 'Kedai Mesra', note: null }),
      ]),
    );
  });

  test('takes at most 80 characters, the longest payee', async () => {
    renderApp(withAccounts(), '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    expect(form.getByLabelText<HTMLInputElement>('Payee or note').getAttribute('maxlength')).toBe(
      '80',
    );
  });

  test('editing an entry keeps the payee and the note apart', async () => {
    const server = withAccounts();
    seedTransaction(server, { payee: 'Pasar Tani', note: 'for the week' });
    renderApp(server, `/?account=${WALLET}`, { size: 'phone' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Pasar Tani/ }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Edit transaction' }));
    expect(sheet.getByLabelText('Paid to')).toHaveProperty('value', 'Pasar Tani');
    expect(sheet.getByLabelText('Note')).toHaveProperty('value', 'for the week');
  });
});

describe('Today and Repeat', () => {
  test.each(SIZES)('Today picks another day, and the chip says which (%s)', async (size) => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.click(form.getByRole('button', { name: 'Today' }));
    const day = await screen.findByLabelText('Date');
    expect(day).toHaveProperty('value', TODAY);
    expect(day.getAttribute('max')).toBe(TODAY);
    expect(day.getAttribute('min')).toBe('2000-01-01');
    await user.clear(day);
    await user.type(day, YESTERDAY);
    await settle();
    expect(form.getByRole('button', { name: 'Yesterday' })).toBeTruthy();
    await typeAmount(user, form, '8');
    await user.click(saveButton(form));
    await waitFor(() =>
      expect(server.transactions).toEqual([expect.objectContaining({ date: YESTERDAY })]),
    );
  });

  test.each(SIZES)('Repeat sets it up to repeat monthly from its day (%s)', async (size) => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '89');
    await user.type(form.getByLabelText<HTMLInputElement>('Payee or note'), 'Gym');
    await user.click(form.getByRole('button', { name: 'Repeat' }));
    await user.click(await screen.findByRole('radio', { name: 'Monthly' }));
    expect(form.getByRole('button', { name: 'Monthly' })).toBeTruthy();
    await user.click(saveButton(form));
    await waitFor(() => expect(server.recurring).toHaveLength(1));
    expect(server.recurring[0]).toEqual(
      expect.objectContaining({
        schedule: 'monthly',
        day: 19,
        amountCents: 8_900,
        payee: 'Gym',
        accountId: WALLET,
        nextDue: '2026-09-19',
      }),
    );
    expect(server.transactions).toEqual([
      expect.objectContaining({ amountCents: 8_900, date: TODAY }),
    ]);
    // In one save, the transaction first
    expect(changePosts()).toHaveLength(1);
    expect(sentChanges().map((c) => c.op)).toEqual(['addTransaction', 'addRecurring']);
  });
});

describe('the draft', () => {
  test.each(SIZES)('Close keeps what was typed, and it opens again as left (%s)', async (size) => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await user.click(form.getByRole('radio', { name: 'Income' }));
    await typeAmount(user, form, '3+4');
    await user.type(form.getByLabelText<HTMLInputElement>('Payee or note'), 'Refund');
    await user.click(form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }));
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );
    expect(server.transactions).toEqual([]);

    form = await openAdd(user);
    expect(checked(form.getByRole('radiogroup', { name: 'Which way' }))).toEqual(['Income']);
    expect(amount(form)).toBe('Amount, RM 7.00');
    expect(form.getByText('3 + 4 =')).toBeTruthy();
    expect(form.getByLabelText<HTMLInputElement>('Payee or note')).toHaveProperty(
      'value',
      'Refund',
    );
  });

  test('Back on a phone closes Add, keeping the draft, before leaving the page', async () => {
    renderApp(withAccounts(), '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await typeAmount(user, form, '15');
    act(() => window.history.back());
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );
    expect(window.location.search).toBe('?accounts');
    form = await openAdd(user);
    expect(amount(form)).toBe('Amount, RM 15.00');
  });

  test('Esc and Cancel on a computer keep the draft too', async () => {
    renderApp(withAccounts(), '/?accounts');
    const user = userEvent.setup();
    let form = await openAdd(user);
    await user.keyboard('21');
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );
    form = await openAdd(user);
    expect(amount(form)).toBe('Amount, RM 21.00');
    await user.keyboard('5');
    await user.click(form.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );
    form = await openAdd(user);
    expect(amount(form)).toBe('Amount, RM 215.00');
  });

  test('is kept on the device through a reload', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await typeAmount(user, form, '6.5');
    await user.type(form.getByLabelText<HTMLInputElement>('Payee or note'), 'Kopi');
    await user.click(form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }));

    await reloadApp(server, '/?accounts', { size: 'phone' });
    form = await openAdd(user);
    expect(amount(form)).toBe('Amount, RM 6.50');
    expect(form.getByLabelText<HTMLInputElement>('Payee or note')).toHaveProperty('value', 'Kopi');
  });

  test.each(SIZES)('goes once saved: the next one starts fresh (%s)', async (size) => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await typeAmount(user, form, '6');
    await user.type(form.getByLabelText<HTMLInputElement>('Payee or note'), 'Kopi');
    await user.click(saveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));

    form = await openAdd(user);
    expect(amount(form)).toBe('Amount, RM 0.00');
    expect(form.getByLabelText<HTMLInputElement>('Payee or note')).toHaveProperty('value', '');
  });
});

describe('a new category from Add', () => {
  test.each(SIZES)(
    'is made under the category the payee was last in, before the entry, in one save (%s)',
    async (size) => {
      const server = withAccounts();
      seedTransaction(server, { payee: 'Kedai Mesra', categoryId: categoryId('Groceries') });
      renderApp(server, '/?accounts', { size });
      const user = userEvent.setup();
      const form = await openAdd(user);
      await typeAmount(user, form, '14');
      await user.type(form.getByLabelText<HTMLInputElement>('Payee or note'), 'kedai mesra');
      await user.click(form.getByRole('button', { name: /^For Food/ }));
      await user.type(await screen.findByLabelText('Find or create a category'), 'Tea leaves');

      expect(await screen.findByText('New category: Tea leaves')).toBeTruthy();
      const under = await screen.findByRole('option', { name: /^Under Groceries/ });
      expect(within(under).getByText('Kedai Mesra was in Groceries')).toBeTruthy();
      expect(screen.getByRole('option', { name: 'As its own expense category' })).toBeTruthy();
      expect(screen.getByRole('option', { name: /^Under another category/ })).toBeTruthy();
      await user.click(under);

      expect(form.getByRole('button', { name: /^For Groceries › Tea leaves/ })).toBeTruthy();
      await user.click(saveButton(form));
      await waitFor(() => expect(server.transactions).toHaveLength(2));
      const made = server.categories.find((c) => c.name === 'Tea leaves');
      expect(made).toEqual(
        expect.objectContaining({ kind: 'expense', parentId: categoryId('Groceries') }),
      );
      expect(server.transactions[1]).toEqual(
        expect.objectContaining({ categoryId: made!.id, payee: 'kedai mesra', amountCents: 1_400 }),
      );
      // The category first, then the entry that names it, in one request
      expect(changePosts()).toHaveLength(1);
      expect(sentChanges().map((c) => c.op)).toEqual(['addCategory', 'addTransaction']);
    },
  );

  test('the hint names a subcategory’s own category, and the new one goes beside it', async () => {
    const server = withAccounts();
    withCoffee(server);
    seedTransaction(server, { payee: 'Tealeaf Co', categoryId: COFFEE });
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.type(form.getByLabelText<HTMLInputElement>('Payee or note'), 'Tealeaf Co');
    await user.click(form.getByRole('button', { name: /^For / }));
    await user.type(await screen.findByLabelText('Find or create a category'), 'Bubble cups');
    const under = await screen.findByRole('option', { name: /^Under Food/ });
    expect(within(under).getByText('Tealeaf Co was in Food › Coffee')).toBeTruthy();
  });

  test.each(SIZES)(
    'with no payee hint: its own category, or under another one picked (%s)',
    async (size) => {
      const server = withAccounts();
      renderApp(server, '/?accounts', { size });
      const user = userEvent.setup();
      let form = await openAdd(user);
      await user.click(form.getByRole('button', { name: /^For Food/ }));
      await user.type(await screen.findByLabelText('Find or create a category'), 'Pets');
      expect(await screen.findByText('New category: Pets')).toBeTruthy();
      expect(screen.queryByRole('option', { name: /^Under (?!another)/ })).toBeNull();
      await user.click(screen.getByRole('option', { name: 'As its own expense category' }));
      expect(form.getByRole('button', { name: /^For Pets/ })).toBeTruthy();
      await typeAmount(user, form, '30');
      await user.click(saveButton(form));
      await waitFor(() => expect(server.transactions).toHaveLength(1));
      expect(server.categories.find((c) => c.name === 'Pets')).toEqual(
        expect.objectContaining({ kind: 'expense', parentId: null }),
      );

      form = await openAdd(user);
      await user.click(form.getByRole('button', { name: /^For / }));
      await user.type(await screen.findByLabelText('Find or create a category'), 'Parking');
      await user.click(await screen.findByRole('option', { name: /^Under another category/ }));
      await user.click(await screen.findByRole('button', { name: 'Transport' }));
      expect(form.getByRole('button', { name: /^For Transport › Parking/ })).toBeTruthy();
    },
  );

  test('an income category is offered as its own income category', async () => {
    renderApp(withAccounts(), '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.click(form.getByRole('radio', { name: 'Income' }));
    await user.click(form.getByRole('button', { name: /^From Salary/ }));
    await user.type(await screen.findByLabelText('Find or create a category'), 'Dividends');
    expect(await screen.findByRole('option', { name: 'As its own income category' })).toBeTruthy();
  });

  test('a name already there is found, not made again', async () => {
    renderApp(withAccounts(), '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.click(form.getByRole('button', { name: /^For Food/ }));
    await user.type(await screen.findByLabelText('Find or create a category'), 'bills');
    expect(await screen.findByRole('button', { name: 'Bills' })).toBeTruthy();
    expect(screen.queryByText(/^New category:/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Bills' }));
    expect(form.getByRole('button', { name: /^For Bills/ })).toBeTruthy();
  });

  test('on a phone, the category page goes back to the entry with Entry and with Back', async () => {
    renderApp(withAccounts(), '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '2');
    await user.click(form.getByRole('button', { name: /^For Food/ }));
    expect(await screen.findByRole('heading', { name: 'Category' })).toBeTruthy();
    expect(screen.getByText('Recent')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Entry' }));
    expect(await screen.findByRole('form', { name: 'Add a transaction' })).toBeTruthy();
    await user.click(form.getByRole('button', { name: /^For Food/ }));
    await screen.findByRole('heading', { name: 'Category' });
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Category' })).toBeNull());
    expect(amount(within(screen.getByRole('form', { name: 'Add a transaction' })))).toBe(
      'Amount, RM 2.00',
    );
  });

  test('made offline, it is kept through a reload and sent, before its entry, once back', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    await accountRow('Wallet', 'RM 70.00');
    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    act(() => void window.dispatchEvent(new Event('offline')));

    const form = await openAdd(user);
    await user.click(form.getByRole('button', { name: /^For Food/ }));
    await user.type(await screen.findByLabelText('Find or create a category'), 'Pets');
    await user.click(await screen.findByRole('option', { name: 'As its own expense category' }));
    await typeAmount(user, form, '30');
    await user.click(saveButton(form));
    expect(await accountRow('Wallet', 'RM 40.00')).toBeTruthy();

    await reloadApp(server, '/?accounts', { size: 'phone' });
    expect(await accountRow('Wallet', 'RM 40.00')).toBeTruthy();
    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    const pets = server.categories.find((c) => c.name === 'Pets');
    expect(server.transactions[0].categoryId).toBe(pets?.id);
    expect(sentChanges().map((c) => c.op)).toEqual(['addCategory', 'addTransaction']);
  });
});

describe('start with (D9)', () => {
  test('opens on the amount by default', async () => {
    renderApp(withAccounts(), '/?accounts');
    const user = userEvent.setup();
    const form = await openAdd(user);
    expect(screen.queryByLabelText('Find or create a category')).toBeNull();
    await user.keyboard('4');
    expect(amount(form)).toBe('Amount, RM 4.00');
  });

  test.each(SIZES)(
    'opens on the categories when set to start with the category (%s)',
    async (size) => {
      const server = withAccounts();
      server.me.settings = { ...server.me.settings, startWith: 'category' };
      renderApp(server, '/?accounts', { size });
      const user = userEvent.setup();
      await user.click(await addButton());
      const search = await screen.findByLabelText('Find or create a category');
      await waitFor(() => expect(document.activeElement).toBe(search));
      await user.click(await screen.findByRole('button', { name: 'Transport' }));
      const form = within(await screen.findByRole('form', { name: 'Add a transaction' }));
      expect(form.getByRole('button', { name: /^For Transport/ })).toBeTruthy();
      await typeAmount(user, form, '3');
      await user.click(saveButton(form));
      await waitFor(() =>
        expect(server.transactions).toEqual([
          expect.objectContaining({ categoryId: categoryId('Transport'), amountCents: 300 }),
        ]),
      );
    },
  );
});

describe('saving', () => {
  test.each(SIZES)("puts a refused one back, with the server's explanation (%s)", async (size) => {
    const server = withAccounts();
    server.failNext.changes = { status: 409, error: 'Wallet is archived' };
    const held = holdNext(server, 'POST', '/api/changes');
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '5');
    await user.click(saveButton(form));
    // Shown straight away, before the server answers
    expect(await accountRow('Wallet', 'RM 65.00')).toBeTruthy();
    held.release();
    expect(await screen.findByText('Wallet is archived')).toBeTruthy();
    expect(await accountRow('Wallet', 'RM 70.00')).toBeTruthy();
    expect(server.transactions).toEqual([]);
  });

  test.each(SIZES)(
    'a refused new category takes its entry back with it, and says why (%s)',
    async (size) => {
      const server = withAccounts();
      server.failNext.changes = { status: 409, error: 'Groceries has 50 subcategories' };
      const held = holdNext(server, 'POST', '/api/changes');
      renderApp(server, '/?accounts', { size });
      const user = userEvent.setup();
      const form = await openAdd(user);
      await user.click(form.getByRole('button', { name: /^For Food/ }));
      await user.type(await screen.findByLabelText('Find or create a category'), 'Tea leaves');
      await user.click(await screen.findByRole('option', { name: 'As its own expense category' }));
      await typeAmount(user, form, '5');
      await user.click(saveButton(form));
      // Shown straight away, the category with it
      expect(await accountRow('Wallet', 'RM 65.00')).toBeTruthy();
      held.release();
      expect(await screen.findByText('Groceries has 50 subcategories')).toBeTruthy();
      expect(await accountRow('Wallet', 'RM 70.00')).toBeTruthy();
      expect(server.transactions).toEqual([]);
      expect(server.categories.some((c) => c.name === 'Tea leaves')).toBe(false);
      // The category goes from what's offered too
      const again = await openAdd(user);
      await user.click(again.getByRole('button', { name: /^For / }));
      expect(await screen.findByRole('region', { name: 'Recent' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Tea leaves' })).toBeNull();
      expect(changePosts()).toHaveLength(1);
      expect(sentChanges().map((c) => c.op)).toEqual(['addCategory', 'addTransaction']);
    },
  );

  test('the first change of all saves the default categories with it', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '5');
    await user.click(saveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    expect(server.categories).toHaveLength(DEFAULT_CATEGORIES.length);
  });
});

describe('the day, by the person’s own clock', () => {
  test('Today is the local day, though it is still yesterday in UTC', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.click(form.getByRole('button', { name: 'Today' }));
    const day = await screen.findByLabelText('Date');
    expect(day).toHaveProperty('value', TODAY);
    expect(day.getAttribute('max')).toBe(TODAY);
    await typeAmount(user, form, '3');
    await user.click(saveButton(form));
    await waitFor(() =>
      expect(server.transactions).toEqual([expect.objectContaining({ date: TODAY })]),
    );
  });

  test('left open past midnight, Today is the new day', async () => {
    const server = withAccounts();
    vi.setSystemTime(new Date(2026, 7, 19, 23, 59));
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '4');
    vi.setSystemTime(new Date(2026, 7, 20, 0, 1));
    await typeAmount(user, form, '2');
    expect(form.getByRole('button', { name: 'Today' })).toBeTruthy();
    await user.click(saveButton(form));
    await waitFor(() =>
      expect(server.transactions).toEqual([
        expect.objectContaining({ date: '2026-08-20', amountCents: 4_200 }),
      ]),
    );
  });

  test.each(SIZES)('a day before 2000 or still to come can not be saved (%s)', async (size) => {
    renderApp(withAccounts(), '/?accounts', { size });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '8');
    await user.click(form.getByRole('button', { name: 'Today' }));
    const day = await screen.findByLabelText('Date');
    for (const bad of ['1999-12-31', '2026-08-20']) {
      await user.clear(day);
      await user.type(day, bad);
      await settle();
      expect(saveButton(form).textContent).toMatch(/^Pick a day from 2000 up to today/);
      await refusesToSave(user, form);
    }
  });
});

describe('the draft, everything in it', () => {
  test('keeps the account, category, day, repeat, note and amount', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await user.click(form.getByRole('button', { name: /^From Wallet/ }));
    await user.click(await screen.findByRole('radio', { name: /^Bank/ }));
    await user.click(form.getByRole('button', { name: /^For Food/ }));
    await user.click(await screen.findByRole('button', { name: 'Fun' }));
    await user.click(form.getByRole('button', { name: 'Today' }));
    const day = await screen.findByLabelText('Date');
    await user.clear(day);
    await user.type(day, YESTERDAY);
    await user.click(form.getByRole('button', { name: 'Repeat' }));
    await user.click(await screen.findByRole('radio', { name: 'Monthly' }));
    await user.type(form.getByLabelText<HTMLInputElement>('Payee or note'), 'Cinema');
    await typeAmount(user, form, '28');
    await user.click(form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }));

    await reloadApp(server, '/?accounts', { size: 'phone' });
    form = await openAdd(user);
    expect(form.getByRole('button', { name: /^From Bank/ })).toBeTruthy();
    expect(form.getByRole('button', { name: /^For Fun/ })).toBeTruthy();
    expect(form.getByRole('button', { name: 'Yesterday' })).toBeTruthy();
    expect(form.getByRole('button', { name: 'Monthly' })).toBeTruthy();
    expect(form.getByLabelText<HTMLInputElement>('Payee or note')).toHaveProperty(
      'value',
      'Cinema',
    );
    expect(amount(form)).toBe('Amount, RM 28.00');
  });

  test('a draft left on Today opens on the new day once a day has passed', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await typeAmount(user, form, '5');
    await user.click(form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }));

    vi.setSystemTime(new Date(2026, 7, 20, 9, 0));
    await reloadApp(server, '/?accounts', { size: 'phone' });
    form = await openAdd(user);
    expect(form.getByRole('button', { name: 'Today' })).toBeTruthy();
    await user.click(saveButton(form));
    await waitFor(() =>
      expect(server.transactions).toEqual([expect.objectContaining({ date: '2026-08-20' })]),
    );
  });

  test('an Add closed untouched keeps no draft, so last used still decides', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await user.click(form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }));
    form = await openAdd(user);
    await user.click(form.getByRole('button', { name: /^From Wallet/ }));
    await user.click(await screen.findByRole('radio', { name: /^Bank/ }));
    await typeAmount(user, form, '2');
    await user.click(saveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    form = await openAdd(user);
    expect(form.getByRole('button', { name: /^From Bank/ })).toBeTruthy();
  });

  test('a draft emptied by hand is no draft', async () => {
    renderApp(withAccounts(), '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await typeAmount(user, form, '9');
    await user.click(form.getByRole('button', { name: 'Delete, hold to clear' }));
    await user.click(form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }));
    expect(Object.keys(localStorage).filter((k) => k.startsWith('mahnee:addDraft:'))).toEqual([]);
    form = await openAdd(user);
    expect(amount(form)).toBe('Amount, RM 0.00');
  });

  test('a draft whose account or category has gone opens on what can be used, the rest kept', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await user.click(form.getByRole('button', { name: /^From Wallet/ }));
    await user.click(await screen.findByRole('radio', { name: /^Bank/ }));
    await user.click(form.getByRole('button', { name: /^For Food/ }));
    await user.click(await screen.findByRole('button', { name: 'Fun' }));
    await user.type(form.getByLabelText<HTMLInputElement>('Payee or note'), 'Arcade');
    await typeAmount(user, form, '11');
    await user.click(form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }));

    server.accounts[1].archived = true;
    server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c, archived: c.name === 'Fun' }));
    await reloadApp(server, '/?accounts', { size: 'phone' });
    form = await openAdd(user);
    expect(form.getByRole('button', { name: /^From Wallet/ })).toBeTruthy();
    expect(form.getByRole('button', { name: /^For Food/ })).toBeTruthy();
    expect(amount(form)).toBe('Amount, RM 11.00');
    expect(form.getByLabelText<HTMLInputElement>('Payee or note')).toHaveProperty(
      'value',
      'Arcade',
    );
  });

  test('another person signing in on this device never sees it', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await typeAmount(user, form, '13');
    await user.click(form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }));

    server.me = { ...server.me, email: 'other@example.com' };
    await reloadApp(server, '/?accounts', { size: 'phone' });
    form = await openAdd(user);
    expect(amount(form)).toBe('Amount, RM 0.00');
  });
});

describe('which account Add opens on', () => {
  const VISA = 'f'.repeat(16);
  const withThree = () => {
    const server = withAccounts();
    seedAccount(server, { id: VISA, name: 'Visa', kind: 'card', openingCents: -12_000 });
    return server;
  };

  test("an account's page beats the account set to use", async () => {
    const server = withAccounts();
    server.me.settings = { ...server.me.settings, defaultAccountId: WALLET };
    renderApp(server, `/?account=${BANK}`, { size: 'phone' });
    const form = await openAdd(userEvent.setup());
    expect(form.getByRole('button', { name: /^From Bank/ })).toBeTruthy();
  });

  test('the account set to use, archived or unknown, gives way to the one used last', async () => {
    const server = withThree();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await user.click(form.getByRole('button', { name: /^From Wallet/ }));
    await user.click(await screen.findByRole('radio', { name: /^Bank/ }));
    await typeAmount(user, form, '2');
    await user.click(saveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));

    for (const setting of [WALLET, '9'.repeat(16)]) {
      server.accounts[0].archived = setting === WALLET;
      server.me.settings = { ...server.me.settings, defaultAccountId: setting };
      await reloadApp(server, '/?accounts', { size: 'phone' });
      form = await openAdd(user);
      expect(form.getByRole('button', { name: /^From Bank/ }).textContent).toMatch(/last used/);
      await user.click(
        form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }),
      );
    }
  });

  test('the one used last, archived since, gives way to the first in use', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await user.click(form.getByRole('button', { name: /^From Wallet/ }));
    await user.click(await screen.findByRole('radio', { name: /^Bank/ }));
    await typeAmount(user, form, '2');
    await user.click(saveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    server.accounts[1].archived = true;
    await reloadApp(server, '/?accounts', { size: 'phone' });
    form = await openAdd(user);
    expect(form.getByRole('button', { name: /^From Wallet/ }).textContent).not.toMatch(/last used/);
  });

  test('says no "last used" when the account set to use decided', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await typeAmount(user, form, '2');
    await user.click(saveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    server.me.settings = { ...server.me.settings, defaultAccountId: BANK };
    await reloadApp(server, '/?accounts', { size: 'phone' });
    form = await openAdd(user);
    expect(form.getByRole('button', { name: /^From Bank/ }).textContent).not.toMatch(/last used/);
  });

  test("an archived account's page opens Add on one in use, and on it once unarchived", async () => {
    const server = withAccounts();
    server.accounts[0].archived = true;
    renderApp(server, `/?account=${WALLET}`, { size: 'phone' });
    const user = userEvent.setup();
    expect(await screen.findByText('Cash · archived')).toBeTruthy();
    let form = await openAdd(user);
    expect(form.getByRole('button', { name: /^From Bank/ })).toBeTruthy();
    await user.click(form.getByRole('button', { name: /^From Bank/ }));
    expect(await screen.findByRole('radio', { name: /^Bank/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /^Wallet/ })).toBeNull();
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole('radio', { name: /^Bank/ })).toBeNull());
    await user.click(form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }));
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );

    // Unarchive, on the page (R-Account-Archived)
    await user.click(screen.getByRole('button', { name: 'Unarchive' }));
    await screen.findByRole('button', { name: 'Add here' });
    form = await openAdd(user);
    expect(form.getByRole('button', { name: /^From Wallet/ })).toBeTruthy();
  });

  test('income opens on its own category, whatever spending used last', async () => {
    const server = withAccounts();
    withCoffee(server);
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await user.click(form.getByRole('button', { name: /^For Food/ }));
    await user.click(await screen.findByRole('button', { name: 'Food › Coffee' }));
    await typeAmount(user, form, '6');
    await user.click(saveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    form = await openAdd(user);
    await user.click(form.getByRole('radio', { name: 'Income' }));
    expect(form.getByRole('button', { name: /^From Salary/ })).toBeTruthy();
    expect(checked(form.getByRole('radiogroup', { name: 'Recent categories' }))).toEqual([
      'Salary',
    ]);
  });

  test('a transfer offers the account moved to last, never the one it comes from', async () => {
    const server = withThree();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    let form = await openAdd(user);
    await user.click(form.getByRole('radio', { name: 'Transfer' }));
    // A card's balance reads as what's owed, as the accounts list words it
    await user.click(form.getByRole('button', { name: /^To Bank/ }));
    await user.click(await screen.findByRole('radio', { name: /^Visa/ }));
    expect(form.getByRole('button', { name: /^To Visa RM 120\.00 owed/ })).toBeTruthy();
    await typeAmount(user, form, '50');
    await user.click(saveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));

    form = await openAdd(user);
    await user.click(form.getByRole('radio', { name: 'Transfer' }));
    expect(form.getByRole('button', { name: /^To Visa/ })).toBeTruthy();
    await user.click(form.getByRole('button', { name: /^From Wallet/ }));
    await user.click(await screen.findByRole('radio', { name: /^Visa/ }));
    expect(form.getByRole('button', { name: /^To (Wallet|Bank)/ })).toBeTruthy();
    await user.click(form.getByRole('button', { name: /^To / }));
    await screen.findByRole('radio', { name: /^Wallet/ });
    expect(screen.queryByRole('radio', { name: /^Visa/ })).toBeNull();
  });
});

describe('keys and dialogs', () => {
  test('Enter on a computer’s From row opens its list and saves nothing', async () => {
    renderApp(withAccounts(), '/?accounts');
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '5');
    act(() => form.getByRole('button', { name: /^From Wallet/ }).focus());
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('radio', { name: /^Bank/ })).toBeTruthy();
    await settle();
    expect(changePosts()).toHaveLength(0);
  });

  test('Esc with the category list open closes the list first, not Add', async () => {
    renderApp(withAccounts(), '/?accounts');
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '5');
    await user.click(form.getByRole('button', { name: /^For Food/ }));
    await screen.findByLabelText('Find or create a category');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByLabelText('Find or create a category')).toBeNull());
    expect(amount(within(screen.getByRole('form', { name: 'Add a transaction' })))).toBe(
      'Amount, RM 5.00',
    );
  });

  test.each(['phone', 'tablet'] as const)(
    'on a %s Add is a dialog, so N and / typed on its radios do nothing more',
    async (size) => {
      renderApp(withAccounts(), '/?accounts', { size });
      const user = userEvent.setup();
      const form = await openAdd(user);
      const dialog = screen.getByRole('dialog');
      expect(dialog.contains(form.getByRole('group', { name: 'Keypad' }))).toBe(true);
      act(() => form.getByRole('radio', { name: 'Expense' }).focus());
      await user.keyboard('n/');
      await settle();
      expect(screen.getAllByRole('form', { name: 'Add a transaction' })).toHaveLength(1);
      expect(window.location.search).toBe('?accounts');
    },
  );
});

describe('a new category, within the limits', () => {
  test('a name is at most 40 characters, the longest a category can have', async () => {
    renderApp(withAccounts(), '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.click(form.getByRole('button', { name: /^For Food/ }));
    const search = await screen.findByLabelText('Find or create a category');
    expect(search.getAttribute('maxlength')).toBe('40');
  });

  test('a category with no room for another under it is not offered', async () => {
    const server = withAccounts();
    server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    for (let i = 0; i < 50; i++) {
      server.categories.push({
        id: i.toString(16).padStart(16, '9'),
        name: `Shelf ${i}`,
        kind: 'expense',
        parentId: categoryId('Groceries'),
        position: i,
        archived: true,
      });
    }
    seedTransaction(server, { payee: 'Kedai Mesra', categoryId: categoryId('Groceries') });
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.type(form.getByLabelText<HTMLInputElement>('Payee or note'), 'Kedai Mesra');
    await user.click(form.getByRole('button', { name: /^For Food/ }));
    await user.type(await screen.findByLabelText('Find or create a category'), 'Tea leaves');
    await screen.findByRole('option', { name: 'As its own expense category' });
    expect(screen.queryByRole('option', { name: /^Under Groceries/ })).toBeNull();
    await user.click(screen.getByRole('option', { name: /^Under another category/ }));
    const under = await screen.findByRole('region', { name: 'Put Tea leaves under' });
    expect(unusable(within(under).getByRole('button', { name: /^Groceries/ }))).toBe(true);
    expect(screen.getByText('Groceries has 50 subcategories, the most it can have')).toBeTruthy();
  });

  test('with the most categories there can be, none is offered to make', async () => {
    const server = withAccounts();
    server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    for (let i = server.categories.length; i < 200; i++) {
      server.categories.push({
        id: i.toString(16).padStart(16, '8'),
        name: `Old ${i}`,
        kind: 'expense',
        parentId: null,
        position: i,
        archived: true,
      });
    }
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.click(form.getByRole('button', { name: /^For Food/ }));
    await user.type(await screen.findByLabelText('Find or create a category'), 'Pets');
    expect(
      await screen.findByText('You can have up to 200 categories, archived ones included'),
    ).toBeTruthy();
    expect(screen.queryByRole('option')).toBeNull();
  });

  test('a name an archived category has is not made again: it says so', async () => {
    const server = withAccounts();
    server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c, archived: c.name === 'Fun' }));
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.click(form.getByRole('button', { name: /^For Food/ }));
    await user.type(await screen.findByLabelText('Find or create a category'), 'fun');
    expect(
      await screen.findByText('Fun is archived. Bring it back in Categories to use it.'),
    ).toBeTruthy();
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fun' })).toBeNull();
  });

  test.each(['down', 'offline'] as const)(
    'with the payees out of reach (%s), the options show without a hint and it saves',
    async (how) => {
      const server = withAccounts();
      seedTransaction(server, { payee: 'Kedai Mesra', categoryId: categoryId('Groceries') });
      renderApp(server, '/?accounts', { size: 'phone' });
      const user = userEvent.setup();
      await accountRow('Wallet', 'RM 57.00');
      if (how === 'down') server.pathsDown.add('/api/payee-categories');
      else {
        server.health = 'unreachable';
        const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        onTestFinished(() => onLine.mockRestore());
        act(() => void window.dispatchEvent(new Event('offline')));
      }
      const form = await openAdd(user);
      await user.type(form.getByLabelText<HTMLInputElement>('Payee or note'), 'Kedai Mesra');
      await user.click(form.getByRole('button', { name: /^For Food/ }));
      await user.type(await screen.findByLabelText('Find or create a category'), 'Tea leaves');
      await user.click(await screen.findByRole('option', { name: 'As its own expense category' }));
      expect(screen.queryByText(/was in/)).toBeNull();
      await typeAmount(user, form, '7');
      await user.click(saveButton(form));
      expect(await accountRow('Wallet', 'RM 50.00')).toBeTruthy();
      if (how === 'down') await waitFor(() => expect(server.transactions).toHaveLength(2));
    },
  );
});

describe('the category list', () => {
  test('lists Recent, newest first, then the rest, each once and none archived', async () => {
    const server = withAccounts();
    withCoffee(server);
    server.categories = server.categories.map((c) => ({ ...c, archived: c.name === 'Health' }));
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    for (const pick of ['Fun', 'Food › Coffee']) {
      const form = await openAdd(user);
      await user.click(form.getByRole('button', { name: /^For / }));
      await user.click(await screen.findByRole('button', { name: pick }));
      await typeAmount(user, form, '1');
      await user.click(saveButton(form));
      await waitFor(() =>
        expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
      );
    }
    const form = await openAdd(user);
    await user.click(form.getByRole('button', { name: /^For / }));
    const recent = await screen.findByRole('region', { name: 'Recent' });
    const rest = screen.getByRole('region', { name: 'All categories' });
    const names = (region: HTMLElement) =>
      within(region)
        .getAllByRole('button')
        .map((b) => b.textContent);
    expect(names(recent)).toEqual(['Food › Coffee', 'Fun', 'Food', 'Transport', 'Groceries']);
    expect(names(rest)).toEqual(['Bills', 'Shopping', 'Other']);
  });
});

describe('Repeat, each way', () => {
  test('weekly repeats on the weekday of the day picked, next after today', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '15');
    await user.click(form.getByRole('button', { name: 'Today' }));
    const day = await screen.findByLabelText('Date');
    await user.clear(day);
    // A Monday
    await user.type(day, '2026-08-17');
    await user.click(form.getByRole('button', { name: 'Repeat' }));
    await user.click(await screen.findByRole('radio', { name: 'Weekly' }));
    expect(form.getByRole('button', { name: 'Weekly' })).toBeTruthy();
    await user.click(saveButton(form));
    await waitFor(() => expect(server.recurring).toHaveLength(1));
    expect(server.recurring[0]).toEqual(
      expect.objectContaining({ schedule: 'weekly', day: 1, nextDue: '2026-08-24' }),
    );
  });

  test('from an earlier day, the first due is the next after today, not after that day', async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '15');
    await user.click(form.getByRole('button', { name: 'Today' }));
    const day = await screen.findByLabelText('Date');
    await user.clear(day);
    await user.type(day, '2026-07-10');
    await user.click(form.getByRole('button', { name: 'Repeat' }));
    await user.click(await screen.findByRole('radio', { name: 'Monthly' }));
    await user.click(saveButton(form));
    await waitFor(() => expect(server.recurring).toHaveLength(1));
    expect(server.recurring[0]).toEqual(
      expect.objectContaining({ schedule: 'monthly', day: 10, nextDue: '2026-09-10' }),
    );
  });

  test("Doesn't repeat, chosen after Monthly, sets nothing up", async () => {
    const server = withAccounts();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await typeAmount(user, form, '15');
    await user.click(form.getByRole('button', { name: 'Repeat' }));
    await user.click(await screen.findByRole('radio', { name: 'Monthly' }));
    await user.click(form.getByRole('button', { name: 'Monthly' }));
    await user.click(await screen.findByRole('radio', { name: "Doesn't repeat" }));
    expect(form.getByRole('button', { name: 'Repeat' })).toBeTruthy();
    await user.click(saveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    expect(sentChanges().map((c) => c.op)).toEqual(['addTransaction']);
    expect(server.recurring).toEqual([]);
  });
});

describe('focus once Add closes', () => {
  test.each(SIZES)('stays where it went while Add is still closing (%s)', async (size) => {
    renderApp(withAccounts(), '/?accounts', { size });
    const user = userEvent.setup();
    const form = await openAdd(user);
    const close = form.getByRole('button', { name: 'Close, keeps what you typed as a draft' });
    const elsewhere = screen.getAllByRole('link', { name: 'Activity', hidden: true })[0];
    // Focus moves on the moment Add closes, before it would have handed focus back
    act(() => close.click());
    act(() => elsewhere.focus());
    // Past the closing transition (150 ms on a computer), then past the 10 ms a dialog
    // waits before handing focus back
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );
    await act(() => new Promise((done) => setTimeout(done, 50)));
    expect(document.activeElement).toBe(elsewhere);
  });

  test.each(SIZES)('goes back to Add or New entry when nothing else took it (%s)', async (size) => {
    renderApp(withAccounts(), '/?accounts', { size });
    const user = userEvent.setup();
    const form = await openAdd(user);
    await user.click(form.getByRole('button', { name: 'Close, keeps what you typed as a draft' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', {
          name: size === 'desktop' ? 'New entry' : 'Add',
        }),
      ),
    );
  });
});
