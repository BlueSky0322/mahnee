// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChangesBody, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, renderApp, resizeScreen, setupAppTests } from '../../testing/app';

// Activity on a smaller laptop (1100px wide), where the register and the editor don't fit
// side by side: the register takes the page, and opening a row (a click, or Enter on it)
// opens the entry in a dialog, Save in reach, with focus back on the row once it closes.
// J and K still move through the rows, and changes not saved are still asked about.
// A wider computer keeps the editor beside the register (Activity.test.tsx).

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

const rowButton = (payee: string) => screen.getByRole('button', { name: payee });
const selectedRow = () => screen.getByRole('row', { selected: true }).textContent ?? '';
const sentChanges = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST')
    .flatMap(([, init]) => (JSON.parse(init!.body as string) as ChangesBody).changes);

async function start() {
  renderApp(withThree(), '/?activity', { size: 'laptop' });
  await screen.findByRole('table', { name: 'Transactions' });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

describe('Activity on a smaller laptop', () => {
  test('the register has the page; no editor sits under or beside it', async () => {
    await start();
    expect(within(screen.getByRole('main')).queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull();
    // The first row is the one to open, as on a wider computer
    expect(selectedRow()).toContain('Kiosk');
  });

  test('clicking a row opens it in a dialog, whose payee, amount and day are fields', async () => {
    const user = await start();
    await user.click(rowButton('Bakery'));
    const dialog = within(await screen.findByRole('dialog', { name: 'Bakery' }));
    expect(dialog.getByRole('textbox', { name: 'Payee' })).toHaveProperty('value', 'Bakery');
    expect(dialog.getByRole('textbox', { name: 'Amount' })).toHaveProperty('value', '2');
    expect(dialog.getByLabelText('Date')).toHaveProperty('value', '2026-11-08');
    expect(dialog.getByRole('button', { name: /^Save/ })).toBeTruthy();
    expect(selectedRow()).toContain('Bakery');
  });

  test('Save sends the change, closes the dialog and puts focus back on the row', async () => {
    const user = await start();
    await user.click(rowButton('Bakery'));
    const dialog = within(await screen.findByRole('dialog', { name: 'Bakery' }));
    const payee = dialog.getByRole('textbox', { name: 'Payee' });
    await user.clear(payee);
    await user.type(payee, 'Bread shop');
    await user.click(dialog.getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(sentChanges()).toContainEqual(
        expect.objectContaining({ op: 'updateTransaction', payee: 'Bread shop' }),
      ),
    );
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Bread shop'));
    expect(document.activeElement?.closest('tr')?.getAttribute('aria-selected')).toBe('true');
  });

  test('closing it with changes not saved asks first, and Keep editing keeps them', async () => {
    const user = await start();
    await user.click(rowButton('Kiosk'));
    const dialog = within(await screen.findByRole('dialog', { name: 'Kiosk' }));
    await user.type(dialog.getByRole('textbox', { name: 'Note' }), 'for the office');
    await user.keyboard('{Escape}');
    const ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
    await user.click(ask.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Save your changes?' })).toBeNull(),
    );
    expect(
      within(screen.getByRole('dialog', { name: 'Kiosk' })).getByRole('textbox', {
        name: 'Note',
      }),
    ).toHaveProperty('value', 'for the office');
    expect(sentChanges()).toEqual([]);
  });

  test('J and K move the row, Enter opens it, and Esc brings focus back to it', async () => {
    const user = await start();
    await user.keyboard('j');
    expect(selectedRow()).toContain('Bakery');
    await user.keyboard('j');
    expect(selectedRow()).toContain('Florist');
    await user.keyboard('k');
    expect(selectedRow()).toContain('Bakery');
    // The moved-to row takes the focus, so Enter opens it
    expect(document.activeElement).toBe(rowButton('Bakery'));
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'Bakery' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(rowButton('Bakery')));
    // No key reaches the register while the dialog was open
    expect(sentChanges()).toEqual([]);
  });

  test('an edit moves with the window: into the pane when it widens, and back', async () => {
    const user = await start();
    await user.click(rowButton('Bakery'));
    const dialog = within(await screen.findByRole('dialog', { name: 'Bakery' }));
    const payee = dialog.getByRole('textbox', { name: 'Payee' });
    await user.clear(payee);
    await user.type(payee, 'Bread shop');

    // Wider: the edit is beside the register, and only there
    resizeScreen('desktop');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const pane = within(within(screen.getByRole('main')).getByRole('complementary'));
    expect(pane.getByRole('textbox', { name: 'Payee' })).toHaveProperty('value', 'Bread shop');
    expect(screen.getAllByRole('textbox', { name: 'Payee' })).toHaveLength(1);
    expect(selectedRow()).toContain('Bakery');

    // Narrower again: back in a dialog, still the one editor, still with the edit
    resizeScreen('laptop');
    const again = within(await screen.findByRole('dialog', { name: 'Bakery' }));
    expect(again.getByRole('textbox', { name: 'Payee' })).toHaveProperty('value', 'Bread shop');
    expect(within(screen.getByRole('main')).queryByRole('complementary')).toBeNull();
    expect(screen.getAllByRole('textbox', { name: 'Payee' })).toHaveLength(1);

    // It still counts as not saved, and Save sends it
    await user.keyboard('{Escape}');
    await screen.findByRole('dialog', { name: 'Save your changes?' });
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Bakery' })).getByRole('button', {
        name: /^Save/,
      }),
    );
    await waitFor(() =>
      expect(sentChanges()).toContainEqual(
        expect.objectContaining({ op: 'updateTransaction', payee: 'Bread shop' }),
      ),
    );
  });

  test('an edit beside the register goes into a dialog when the window narrows', async () => {
    renderApp(withThree(), '/?activity', { size: 'desktop' });
    await screen.findByRole('table', { name: 'Transactions' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const pane = within(within(screen.getByRole('main')).getByRole('complementary'));
    await user.type(pane.getByRole('textbox', { name: 'Note' }), 'for the office');

    resizeScreen('laptop');
    const dialog = within(await screen.findByRole('dialog', { name: 'Kiosk' }));
    expect(dialog.getByRole('textbox', { name: 'Note' })).toHaveProperty('value', 'for the office');
    // Discarded there, nothing is left to ask about on leaving Activity
    await user.keyboard('{Escape}');
    const ask = within(await screen.findByRole('dialog', { name: 'Save your changes?' }));
    await user.click(ask.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const places = within(screen.getByRole('navigation', { name: 'Main' }));
    await user.click(places.getByRole('link', { name: 'Home' }));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.queryByRole('dialog', { name: 'Save your changes?' })).toBeNull();
    expect(sentChanges()).toEqual([]);
  });

  test.each(['tablet', 'phone'] as const)(
    'an edit beside the register goes into the sheet when the window shrinks to a %s',
    async (size) => {
      renderApp(withThree(), '/?activity', { size: 'desktop' });
      await screen.findByRole('table', { name: 'Transactions' });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const pane = within(within(screen.getByRole('main')).getByRole('complementary'));
      await user.type(pane.getByRole('textbox', { name: 'Note' }), 'for the office');

      resizeScreen(size);
      const sheet = within(await screen.findByRole('dialog', { name: 'Kiosk' }));
      expect(sheet.getByRole('textbox', { name: 'Note' })).toHaveProperty(
        'value',
        'for the office',
      );
      expect(screen.getAllByRole('textbox', { name: 'Note' })).toHaveLength(1);
      await user.click(sheet.getByRole('button', { name: /^Save/ }));
      await waitFor(() =>
        expect(sentChanges()).toContainEqual(
          expect.objectContaining({ op: 'updateTransaction', note: 'for the office' }),
        ),
      );
    },
  );
});
