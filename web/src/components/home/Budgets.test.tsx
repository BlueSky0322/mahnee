// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get } from 'idb-keyval';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, holdNext, renderApp, setupAppTests } from '../../testing/app';
import { outboxKey } from '../../offline/outbox';
import { queryClient } from '../../query-client';
import { addMonths, monthHeading, thisMonth } from '../../utils/date-input';

// Budgets (B1, B2): an optional monthly amount on a top-level spending category, its
// subcategories counting toward it, set from the category's row on the Categories page.
// The month card shows each as "RM 120.00 left of RM 300.00", or "RM 40.00 over" in words
// and colour; the same amount every month until changed. With Carry over on, last month's
// leftover is added (or its overspending taken away), "incl. RM 30.00 carried over".

setupAppTests();

const RYAN = 'ryan@example.com';
const SIZES = ['desktop', 'phone'] as const;
const WALLET = 'a'.repeat(16);
const COFFEE = 'e'.repeat(16);
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [FOOD, TRANSPORT, FUN] = [id('Food'), id('Transport'), id('Fun')];
const NOW = thisMonth();
const BEFORE = addMonths(NOW, -1);

/** A budget as the server keeps it: an amount from a month on, none when null */
interface BudgetRow {
  categoryId: string;
  fromMonth: string;
  amountCents: number | null;
  carryOver: boolean;
}

/** A Wallet with RM 1,000 in it, the defaults and Coffee under Food, and `budgets` */
function withBudgets(...budgets: BudgetRow[]) {
  const server = fakeServer();
  server.accounts.push({
    id: WALLET,
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 100_000,
    position: 0,
    archived: false,
  });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  server.categories.push({
    id: COFFEE,
    name: 'Coffee',
    kind: 'expense',
    parentId: FOOD,
    position: 0,
    archived: false,
  });
  (server as FakeServer & { budgets: BudgetRow[] }).budgets = budgets;
  return server;
}

const budgetsOf = (server: FakeServer) => (server as FakeServer & { budgets: BudgetRow[] }).budgets;

const budget = (categoryId: string, amountCents: number | null, more: Partial<BudgetRow> = {}) => ({
  categoryId,
  fromMonth: NOW,
  amountCents,
  carryOver: false,
  ...more,
});

let seeded = 0;
/** Spending the server has before the app opens, on the 2nd of this month */
function spend(server: FakeServer, amountCents: number, categoryId: string, date = `${NOW}-02`) {
  seeded++;
  const t: Transaction = {
    id: seeded.toString(16).padStart(16, 'd'),
    kind: 'expense',
    accountId: WALLET,
    toAccountId: null,
    amountCents,
    categoryId,
    payee: null,
    note: null,
    date,
    createdAt: seeded,
  };
  server.transactions.push(t);
}

/** The month card showing `month` */
const monthCard = async (month: string) =>
  within(await screen.findByRole('region', { name: monthHeading(month) }));

