// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  PUSH_ENDPOINT,
  fakeServer,
  reloadApp,
  renderApp,
  setupAppTests,
  stubPush,
} from '../../testing/app';

// Budgets and reminders (R-Set-Budgets, R-Desk-Set-Budgets; digest 3.15; owner decision
// D14): "Carry over, for new budgets" is a switch, saved at once, and decides whether a
// budget set where there was none carries over to start with. The reminder rows (owner
// decision D6, "Push with details") set the daily reminder, its time and the reminder
// before a scheduled entry, and say whether this device gets them: allowing notifications
// subscribes it, from the person's tap only. Names and figures are made up.

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
    expect(page.getByText('Heads-up before scheduled entries')).toBeTruthy();
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

/** Each control as its board names it: the phone's rows, a computer's buttons beside them */
const controls = (size: (typeof SIZES)[number]) =>
  size === 'desktop'
    ? {
        daily: 'Daily reminder',
        time: (value: string) => `Reminder time: ${value}`,
        before: (value: string) => `Remind before scheduled items: ${value}`,
      }
    : {
        daily: 'Daily reminder to log',
        time: (value: string) => new RegExp(`^Remind me at .*${value}$`),
        before: (value: string) => new RegExp(`^Heads-up before scheduled entries .*${value}$`),
      };

/** What the device row is named on this size: this phone, or this computer */
const here = (size: (typeof SIZES)[number]) =>
  size === 'desktop' ? 'Reminders on this computer' : 'Reminders on this phone';

