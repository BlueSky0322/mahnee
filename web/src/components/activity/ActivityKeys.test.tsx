// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';

// Activity's keys on a computer (R-Desk-Activity's "J K move, X tick, C category"): J and
// K move the row open beside the register down and up, X ticks it, C changes the category
// of what's ticked (or of the open row, with none ticked). Like the app's other keys, none
// fires while typing in a field or while a dialog is open; a tick box is not a field.

setupAppTests();

const WALLET = 'a'.repeat(16);
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 10, 0, 0));
  return () => vi.useRealTimers();
});

/** A Wallet and three this month, newest first: Kiosk (Nov 9), Bakery (Nov 8), Florist (Nov 7) */
function withThree(): FakeServer {
  const server = fakeServer();
  server.accounts.push({
    id: WALLET,
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 0,
    position: 0,
    archived: false,
  });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  const rows: [string, string][] = [
    ['Florist', '2026-11-07'],
    ['Bakery', '2026-11-08'],
    ['Kiosk', '2026-11-09'],
  ];
  rows.forEach(([payee, date], i) =>
    server.transactions.push({
      id: (i + 1).toString(16).padStart(16, 'd'),
      kind: 'expense',
      accountId: WALLET,
      toAccountId: null,
      amountCents: 100 * (i + 1),
      categoryId: id('Other'),
      payee,
      note: null,
      date,
      createdAt: i + 1,
    } satisfies Transaction),
  );
  return server;
}

/** The name of the entry open beside the register (the sidebar is an aside too, outside main) */
const open = () =>
  within(screen.getByRole('main')).getByRole('complementary').getAttribute('aria-label');
const ticked = () =>
  screen
    .getAllByRole('checkbox')
    .filter((b) => (b as HTMLInputElement).checked)
    .map((b) => b.closest('tr')?.querySelector('td:nth-child(3)')?.textContent);
/** Long enough for a dialog a key opened to be on screen */
const pause = () => act(() => new Promise((r) => setTimeout(r, 300)));

async function start() {
  renderApp(withThree(), '/?activity', { size: 'desktop' });
  await screen.findByRole('table', { name: 'Transactions' });
  await waitFor(() => expect(open()).toBe('Kiosk, Nov 9'));
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

describe('J and K', () => {
  test('move the open row down and up, and stop at either end', async () => {
    const user = await start();
    await user.keyboard('j');
    expect(open()).toBe('Bakery, Nov 8');
    await user.keyboard('j');
    expect(open()).toBe('Florist, Nov 7');
    await user.keyboard('j');
    expect(open()).toBe('Florist, Nov 7');
    await user.keyboard('k');
    expect(open()).toBe('Bakery, Nov 8');
    await user.keyboard('kk');
    expect(open()).toBe('Kiosk, Nov 9');
    // The open row is the one outlined
    expect(screen.getByRole('row', { selected: true }).textContent).toContain('Kiosk');
  });

  test('typed into the search, are only typed', async () => {
    const user = await start();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    await user.click(box);
    await user.keyboard('j');
    expect(box).toHaveProperty('value', 'j');
    expect(open()).toBe('Kiosk, Nov 9');
  });

  test('still move after a tick box was clicked', async () => {
    const user = await start();
    await user.click(screen.getAllByRole('checkbox')[1]);
    await user.keyboard('j');
    expect(open()).toBe('Bakery, Nov 8');
  });
});

describe('X', () => {
  test('ticks the open row, and again unticks it', async () => {
    const user = await start();
    await user.keyboard('jx');
    expect(ticked()).toEqual(['Bakery']);
    expect(screen.getByText('1 selected')).toBeTruthy();
    await user.keyboard('jx');
    expect(ticked()).toEqual(['Bakery', 'Florist']);
    await user.keyboard('x');
    expect(ticked()).toEqual(['Bakery']);
  });
});

describe('C', () => {
  test("changes the category of what's ticked", async () => {
    const user = await start();
    await user.keyboard('xjx');
    await user.keyboard('c');
    expect(
      await screen.findByRole('dialog', { name: 'Change the category of 2 entries' }),
    ).toBeTruthy();
  });

  test('with none ticked, of the open row', async () => {
    const user = await start();
    await user.keyboard('jc');
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Change the category of 1 entry' }),
    );
    expect(dialog.getByText('All Bakery, now in Other')).toBeTruthy();
  });

  test('while a dialog is open, no key reaches the register; Esc closes it', async () => {
    const user = await start();
    await user.keyboard('c');
    await screen.findByRole('dialog');
    // Out of the dialog's search, onto a button, so it is not typing
    act(() => screen.getByRole('button', { name: /^Cancel/ }).focus());
    await user.keyboard('jx');
    await pause();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(open()).toBe('Kiosk, Nov 9');
    expect(ticked()).toEqual([]);
  });
});

