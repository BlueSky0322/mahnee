// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, reloadApp, renderApp, setupAppTests } from '../../testing/app';

// Budgets and reminders (R-Set-Budgets, R-Desk-Set-Budgets; digest 3.15; owner decision
// D14): "Carry over, for new budgets" is a switch, saved at once, and decides whether a
// budget set where there was none carries over to start with. The reminder rows stay as
// they are (read-only) until reminders are built. Names and figures are made up.

setupAppTests();

// 10 November 2026: budgets set now are from November
const MONTH = '2026-11';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 10, 0, 0));
});
afterEach(() => vi.useRealTimers());

const SIZES = ['phone', 'desktop'] as const;
const FOOD = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;

function withWallet(): FakeServer {
  const server = fakeServer();
  server.accounts.push({
    id: 'a'.repeat(16),
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 100_000,
    position: 0,
    archived: false,
  });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  return server;
}

/** The switch, by the name each board gives it */
const carrySwitch = (page: ReturnType<typeof within>, size: (typeof SIZES)[number]) =>
  page.getByRole('switch', {
    name: size === 'desktop' ? 'Carry over for new budgets' : 'Carry over, for new budgets',
  });

async function openBudgets(server: FakeServer, size: (typeof SIZES)[number]) {
  renderApp(server, '/?settings=budgets', { size });
  await screen.findByRole('heading', { name: 'Budgets and reminders', level: 1 });
  return within(await screen.findByRole('region', { name: 'Budgets and reminders' }));
}

/** Sets RM 300 on Food from its sheet on the Categories page; answers the switch as it was */
async function setFoodBudget() {
  const user = userEvent.setup();
  const spending = within(await screen.findByRole('region', { name: 'Expenses' }));
  await user.click(await spending.findByRole('button', { name: 'Food' }));
  const form = within(await screen.findByRole('dialog'));
  const carry = form.getByRole<HTMLInputElement>('switch', { name: 'Carry over' });
  const was = carry.checked;
  await user.type(form.getByLabelText('Monthly budget'), '300');
  await user.click(form.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  return was;
}

describe.each(SIZES)('Budgets and reminders (%s)', (size) => {
  test('Carry over, for new budgets is a switch, on as drawn', async () => {
    const page = await openBudgets(withWallet(), size);
    expect(carrySwitch(page, size)).toHaveProperty('checked', true);
    expect(page.getByText('Each budget can override')).toBeTruthy();
    // The reminder rows say what's set, until reminders come
    expect(page.getByText('Daily reminder to log')).toBeTruthy();
    expect(page.getByText('Before one is added')).toBeTruthy();
  });

  test('off: saved, and a new budget starts without carry over', async () => {
    const server = withWallet();
    const page = await openBudgets(server, size);
    await userEvent.setup().click(carrySwitch(page, size));
    await waitFor(() => expect(server.me.settings.carryOverDefault).toBe(false));
    expect(carrySwitch(page, size)).toHaveProperty('checked', false);

    await reloadApp(server, '/?settings=categories', { size });
    expect(await setFoodBudget()).toBe(false);
    await waitFor(() =>
      expect(server.budgets).toEqual([
        { categoryId: FOOD, fromMonth: MONTH, amountCents: 30_000, carryOver: false },
      ]),
    );
  });

  test('on: a new budget starts with carry over', async () => {
    const server = withWallet();
    renderApp(server, '/?settings=categories', { size });
    expect(await setFoodBudget()).toBe(true);
    await waitFor(() =>
      expect(server.budgets).toEqual([
        { categoryId: FOOD, fromMonth: MONTH, amountCents: 30_000, carryOver: true },
      ]),
    );
  });

  test('a budget already set keeps its own carry over, whatever the setting', async () => {
    const server = withWallet();
    server.me.settings.carryOverDefault = true;
    server.budgets.push({
      categoryId: FOOD,
      fromMonth: MONTH,
      amountCents: 20_000,
      carryOver: false,
    });
    renderApp(server, '/?settings=categories', { size });
    const user = userEvent.setup();
    const spending = within(await screen.findByRole('region', { name: 'Expenses' }));
    await user.click(await spending.findByRole('button', { name: 'Food' }));
    const form = within(await screen.findByRole('dialog'));
    expect(form.getByRole('switch', { name: 'Carry over' })).toHaveProperty('checked', false);
  });

  test('a switch that could not be saved goes back, and says so', async () => {
    const server = withWallet();
    const page = await openBudgets(server, size);
    server.failNext.profile = 500;
    await userEvent.setup().click(carrySwitch(page, size));
    expect(await screen.findByText('Something went wrong. Try again in a moment.')).toBeTruthy();
    await waitFor(() => expect(carrySwitch(page, size)).toHaveProperty('checked', true));
    expect(server.me.settings.carryOverDefault).toBe(true);
  });
});

// Plan's own budget field, beside the table on a computer (R-Desk-Plan)
describe("Plan's budget field", () => {
  test.each([false, true])(
    'a new budget starts as the setting says (carry over %s)',
    async (carry) => {
      const server = withWallet();
      server.me.settings.carryOverDefault = carry;
      renderApp(server, `/?plan&category=${FOOD}`, { size: 'desktop' });
      await screen.findByRole('heading', { name: 'Food' });
      const field = await screen.findByLabelText<HTMLInputElement>('Monthly budget');
      await userEvent.setup().type(field, '300{Enter}');
      await waitFor(() =>
        expect(server.budgets).toEqual([
          { categoryId: FOOD, fromMonth: MONTH, amountCents: 30_000, carryOver: carry },
        ]),
      );
      await waitFor(() =>
        expect(screen.getByRole('switch', { name: 'Carry over' })).toHaveProperty('checked', carry),
      );
    },
  );
});
