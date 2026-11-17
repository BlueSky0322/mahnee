// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get } from 'idb-keyval';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  addEntry,
  fakeServer,
  goToPlace,
  holdNext,
  openSettings,
  renderApp,
  setupAppTests,
} from '../../testing/app';
import { outboxKey } from '../../offline/outbox';
import { queryClient } from '../../query-client';
import { addMonths, thisMonth } from '../../utils/date-input';

// Budgets (B1, B2): an optional monthly amount on a top-level spending category, its
// subcategories counting toward it, set from the category's row on the Categories page.
// Plan shows each: on a phone "RM 120.00 left" and "RM 180.00 of RM 300.00", or "RM 40.00
// over" in words and colour; on a computer, its row's Left column and its bar's name. The
// same amount every month until changed. With Carry over on, last month's leftover is added
// (or its overspending taken away), "incl. RM 30.00 carried over".

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

type Size = (typeof SIZES)[number];

/** What an element says, each piece of text on its own separated by a space */
function text(el: HTMLElement) {
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
    const words = node.textContent?.replace(/\s+/g, ' ').trim();
    if (words) parts.push(words);
  }
  return parts.join(' ');
}

/**
 * Plan's figures for a category's budget, as a person reads them, or null while it has
 * none. On a phone or tablet its line: what's left (or over), what's spent of what's
 * available, and what carried over ("RM 150.00 left · RM 180.00 of RM 330.00 · incl. RM
 * 30.00 carried over"). On a computer its row: the Left column and the bar's name, which
 * says how much is spent ("120.00 · Food: 60% spent").
 */
function planBudget(size: Size, name: string): string | null {
  if (size === 'desktop') {
    const table = screen.queryByRole('table', { name: 'Expenses by category' });
    const row =
      table == null
        ? undefined
        : within(table)
            .queryAllByRole('row')
            .find((tr) => text(tr).startsWith(`${name} `));
    const meter = row == null ? null : within(row).queryByRole('meter');
    if (row == null || meter == null) return null;
    const cells = within(row).getAllByRole('cell');
    return `${text(cells[cells.length - 1])} · ${meter.getAttribute('aria-label')}`;
  }
  const region = screen.queryByRole('region', { name: /^Budgets/ });
  const line =
    region == null
      ? undefined
      : within(region)
          .queryAllByRole('listitem')
          .find((li) => text(li).startsWith(`${name} `));
  if (line == null) return null;
  const said = text(line);
  return [
    /RM [\d,.]+ (left|over)/.exec(said)?.[0],
    /RM [\d,.]+ of −?RM [\d,.]+/.exec(said)?.[0],
    /incl\. −?RM [\d,.]+ carried over/.exec(said)?.[0],
  ]
    .filter((part) => part != null)
    .join(' · ');
}

/** Waits for Plan to show `want` for a category's budget: the phone's, or the computer's */
const showsBudget = (size: Size, name: string, want: { phone: string; desktop: string }) =>
  waitFor(() =>
    expect(planBudget(size, name)).toBe(size === 'desktop' ? want.desktop : want.phone),
  );

/** What's left of a budget, as drawn: "RM 40.00 over" on a phone, "40.00 over" on a computer */
function leftShown(size: Size, name: string) {
  if (size === 'desktop') {
    const row = within(screen.getByRole('table', { name: 'Expenses by category' }))
      .getAllByRole('row')
      .find((tr) => text(tr).startsWith(`${name} `))!;
    const cells = within(row).getAllByRole('cell');
    return within(cells[cells.length - 1]).getByText(/^[\d,.]+( over)?$/);
  }
  const region = screen.getByRole('region', { name: /^Budgets/ });
  const line = within(region)
    .getAllByRole('listitem')
    .find((li) => text(li).startsWith(`${name} `))!;
  // The figure and its word are drawn as one, the word in a span of its own
  return [...line.querySelectorAll('span')].find((span) =>
    /^RM [\d,.]+ (left|over)$/.test(span.textContent ?? ''),
  )!;
}

