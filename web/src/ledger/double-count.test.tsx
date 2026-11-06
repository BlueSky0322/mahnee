// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get } from 'idb-keyval';
import { describe, expect, test } from 'vitest';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../testing/app';
import { fakeServer, holdNext, reloadApp, renderApp, setupAppTests } from '../testing/app';
import { outboxKey } from '../offline/outbox';
import { queryClient } from '../query-client';
import { monthHeading, thisMonth } from '../utils/date-input';

// A change the server saved whose answer never reached the app stays waiting on the
// device, and is sent again (the server counts it once by its id). A fresh copy of the
// balances or the month's totals fetched in that gap already holds it, so the balance
// and the month total must not count it a second time, at any moment.

setupAppTests();

const RYAN = 'ryan@example.com';
const SIZES = ['desktop', 'phone'] as const;
const WALLET = 'a'.repeat(16);
const NOW = thisMonth();
const FOOD = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;
const SALARY = DEFAULT_CATEGORIES.find((c) => c.name === 'Salary')!.id;

/** RM 100 in a Wallet, with RM 10 spent on Food and RM 50 of salary this month */
function withWallet() {
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
  server.transactions.push({
    id: 'd'.repeat(16),
    kind: 'expense',
    accountId: WALLET,
    toAccountId: null,
    amountCents: 1_000,
    categoryId: FOOD,
    payee: null,
    note: null,
    date: `${NOW}-01`,
    createdAt: 1,
  });
  server.transactions.push({
    id: 'e'.repeat(16),
    kind: 'income',
    accountId: WALLET,
    toAccountId: null,
    amountCents: 5_000,
    categoryId: SALARY,
    payee: null,
    note: null,
    date: `${NOW}-01`,
    createdAt: 2,
  });
  return server;
}

/** The Wallet's balance on Home, as shown ("RM 140.00"), or null while it isn't */
function walletBalance() {
  const row = screen.queryByRole('button', { name: /^Wallet,/ });
  return row?.getAttribute('aria-label')?.split(', ').at(-1) ?? null;
}

/** A figure on this month's card, as shown ("RM 10.00"), or null while it isn't */
function monthFigure(label: string) {
  const card = screen.queryByRole('region', { name: monthHeading(NOW) });
  if (card == null) return null;
  return within(card).queryByLabelText(label)?.textContent ?? null;
}

/**
 * Every balance and month total the screen shows from now on, each time anything on it
 * changes, so a double count shown for a moment is caught too
 */
function watchFigures() {
  const seen = { balance: new Set<string>(), spent: new Set<string>(), left: new Set<string>() };
  const note = () => {
    const [balance, spent, left] = [
      walletBalance(),
      monthFigure('Spent'),
      monthFigure('Left this month'),
    ];
    if (balance != null) seen.balance.add(balance);
    if (spent != null) seen.spent.add(spent);
    if (left != null) seen.left.add(left);
  };
  const observer = new MutationObserver(note);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  note();
  return {
    seen: () => {
      note();
      return {
        balance: [...seen.balance].sort(),
        spent: [...seen.spent].sort(),
        left: [...seen.left].sort(),
      };
    },
    stop: () => observer.disconnect(),
  };
}

/** What's still waiting on this device for Ryan, as kept there */
const keptForRyan = async () =>
  (await get<{ email: string; value: unknown[] }>(outboxKey(RYAN)))?.value ?? [];

