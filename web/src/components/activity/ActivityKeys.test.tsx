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