/** Plan's spending this month, once shown: "Where it went", or the table's "spent" */
const spentShown = async (size: Size, figure: string) => {
  // A computer with no budgets and nothing spent shows Where it went, as a phone does
  if (size === 'desktop' && figure !== 'RM 0.00') {
    expect(await screen.findByText(`${figure} spent`)).toBeTruthy();
    return;
  }
  const went = await screen.findByRole('region', { name: /^Where it went/ });
  await waitFor(() => expect(text(went)).toMatch(new RegExp(`^Where it went ${figure}`)));
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

describe('budgets on Plan', () => {
  test.each(SIZES)("show what's left of each, in the categories' order (%s)", async (size) => {
    const server = withBudgets(budget(FUN, 10_000), budget(FOOD, 30_000), budget(TRANSPORT, 1_000));
    // RM 150 on Food and RM 30 on Coffee, which counts toward Food
    spend(server, 15_000, FOOD);
    spend(server, 3_000, COFFEE);
    spend(server, 5_000, TRANSPORT);
    renderApp(server, '/?plan', { size });

    await showsBudget(size, 'Food', {
      phone: 'RM 120.00 left · RM 180.00 of RM 300.00',
      desktop: '120.00 · Food: 60% spent',
    });
    await showsBudget(size, 'Transport', {
      phone: 'RM 40.00 over · RM 50.00 of RM 10.00',
      desktop: '40.00 over · Transport: 500% spent',
    });
    // Nothing spent yet: all of it left
    await showsBudget(size, 'Fun', {
      phone: 'RM 100.00 left · RM 0.00 of RM 100.00',
      desktop: '100.00 · Fun: 0% spent',
    });
    if (size !== 'desktop') {
      // In the categories' order
      const region = screen.getByRole('region', { name: /^Budgets/ });
      expect(
        within(region)
          .getAllByRole('listitem')
          .map((li) => text(li).split(' ')[0]),
      ).toEqual(['Food', 'Transport', 'Fun']);
    }
    // Over, in words and in the negative colour
    expect(leftShown(size, 'Transport').className).toMatch(/neg/);
    expect(leftShown(size, 'Food').className).not.toMatch(/neg/);
  });

  test.each(SIZES)('are not shown for a month without any (%s)', async (size) => {
    const server = withBudgets();
    spend(server, 15_000, FOOD);
    renderApp(server, '/?plan', { size });
    await spentShown(size, 'RM 150.00');
    expect(screen.queryAllByRole('meter')).toEqual([]);
    expect(screen.queryByText(/ left$/)).toBeNull();
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
      renderApp(server, '/?plan', { size });

      await showsBudget(size, 'Food', {
        phone: 'RM 150.00 left · RM 180.00 of RM 330.00 · incl. RM 30.00 carried over',
        desktop: '150.00 · Food: 55% spent',
      });
      await showsBudget(size, 'Transport', {
        phone: 'RM 80.00 left · RM 0.00 of RM 80.00 · incl. −RM 20.00 carried over',
        desktop: '80.00 · Transport: 0% spent',
      });
      await showsBudget(size, 'Fun', {
        phone: 'RM 100.00 left · RM 0.00 of RM 100.00',
        desktop: '100.00 · Fun: 0% spent',
      });
      if (size !== 'desktop') expect(screen.getAllByText(/carried over/)).toHaveLength(2);
    },
  );

  test.each(SIZES)(
    'keep the amount an earlier month had when it is changed later (%s)',
    async (size) => {
      const server = withBudgets(
        budget(FOOD, 20_000, { fromMonth: addMonths(NOW, -3) }),
        budget(FOOD, 30_000),
      );
      renderApp(server, '/?plan', { size });
      const user = userEvent.setup();
      await showsBudget(size, 'Food', {
        phone: 'RM 300.00 left · RM 0.00 of RM 300.00',
        desktop: '300.00 · Food: 0% spent',
      });
      await user.click(screen.getByRole('button', { name: 'Previous month' }));
      await waitFor(() => expect(window.location.search).toBe(`?plan&month=${BEFORE}`));
      await showsBudget(size, 'Food', {
        phone: 'RM 200.00 left · RM 0.00 of RM 200.00',
        desktop: '200.00 · Food: 0% spent',
      });
    },
  );

  test.each(SIZES)('spending exactly the budget leaves RM 0.00, not over (%s)', async (size) => {
    const server = withBudgets(budget(FOOD, 18_000));
    spend(server, 15_000, FOOD);
    spend(server, 3_000, COFFEE);
    renderApp(server, '/?plan', { size });
    await showsBudget(size, 'Food', {
      phone: 'RM 0.00 left · RM 180.00 of RM 180.00',
      desktop: '0.00 · Food: 100% spent',
    });
    expect(leftShown(size, 'Food').className).not.toMatch(/neg/);
    expect(screen.queryByText(/\d over$/)).toBeNull();
  });

  test.each(SIZES)(
    'overspent last month and over again this month: over, with what was carried (%s)',
    async (size) => {
      const server = withBudgets(budget(TRANSPORT, 10_000, { fromMonth: BEFORE, carryOver: true }));
      // RM 20 over last month, so RM 80 this month, and RM 90 spent
      spend(server, 12_000, TRANSPORT, `${BEFORE}-10`);
      spend(server, 9_000, TRANSPORT);
      renderApp(server, '/?plan', { size });
      await showsBudget(size, 'Transport', {
        phone: 'RM 10.00 over · RM 90.00 of RM 80.00 · incl. −RM 20.00 carried over',
        desktop: '10.00 over · Transport: 113% spent',
      });
      expect(leftShown(size, 'Transport').className).toMatch(/neg/);
    },
  );
});

/** From Categories up to Settings, out of Settings to Home, then to Plan, which has budgets */
async function categoriesToPlan() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Settings' }));
  await user.click(await screen.findByRole('button', { name: /^(Home|Close settings)$/ }));
  await goToPlace('Plan');
}

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
      await categoriesToPlan();
      await showsBudget(size, 'Food', {
        phone: 'RM 120.00 left · RM 180.00 of RM 300.00',
        desktop: '120.00 · Food: 60% spent',
      });
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
      await categoriesToPlan();
      // RM 300 and last month's RM 30 left over, less RM 180
      await showsBudget(size, 'Food', {
        phone: 'RM 150.00 left · RM 180.00 of RM 330.00 · incl. RM 30.00 carried over',
        desktop: '150.00 · Food: 55% spent',
      });
      await user.click(screen.getByRole('button', { name: 'Previous month' }));
      await showsBudget(size, 'Food', {
        phone: 'RM 30.00 left · RM 170.00 of RM 200.00',
        desktop: '30.00 · Food: 85% spent',
      });
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
      await categoriesToPlan();
      await spentShown(size, 'RM 0.00');
      expect(screen.queryAllByRole('meter')).toEqual([]);
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
    await categoriesToPlan();
    await spentShown(size, 'RM 0.00');
    expect(screen.queryAllByRole('meter')).toEqual([]);
  });

  test.each(SIZES)(
    'shows a budget set offline at once, and saves it once back (%s)',
    async (size) => {
      const server = withBudgets();
      spend(server, 18_000, FOOD);
      renderApp(server, '/?plan', { size });
      const user = userEvent.setup();
      await spentShown(size, 'RM 180.00');
      await openSettings();
      await user.click(screen.getByRole('link', { name: 'Categories' }));

      const back = goOffline(server);
      const form = await editCategory('Food');
      await user.type(form.getByLabelText('Monthly budget'), '300');
      await user.click(form.getByRole('button', { name: 'Save' }));
      await categoriesToPlan();
      const set = {
        phone: 'RM 120.00 left · RM 180.00 of RM 300.00',
        desktop: '120.00 · Food: 60% spent',
      };
      await showsBudget(size, 'Food', set);
      expect(budgetsOf(server)).toEqual([]);

      back();
      await waitFor(() => expect(budgetsOf(server)).toEqual([budget(FOOD, 30_000)]), {
        timeout: 8000,
      });
      expect(planBudget(size, 'Food')).toBe(set[size]);
    },
    15_000,
  );
});