/** Adds RM 8 on Food from Home's entry sheet */
async function spendEight() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add' }));
  const form = within(await screen.findByRole('dialog'));
  await waitFor(() => expect(document.activeElement).toBe(form.getByLabelText('Amount')));
  await user.keyboard('8');
  await user.click(form.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

/** The RM 8 is saved on the server, but its answer is lost: it still waits on the device */
async function savedWithAnswerLost(server: FakeServer) {
  server.loseNext.changes = true;
  await spendEight();
  await waitFor(() => expect(server.transactions).toHaveLength(3));
  expect(server.loseNext.changes).toBe(false);
  expect(await keptForRyan()).toHaveLength(1);
}

/** Before: RM 100 less RM 10 plus RM 50. After: RM 8 less, counted once. */
const BEFORE = { balance: 'RM 140.00', spent: 'RM 10.00', left: 'RM 40.00' };
const AFTER = { balance: 'RM 132.00', spent: 'RM 18.00', left: 'RM 32.00' };

describe('a change saved whose answer was lost is counted once', () => {
  test.each(SIZES)(
    'with fresh balances and totals fetched before it is sent again (%s)',
    async (size) => {
      const server = withWallet();
      renderApp(server, '/', { size });
      await waitFor(() => expect(walletBalance()).toBe(BEFORE.balance));
      await waitFor(() => expect(monthFigure('Spent')).toBe(BEFORE.spent));
      const figures = watchFigures();
      let resend = { release: () => {} };
      try {
        await savedWithAnswerLost(server);
        expect(walletBalance()).toBe(AFTER.balance);

        // Sending it again (after a few seconds) is held up, so the fetches below land
        // while it still waits
        resend = holdNext(server, 'POST', '/api/changes');
        // The app fetches the balances and this month's totals afresh: both hold the RM 8
        await act(() => queryClient.refetchQueries({ type: 'active' }));
        await act(() => new Promise((r) => setTimeout(r, 50)));
        // The month's totals first, then the balance, so each is shown to fail on its own
        expect(monthFigure('Spent')).toBe(AFTER.spent);
        expect(monthFigure('Left this month')).toBe(AFTER.left);
        expect(walletBalance()).toBe(AFTER.balance);

        // Sent again, counted once by the server, and once on screen
        resend.release();
        await waitFor(async () => expect(await keptForRyan()).toEqual([]), { timeout: 8000 });
        await act(() => new Promise((r) => setTimeout(r, 50)));
        expect(server.transactions).toHaveLength(3);
        expect(walletBalance()).toBe(AFTER.balance);
        expect(monthFigure('Spent')).toBe(AFTER.spent);

        // At no moment was the RM 8 counted twice
        expect(figures.seen()).toEqual({
          balance: [AFTER.balance, BEFORE.balance].sort(),
          spent: [BEFORE.spent, AFTER.spent].sort(),
          left: [BEFORE.left, AFTER.left].sort(),
        });
      } finally {
        // Let go even when a check above failed, so the next test starts from nothing
        resend.release();
        figures.stop();
      }
    },
    15_000,
  );

  test.each(SIZES)(
    'with the page reloaded before it is sent again (%s)',
    async (size) => {
      const server = withWallet();
      renderApp(server, '/', { size });
      await waitFor(() => expect(walletBalance()).toBe(BEFORE.balance));
      await waitFor(() => expect(monthFigure('Spent')).toBe(BEFORE.spent));
      await savedWithAnswerLost(server);

      // Reopened: the RM 8 is picked up from the device and sent again, which is held up,
      // while the balances and totals are fetched afresh, holding it already
      const resend = holdNext(server, 'POST', '/api/changes');
      await reloadApp(server, '/', { size });
      const figures = watchFigures();
      try {
        await waitFor(() => expect(walletBalance()).not.toBeNull());
        await waitFor(() => expect(monthFigure('Spent')).not.toBeNull());
        await act(() => new Promise((r) => setTimeout(r, 50)));
        expect(walletBalance()).toBe(AFTER.balance);
        expect(monthFigure('Spent')).toBe(AFTER.spent);

        resend.release();
        await waitFor(async () => expect(await keptForRyan()).toEqual([]), { timeout: 8000 });
        await act(() => new Promise((r) => setTimeout(r, 50)));
        expect(server.transactions).toHaveLength(3);
        expect(walletBalance()).toBe(AFTER.balance);
        expect(monthFigure('Spent')).toBe(AFTER.spent);

        // Since the reload, only ever the RM 8 counted once
        expect(figures.seen()).toEqual({
          balance: [AFTER.balance],
          spent: [AFTER.spent],
          left: [AFTER.left],
        });
      } finally {
        // Let go even when a check above failed, so the next test starts from nothing
        resend.release();
        figures.stop();
      }
    },
    15_000,
  );
});