describe('the guard', () => {
  test("in the pane's fields, are only what they are there: a list, a day, an amount", async () => {
    const user = await start();
    const pane = within(within(screen.getByRole('main')).getByRole('complementary'));
    // The Category list: a key picks in it, and nothing else happens
    act(() => pane.getByLabelText('Category').focus());
    await user.keyboard('jxc');
    await pause();
    expect(open()).toBe('Kiosk, Nov 9');
    expect(ticked()).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => pane.getByLabelText('Date').focus());
    await user.keyboard('x');
    expect(ticked()).toEqual([]);
    const amount = pane.getByLabelText('Amount');
    await user.clear(amount);
    await user.type(amount, '1j');
    expect(amount).toHaveProperty('value', '1j');
    expect(open()).toBe('Kiosk, Nov 9');
  });

  test('from a focused tick box or choice of which way, still move and tick', async () => {
    const user = await start();
    act(() => screen.getAllByRole('checkbox')[1].focus());
    await user.keyboard('j');
    expect(open()).toBe('Bakery, Nov 8');
    act(() =>
      within(screen.getByRole('radiogroup', { name: 'Which way' }))
        .getByRole('radio', { name: 'Expense' })
        .focus(),
    );
    await user.keyboard('x');
    expect(ticked()).toEqual(['Bakery']);
    await user.keyboard('j');
    expect(open()).toBe('Florist, Nov 7');
  });

  test('with Ctrl, Alt or Cmd held, are left to the browser', async () => {
    const user = await start();
    await user.keyboard('{Control>}j{/Control}{Alt>}x{/Alt}{Meta>}c{/Meta}{Control>}c{/Control}');
    await pause();
    expect(open()).toBe('Kiosk, Nov 9');
    expect(ticked()).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('switching rows with changes not saved', () => {
  /** The pane's Payee, typed over with `payee` */
  async function retype(user: ReturnType<typeof userEvent.setup>, payee: string) {
    const pane = within(within(screen.getByRole('main')).getByRole('complementary'));
    const field = pane.getByLabelText<HTMLInputElement>('Payee');
    await user.clear(field);
    await user.type(field, payee);
    return field;
  }
  const rowButton = (name: string) => screen.getByRole('button', { name });

  test('a clean editor switches at once, by mouse and by key', async () => {
    const user = await start();
    await user.click(rowButton('Bakery'));
    expect(open()).toBe('Bakery, Nov 8');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('j');
    expect(open()).toBe('Florist, Nov 7');
  });

  test('a click on another row asks first; Keep editing keeps what was typed', async () => {
    const user = await start();
    await retype(user, 'Kiosk lunch');
    await user.click(rowButton('Bakery'));
    const ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
    expect(ask.getByText('Kiosk has changes that are not saved.')).toBeTruthy();
    await user.click(ask.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(open()).toBe('Kiosk, Nov 9');
    const pane = within(within(screen.getByRole('main')).getByRole('complementary'));
    expect(pane.getByLabelText('Payee')).toHaveProperty('value', 'Kiosk lunch');
  });

  test('Discard drops what was typed and opens the other row', async () => {
    const user = await start();
    await retype(user, 'Kiosk lunch');
    await user.click(rowButton('Bakery'));
    const ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
    await user.click(ask.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(open()).toBe('Bakery, Nov 8'));
    await user.click(rowButton('Kiosk'));
    await waitFor(() => expect(open()).toBe('Kiosk, Nov 9'));
    const pane = within(within(screen.getByRole('main')).getByRole('complementary'));
    expect(pane.getByLabelText('Payee')).toHaveProperty('value', 'Kiosk');
  });

  test('Save keeps it, then opens the other row', async () => {
    const user = await start();
    await retype(user, 'Kiosk lunch');
    await user.click(rowButton('Bakery'));
    const ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
    await user.click(ask.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(open()).toBe('Bakery, Nov 8'));
    expect(await screen.findByRole('button', { name: 'Kiosk lunch' })).toBeTruthy();
  });

  test('J asks too, once the keyboard has left the field', async () => {
    const user = await start();
    await retype(user, 'Kiosk lunch');
    act(() => screen.getAllByRole('checkbox')[1].focus());
    await user.keyboard('j');
    const ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
    expect(open()).toBe('Kiosk, Nov 9');
    await user.click(ask.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(open()).toBe('Bakery, Nov 8'));
  });

  test('Save with something it can not save keeps the row open with why', async () => {
    const user = await start();
    const pane = within(within(screen.getByRole('main')).getByRole('complementary'));
    const amount = pane.getByLabelText('Amount');
    await user.clear(amount);
    await user.type(amount, 'abc');
    await user.click(rowButton('Bakery'));
    const ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
    await user.click(ask.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(open()).toBe('Kiosk, Nov 9');
    expect(amount).toHaveProperty('value', 'abc');
  });
});

describe('changes not saved, wherever the entry would go', () => {
  const pane = () => within(within(screen.getByRole('main')).getByRole('complementary'));
  async function retype(user: ReturnType<typeof userEvent.setup>, payee: string) {
    const field = pane().getByLabelText<HTMLInputElement>('Payee');
    await user.clear(field);
    await user.type(field, payee);
  }

  test('an entry never touched is no change, even with an amount it would not take', async () => {
    const server = withThree();
    server.transactions[2].amountCents = 0;
    renderApp(server, '/?activity', { size: 'desktop' });
    await screen.findByRole('table', { name: 'Transactions' });
    await waitFor(() => expect(open()).toBe('Kiosk, Nov 9'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: 'Bakery' }));
    expect(open()).toBe('Bakery, Nov 8');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a search that would take the open entry away asks first; Keep editing keeps it', async () => {
    const user = await start();
    await retype(user, 'Kiosk lunch');
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'Bakery');
    const ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
    expect(pane().getByLabelText('Payee')).toHaveProperty('value', 'Kiosk lunch');
    await user.click(ask.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(open()).toBe('Kiosk, Nov 9');
    expect(pane().getByLabelText('Payee')).toHaveProperty('value', 'Kiosk lunch');
  });

  test('a search that would take it away, then Discard, opens what was found', async () => {
    const user = await start();
    await retype(user, 'Kiosk lunch');
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'Bakery');
    const ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
    await user.click(ask.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(open()).toBe('Bakery, Nov 8'));
  });

  test('leaving Activity asks first; Keep editing stays, Save goes', async () => {
    const user = await start();
    await retype(user, 'Kiosk lunch');
    await user.click(screen.getByRole('link', { name: 'Plan' }));
    let ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
    expect(window.location.search).toBe('?activity');
    await user.click(ask.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(pane().getByLabelText('Payee')).toHaveProperty('value', 'Kiosk lunch');

    await user.click(screen.getByRole('link', { name: 'Plan' }));
    ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
    await user.click(ask.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeTruthy();
    expect(window.location.search).toBe('?plan');
  });

  test('N opens New entry over Activity, and what was typed is still there after', async () => {
    const user = await start();
    await retype(user, 'Kiosk lunch');
    act(() => screen.getAllByRole('checkbox')[1].focus());
    await user.keyboard('n');
    expect(await screen.findByRole('dialog', { name: 'New entry' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(pane().getByLabelText('Payee')).toHaveProperty('value', 'Kiosk lunch');
  });

  test.each(['phone', 'tablet'] as const)(
    'closing the sheet with changes asks first: Cancel or Close, Esc and Back (%s)',
    async (size) => {
      renderApp(withThree(), '/?activity', { size });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(await screen.findByRole('button', { name: /^Kiosk, / }));
      let sheet = within(await screen.findByRole('dialog', { name: 'Kiosk' }));
      const field = sheet.getByLabelText<HTMLInputElement>('Payee');
      await user.clear(field);
      await user.type(field, 'Kiosk lunch');

      // Cancel (a tablet's Close) asks; Keep editing keeps the sheet as typed
      await user.click(sheet.getByRole('button', { name: size === 'phone' ? 'Cancel' : 'Close' }));
      let ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
      await user.click(ask.getByRole('button', { name: 'Keep editing' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Save your changes?' })).toBeNull(),
      );
      sheet = within(screen.getByRole('dialog', { name: 'Kiosk' }));
      expect(sheet.getByLabelText('Payee')).toHaveProperty('value', 'Kiosk lunch');

      // Back asks too on a phone (a tablet's Back doesn't close dialogs), and keeps the sheet
      if (size === 'phone') {
        act(() => window.history.back());
        ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
        await user.click(ask.getByRole('button', { name: 'Keep editing' }));
        await waitFor(() =>
          expect(screen.queryByRole('dialog', { name: 'Save your changes?' })).toBeNull(),
        );
        expect(screen.getByRole('dialog', { name: 'Kiosk' })).toBeTruthy();
      }

      // Esc asks; Discard closes it, nothing saved
      await user.keyboard('{Escape}');
      ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
      await user.click(ask.getByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(await screen.findByRole('button', { name: /^Kiosk, / })).toBeTruthy();
    },
  );

  test('a sheet with nothing changed closes at once', async () => {
    renderApp(withThree(), '/?activity', { size: 'phone' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByRole('button', { name: /^Kiosk, / }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Kiosk' }));
    await user.click(sheet.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