describe.each(SIZES)('Reminders (%s)', (size) => {
  const named = controls(size);

  test('the daily reminder, its time and the one before a scheduled entry, as drawn', async () => {
    stubPush({ permission: 'default' });
    const page = await openBudgets(withWallet(), size);
    expect(page.getByRole('switch', { name: named.daily })).toHaveProperty('checked', true);
    expect(page.getByRole('button', { name: named.time('9:00 PM') })).toBeTruthy();
    expect(page.getByRole('button', { name: named.before('1 day before') })).toBeTruthy();
    expect(page.getByText("If nothing's added that day")).toBeTruthy();
    // On a computer the time sits beside the daily switch, with no line of its own
    if (size === 'phone') expect(page.getByText('When reminders come, each day')).toBeTruthy();
    expect(
      page.getByText('A notification before a scheduled bill or income is added'),
    ).toBeTruthy();
  });

  test('the daily reminder off is saved', async () => {
    stubPush({ permission: 'default' });
    const server = withWallet();
    const page = await openBudgets(server, size);
    await userEvent.setup().click(page.getByRole('switch', { name: named.daily }));
    await waitFor(() => expect(server.me.settings.dailyReminder).toBe(false));
    expect(page.getByRole('switch', { name: named.daily })).toHaveProperty('checked', false);
  });

  test('a new time is saved, and shown on the person’s clock', async () => {
    stubPush({ permission: 'default' });
    const server = withWallet();
    const page = await openBudgets(server, size);
    const user = userEvent.setup();
    await user.click(page.getByRole('button', { name: named.time('9:00 PM') }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Remind me at' }));
    const field = sheet.getByLabelText<HTMLInputElement>('Time');
    expect(field.value).toBe('21:00');
    fireEvent.change(field, { target: { value: '20:30' } });
    await user.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.me.settings.reminderTime).toBe('20:30'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(page.getByRole('button', { name: named.time('8:30 PM') })).toBeTruthy();
  });

  test('how many days before, or none, is saved as it is picked', async () => {
    stubPush({ permission: 'default' });
    const server = withWallet();
    const page = await openBudgets(server, size);
    const user = userEvent.setup();
    await user.click(page.getByRole('button', { name: named.before('1 day before') }));
    let sheet = within(
      await screen.findByRole('dialog', { name: 'Heads-up before scheduled entries' }),
    );
    expect(sheet.getByRole('radio', { name: '1 day before' })).toHaveProperty('checked', true);
    expect(sheet.getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual([
      'Off',
      '1 day before',
      '2 days before',
      '3 days before',
      '4 days before',
      '5 days before',
      '6 days before',
      '7 days before',
    ]);
    await user.click(sheet.getByRole('radio', { name: '3 days before' }));
    await waitFor(() => expect(server.me.settings.scheduledReminderDays).toBe(3));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(page.getByRole('button', { name: named.before('3 days before') }));
    sheet = within(
      await screen.findByRole('dialog', { name: 'Heads-up before scheduled entries' }),
    );
    await user.click(sheet.getByRole('radio', { name: 'Off' }));
    await waitFor(() => expect(server.me.settings.scheduledReminderDays).toBeNull());
    expect(await page.findByRole('button', { name: named.before('Off') })).toBeTruthy();
  });

  test('allowing notifications subscribes this device for the account, from the tap', async () => {
    const browser = stubPush({ permission: 'default', answer: 'granted' });
    const server = withWallet();
    const page = await openBudgets(server, size);
    // Never asked on its own
    expect(browser.asked).toBe(0);
    const row = within(page.getByText(here(size)).closest('[data-setting]') as HTMLElement);
    expect(row.getByText('Allow notifications to get them here')).toBeTruthy();
    await userEvent.setup().click(row.getByRole('button', { name: 'Allow notifications' }));
    expect(browser.asked).toBe(1);
    expect(await row.findByText('Allowed: they come here')).toBeTruthy();
    expect(row.queryByRole('button', { name: 'Allow notifications' })).toBeNull();
    expect(browser.subscribedWith).toEqual([server.pushKey]);
    expect(server.pushSubscriptions).toEqual([
      {
        email: 'ryan@example.com',
        endpoint: PUSH_ENDPOINT,
        keys: { p256dh: expect.any(String), auth: expect.any(String) },
      },
    ]);
  });

  test('says when this device already gets them', async () => {
    stubPush({ permission: 'granted', subscribed: true });
    const server = withWallet();
    server.pushSubscriptions.push({
      email: 'ryan@example.com',
      endpoint: PUSH_ENDPOINT,
      keys: { p256dh: 'p', auth: 'a' },
    });
    const page = await openBudgets(server, size);
    expect(await page.findByText('Allowed: they come here')).toBeTruthy();
    expect(page.queryByRole('button', { name: 'Allow notifications' })).toBeNull();
  });

  test('the browser refusing permission: says how to allow them, and subscribes nothing', async () => {
    const browser = stubPush({ permission: 'default', answer: 'denied' });
    const server = withWallet();
    const page = await openBudgets(server, size);
    await userEvent.setup().click(page.getByRole('button', { name: 'Allow notifications' }));
    expect(
      await page.findByText(
        "Notifications are blocked. Allow them for Mahnee in the browser's settings.",
      ),
    ).toBeTruthy();
    expect(page.queryByRole('button', { name: 'Allow notifications' })).toBeNull();
    expect(browser.subscribedWith).toEqual([]);
    expect(server.pushSubscriptions).toEqual([]);
  });

  test('blocked before: says so, without asking', async () => {
    const browser = stubPush({ permission: 'denied' });
    const page = await openBudgets(withWallet(), size);
    expect(
      await page.findByText(
        "Notifications are blocked. Allow them for Mahnee in the browser's settings.",
      ),
    ).toBeTruthy();
    expect(browser.asked).toBe(0);
  });

  test('the server refusing the subscription: says why, and lets the browser go', async () => {
    const browser = stubPush({ permission: 'default', answer: 'granted' });
    const server = withWallet();
    server.pushKey = null;
    const page = await openBudgets(server, size);
    await userEvent.setup().click(page.getByRole('button', { name: 'Allow notifications' }));
    expect(await screen.findByText("Reminders aren't ready on the server yet.")).toBeTruthy();
    expect(server.pushSubscriptions).toEqual([]);
    expect(browser.subscription).toBeNull();
    expect(page.getByRole('button', { name: 'Allow notifications' })).toBeTruthy();
  });

  test('a browser that can’t show notifications says so', async () => {
    stubPush({ supported: false });
    const page = await openBudgets(withWallet(), size);
    expect(await page.findByText("This browser can't show notifications.")).toBeTruthy();
    expect(page.queryByRole('button', { name: 'Allow notifications' })).toBeNull();
  });

  test('with every reminder off, there is nothing to allow', async () => {
    stubPush({ permission: 'default' });
    const server = withWallet();
    server.me.settings.dailyReminder = false;
    server.me.settings.scheduledReminderDays = null;
    const page = await openBudgets(server, size);
    expect(page.queryByText(here(size))).toBeNull();
    expect(page.queryByRole('button', { name: 'Allow notifications' })).toBeNull();
  });
});

test('an iPhone asks for the app on the Home Screen first', async () => {
  stubPush({ supported: false, iphone: true });
  const page = await openBudgets(withWallet(), 'phone');
  expect(await page.findByText('Add Mahnee to your Home Screen to get them.')).toBeTruthy();
});

test('signing out lets this device go, on the server and in the browser', async () => {
  const browser = stubPush({ permission: 'granted', subscribed: true });
  const server = withWallet();
  server.pushSubscriptions.push({
    email: 'ryan@example.com',
    endpoint: PUSH_ENDPOINT,
    keys: { p256dh: 'p', auth: 'a' },
  });
  renderApp(server, '/?settings', { size: 'phone' });
  const sentTo: string[] = [];
  const real = window.location;
  vi.stubGlobal(
    'location',
    new Proxy(
      {},
      {
        get: (_, key) => Reflect.get(real, key),
        set: (_, key, value: string) => {
          if (key === 'href') sentTo.push(value);
          return true;
        },
      },
    ),
  );
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(sentTo).toEqual(['/cdn-cgi/access/logout']));
  vi.unstubAllGlobals();
  expect(server.pushSubscriptions).toEqual([]);
  expect(browser.subscription).toBeNull();
});