/** Each budget row on the card, as its text reads */
const budgetRows = async (month = NOW) => {
  const card = await monthCard(month);
  return within(await card.findByRole('list', { name: 'Budgets' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');
};

/** Offline, as the browser says; answers how to be back */
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

/** Opens a category's edit sheet from its row on the Categories page */
async function editCategory(name: string) {
  const user = userEvent.setup();
  const spending = within(await screen.findByRole('region', { name: 'Spending' }));
  await user.click(await spending.findByRole('button', { name }));
  return within(await screen.findByRole('dialog'));
}

describe('budgets on the month card', () => {
  test.each(SIZES)("show what's left of each, in the categories' order (%s)", async (size) => {
    const server = withBudgets(budget(FUN, 10_000), budget(FOOD, 30_000), budget(TRANSPORT, 1_000));
    // RM 150 on Food and RM 30 on Coffee, which counts toward Food
    spend(server, 15_000, FOOD);
    spend(server, 3_000, COFFEE);
    spend(server, 5_000, TRANSPORT);
    renderApp(server, '/', { size });

    const card = await monthCard(NOW);
    expect(await card.findByText('RM 120.00 left of RM 300.00')).toBeTruthy();
    const rows = await budgetRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^Food.*RM 120\.00 left of RM 300\.00/);
    expect(rows[1]).toMatch(/^Transport.*RM 40\.00 over/);
    // Nothing spent yet: all of it left
    expect(rows[2]).toMatch(/^Fun.*RM 100\.00 left of RM 100\.00/);
    // Over, in words and in the negative colour
    expect(card.getByText('RM 40.00 over').className).toMatch(/negative/);
    expect(card.getByText('RM 120.00 left of RM 300.00').className).not.toMatch(/negative/);
  });

  test.each(SIZES)('are not shown for a month without any (%s)', async (size) => {
    const server = withBudgets();
    spend(server, 15_000, FOOD);
    renderApp(server, '/', { size });
    const card = await monthCard(NOW);
    await waitFor(() => expect(card.getByLabelText('Spent').textContent).toBe('RM 150.00'));
    expect(card.queryByRole('list', { name: 'Budgets' })).toBeNull();
    expect(card.queryByText(/ left of /)).toBeNull();
  });

  test.each(SIZES)(
    "with Carry over, add last month's leftover, or take away its overspending (%s)",
    async (size) => {
      const server = withBudgets(
        budget(FOOD, 30_000, { fromMonth: BEFORE, carryOver: true }),
        budget(TRANSPORT, 10_000, { fromMonth: BEFORE, carryOver: true }),
        // Off, as it starts: last month's leftover stays there
        budget(FUN, 10_000, { fromMonth: BEFORE }),
      );
      // Last month: RM 30 of Food's left, Transport RM 20 over, RM 40 of Fun's left
      spend(server, 27_000, FOOD, `${BEFORE}-10`);
      spend(server, 12_000, TRANSPORT, `${BEFORE}-10`);
      spend(server, 6_000, FUN, `${BEFORE}-10`);
      // This month
      spend(server, 18_000, FOOD);
      renderApp(server, '/', { size });

      const card = await monthCard(NOW);
      expect(await card.findByText('RM 150.00 left of RM 330.00')).toBeTruthy();
      expect(card.getByText('incl. RM 30.00 carried over')).toBeTruthy();
      expect(card.getByText('RM 80.00 left of RM 80.00')).toBeTruthy();
      expect(card.getByText('incl. −RM 20.00 carried over')).toBeTruthy();
      expect(card.getByText('RM 100.00 left of RM 100.00')).toBeTruthy();
      expect(card.getAllByText(/carried over/)).toHaveLength(2);
    },
  );

  test.each(SIZES)(
    'keep the amount an earlier month had when it is changed later (%s)',
    async (size) => {
      const server = withBudgets(
        budget(FOOD, 20_000, { fromMonth: addMonths(NOW, -3) }),
        budget(FOOD, 30_000),
      );
      renderApp(server, '/', { size });
      const user = userEvent.setup();
      expect(await (await monthCard(NOW)).findByText('RM 300.00 left of RM 300.00')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Previous month' }));
      expect(
        await (await monthCard(BEFORE)).findByText('RM 200.00 left of RM 200.00'),
      ).toBeTruthy();
    },
  );

  test.each(SIZES)('spending exactly the budget leaves RM 0.00, not over (%s)', async (size) => {
    const server = withBudgets(budget(FOOD, 18_000));
    spend(server, 15_000, FOOD);
    spend(server, 3_000, COFFEE);
    renderApp(server, '/', { size });
    const card = await monthCard(NOW);
    const left = await card.findByText('RM 0.00 left of RM 180.00');
    expect(left.className).not.toMatch(/negative/);
    expect(card.queryByText(/ over$/)).toBeNull();
  });

  test.each(SIZES)(
    'overspent last month and over again this month: over, with what was carried (%s)',
    async (size) => {
      const server = withBudgets(budget(TRANSPORT, 10_000, { fromMonth: BEFORE, carryOver: true }));
      // RM 20 over last month, so RM 80 this month, and RM 90 spent
      spend(server, 12_000, TRANSPORT, `${BEFORE}-10`);
      spend(server, 9_000, TRANSPORT);
      renderApp(server, '/', { size });
      const card = await monthCard(NOW);
      const over = await card.findByText('RM 10.00 over');
      expect(over.className).toMatch(/negative/);
      expect(card.getByText('incl. −RM 20.00 carried over')).toBeTruthy();
    },
  );
});

describe("setting a budget from the category's row", () => {
  test.each(SIZES)(
    'sets a monthly budget on a top-level spending category, from this month (%s)',
    async (size) => {
      const server = withBudgets();
      spend(server, 18_000, FOOD);
      renderApp(server, '/?categories', { size });
      const user = userEvent.setup();

      const form = await editCategory('Food');
      const carry = form.getByRole('switch', { name: 'Carry over' });
      // Off by default
      expect((carry as HTMLInputElement).checked).toBe(false);
      await user.type(form.getByLabelText('Monthly budget'), '300');
      await user.click(form.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      // The row says so
      const spending = within(await screen.findByRole('region', { name: 'Spending' }));
      expect(spending.getByText('RM 300.00 a month')).toBeTruthy();
      await waitFor(() =>
        expect(budgetsOf(server)).toEqual([budget(FOOD, 30_000, { fromMonth: NOW })]),
      );
      await user.click(screen.getByRole('button', { name: 'Home' }));
      expect(await (await monthCard(NOW)).findByText('RM 120.00 left of RM 300.00')).toBeTruthy();
    },
  );

  test.each(SIZES)(
    'offers no budget for a subcategory or an income category (%s)',
    async (size) => {
      const server = withBudgets();
      renderApp(server, '/?categories', { size });
      const user = userEvent.setup();
      const coffee = await editCategory('Coffee, in Food');
      // Coffee's own sheet, drawn in full
      expect(coffee.getByLabelText<HTMLInputElement>('Name').value).toBe('Coffee');
      expect(coffee.getByRole('button', { name: 'Save' })).toBeTruthy();
      expect(coffee.queryByLabelText('Monthly budget')).toBeNull();
      expect(coffee.queryByRole('switch', { name: 'Carry over' })).toBeNull();
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      const income = within(await screen.findByRole('region', { name: 'Income' }));
      await user.click(income.getByRole('button', { name: 'Salary' }));
      const salary = within(await screen.findByRole('dialog'));
      expect(salary.getByLabelText<HTMLInputElement>('Name').value).toBe('Salary');
      expect(salary.getByRole('button', { name: 'Save' })).toBeTruthy();
      expect(salary.queryByLabelText('Monthly budget')).toBeNull();
      expect(salary.queryByRole('switch', { name: 'Carry over' })).toBeNull();
    },
  );

  test.each(SIZES)(
    'changes the amount from this month on, and turns Carry over on (%s)',
    async (size) => {
      const server = withBudgets(budget(FOOD, 20_000, { fromMonth: addMonths(NOW, -3) }));
      spend(server, 17_000, FOOD, `${BEFORE}-10`);
      spend(server, 18_000, FOOD);
      renderApp(server, '/?categories', { size });
      const user = userEvent.setup();

      const form = await editCategory('Food');
      const amount = form.getByLabelText('Monthly budget');
      await waitFor(() => expect((amount as HTMLInputElement).value).toBe('200.00'));
      await user.clear(amount);
      await user.type(amount, '300');
      await user.click(form.getByRole('switch', { name: 'Carry over' }));
      await user.click(form.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(budgetsOf(server)).toEqual([
          budget(FOOD, 20_000, { fromMonth: addMonths(NOW, -3) }),
          budget(FOOD, 30_000, { carryOver: true }),
        ]),
      );
      await user.click(screen.getByRole('button', { name: 'Home' }));
      // RM 300 and last month's RM 30 left over, less RM 180
      const card = await monthCard(NOW);
      expect(await card.findByText('RM 150.00 left of RM 330.00')).toBeTruthy();
      expect(card.getByText('incl. RM 30.00 carried over')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Previous month' }));
      expect(await (await monthCard(BEFORE)).findByText('RM 30.00 left of RM 200.00')).toBeTruthy();
    },
  );

  test.each(SIZES)(
    'says what is wrong with an amount it cannot take, and sends nothing (%s)',
    async (size) => {
      const server = withBudgets();
      renderApp(server, '/?categories', { size });
      const user = userEvent.setup();
      const form = await editCategory('Food');
      const amount = form.getByLabelText('Monthly budget');
      for (const [typed, why] of [
        ['0', 'Enter an amount above 0'],
        ['10000000.01', 'Up to 10,000,000'],
        ['abc', 'Enter an amount, like 300'],
      ]) {
        await user.clear(amount);
        await user.type(amount, typed);
        await user.click(form.getByRole('button', { name: 'Save' }));
        expect(await form.findByText(why)).toBeTruthy();
        // Still open, nothing made
        expect(screen.getByRole('dialog')).toBeTruthy();
      }
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(budgetsOf(server)).toEqual([]);
      expect(server.receipts.size).toBe(0);
    },
  );

  test.each(SIZES)(
    "puts a budget the server refuses back, with the server's explanation (%s)",
    async (size) => {
      const server = withBudgets();
      server.failNext.changes = { status: 409, error: 'Fun is archived' };
      const held = holdNext(server, 'POST', '/api/changes');
      renderApp(server, '/?categories', { size });
      const user = userEvent.setup();
      const form = await editCategory('Fun');
      await user.type(form.getByLabelText('Monthly budget'), '100');
      await user.click(form.getByRole('button', { name: 'Save' }));
      // Shown straight away, before the server answers
      const spending = within(await screen.findByRole('region', { name: 'Spending' }));
      expect(await spending.findByText('RM 100.00 a month')).toBeTruthy();

      held.release();
      expect(await screen.findByText('Fun is archived')).toBeTruthy();
      await waitFor(() => expect(spending.queryByText('RM 100.00 a month')).toBeNull());
      expect(budgetsOf(server)).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Home' }));
      const card = await monthCard(NOW);
      await waitFor(() => expect(card.getByLabelText('Spent')).toBeTruthy());
      expect(card.queryByRole('list', { name: 'Budgets' })).toBeNull();
    },
  );

  test.each(SIZES)(
    'saving the sheet with the budget left alone sends nothing about budgets (%s)',
    async (size) => {
      const earlier = budget(FOOD, 30_000, { fromMonth: addMonths(NOW, -3) });
      const server = withBudgets(earlier);
      renderApp(server, '/?categories', { size });
      const user = userEvent.setup();

      const food = await editCategory('Food');
      await waitFor(() =>
        expect(food.getByLabelText<HTMLInputElement>('Monthly budget').value).toBe('300.00'),
      );
      await user.type(food.getByLabelText('Name'), 's');
      await user.click(food.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(server.categories.find((c) => c.id === FOOD)?.name).toBe('Foods'));

      const fun = await editCategory('Fun');
      await user.type(fun.getByLabelText('Name'), 's');
      await user.click(fun.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(server.categories.find((c) => c.id === FUN)?.name).toBe('Funs'));
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(budgetsOf(server)).toEqual([earlier]);
    },
  );

  test.each(SIZES)(
    'turning Carry over on alone keeps the amount, from this month (%s)',
    async (size) => {
      const earlier = budget(FOOD, 30_000, { fromMonth: addMonths(NOW, -3) });
      const server = withBudgets(earlier);
      renderApp(server, '/?categories', { size });
      const user = userEvent.setup();
      const form = await editCategory('Food');
      await waitFor(() =>
        expect(form.getByLabelText<HTMLInputElement>('Monthly budget').value).toBe('300.00'),
      );
      await user.click(form.getByRole('switch', { name: 'Carry over' }));
      await user.click(form.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(budgetsOf(server)).toEqual([earlier, budget(FOOD, 30_000, { carryOver: true })]),
      );
      expect(server.receipts.size).toBe(1);
    },
  );

  test.each(SIZES)('takes a budget away when the amount is emptied (%s)', async (size) => {
    const server = withBudgets(budget(FOOD, 30_000));
    renderApp(server, '/?categories', { size });
    const user = userEvent.setup();
    const form = await editCategory('Food');
    const amount = form.getByLabelText('Monthly budget');
    await waitFor(() => expect((amount as HTMLInputElement).value).toBe('300.00'));
    await user.clear(amount);
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(budgetsOf(server)).toEqual([budget(FOOD, null, { fromMonth: NOW })]),
    );
    await user.click(screen.getByRole('button', { name: 'Home' }));
    const card = await monthCard(NOW);
    await waitFor(() => expect(card.getByLabelText('Spent')).toBeTruthy());
    expect(card.queryByRole('list', { name: 'Budgets' })).toBeNull();
  });

  test.each(SIZES)(
    'shows a budget set offline at once, and saves it once back (%s)',
    async (size) => {
      const server = withBudgets();
      spend(server, 18_000, FOOD);
      renderApp(server, '/', { size });
      const user = userEvent.setup();
      const card = await monthCard(NOW);
      await waitFor(() => expect(card.getByLabelText('Spent').textContent).toBe('RM 180.00'));
      await user.click(await screen.findByRole('link', { name: 'Categories' }));

      const back = goOffline(server);
      const form = await editCategory('Food');
      await user.type(form.getByLabelText('Monthly budget'), '300');
      await user.click(form.getByRole('button', { name: 'Save' }));
      await user.click(screen.getByRole('button', { name: 'Home' }));
      expect(await (await monthCard(NOW)).findByText('RM 120.00 left of RM 300.00')).toBeTruthy();
      expect(budgetsOf(server)).toEqual([]);

      back();
      await waitFor(() => expect(budgetsOf(server)).toEqual([budget(FOOD, 30_000)]), {
        timeout: 8000,
      });
      expect((await monthCard(NOW)).getByText('RM 120.00 left of RM 300.00')).toBeTruthy();
    },
    15_000,
  );
});

describe("what's left is never counted twice", () => {
  /** Every "left of" or "over" figure the card shows from now on, at any moment */
  function watchLeft() {
    const seen = new Set<string>();
    const note = () => {
      for (const el of document.querySelectorAll('li')) {
        const found = /RM [\d,.]+ (left of RM [\d,.]+|over)/.exec(el.textContent ?? '');
        if (found != null) seen.add(found[0]);
      }
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
        return [...seen].sort();
      },
      stop: () => observer.disconnect(),
    };
  }

  test.each(SIZES)(
    'when spending saved with its answer lost is fetched before it is sent again (%s)',
    async (size) => {
      const server = withBudgets(budget(FOOD, 30_000));
      spend(server, 10_000, FOOD);
      renderApp(server, '/', { size });
      const user = userEvent.setup();
      expect(await (await monthCard(NOW)).findByText('RM 200.00 left of RM 300.00')).toBeTruthy();
      const left = watchLeft();
      let resend = { release: () => {} };
      try {
        // RM 8 on Food, saved, its answer lost
        server.loseNext.changes = true;
        await user.click(await screen.findByRole('button', { name: 'Add' }));
        const form = within(await screen.findByRole('dialog'));
        await waitFor(() => expect(document.activeElement).toBe(form.getByLabelText('Amount')));
        await user.keyboard('8');
        await user.click(form.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(server.transactions).toHaveLength(2));
        expect((await get<{ value: unknown[] }>(outboxKey(RYAN)))?.value ?? []).toHaveLength(1);

        resend = holdNext(server, 'POST', '/api/changes');
        await act(() => queryClient.refetchQueries({ type: 'active' }));
        await act(() => new Promise((r) => setTimeout(r, 50)));
        expect((await monthCard(NOW)).getByText('RM 192.00 left of RM 300.00')).toBeTruthy();

        resend.release();
        await waitFor(
          async () =>
            expect((await get<{ value: unknown[] }>(outboxKey(RYAN)))?.value ?? []).toEqual([]),
          { timeout: 8000 },
        );
        await act(() => new Promise((r) => setTimeout(r, 50)));
        expect(server.transactions).toHaveLength(2);
        expect(left.seen()).toEqual(['RM 192.00 left of RM 300.00', 'RM 200.00 left of RM 300.00']);
      } finally {
        resend.release();
        left.stop();
      }
    },
    15_000,
  );
});