describe("what's left is never counted twice", () => {
  /** Every figure Plan shows for Food's budget from now on, at any moment */
  function watchLeft(size: Size) {
    const seen = new Set<string>();
    const note = () => {
      const found = planBudget(size, 'Food');
      if (found != null) seen.add(found);
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
      renderApp(server, '/?plan', { size });
      const before = {
        phone: 'RM 200.00 left · RM 100.00 of RM 300.00',
        desktop: '200.00 · Food: 33% spent',
      };
      const after = {
        phone: 'RM 192.00 left · RM 108.00 of RM 300.00',
        desktop: '192.00 · Food: 36% spent',
      };
      await showsBudget(size, 'Food', before);
      const left = watchLeft(size);
      let resend = { release: () => {} };
      try {
        // RM 8 on Food, saved, its answer lost
        server.loseNext.changes = true;
        await addEntry('8');
        await waitFor(() => expect(server.transactions).toHaveLength(2));
        expect((await get<{ value: unknown[] }>(outboxKey(RYAN)))?.value ?? []).toHaveLength(1);

        resend = holdNext(server, 'POST', '/api/changes');
        await act(() => queryClient.refetchQueries({ type: 'active' }));
        await act(() => new Promise((r) => setTimeout(r, 50)));
        expect(planBudget(size, 'Food')).toBe(after[size]);

        resend.release();
        await waitFor(
          async () =>
            expect((await get<{ value: unknown[] }>(outboxKey(RYAN)))?.value ?? []).toEqual([]),
          { timeout: 8000 },
        );
        await act(() => new Promise((r) => setTimeout(r, 50)));
        expect(server.transactions).toHaveLength(2);
        expect(left.seen()).toEqual([after[size], before[size]].sort());
      } finally {
        resend.release();
        left.stop();
      }
    },
    15_000,
  );
});
