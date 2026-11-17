// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Recurring, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';

// Plan › Scheduled (R-Bills, R-Desk-Bills; R-Empty-Bills, R-Desk-Empty-Bills; edit
// R-Bill-Edit, R-Bill-Edit-Tnb and their desktop boards; digest 3.8, 4.5, 4.6; owner
// decisions D8 and D19): every scheduled item, grouped as Expenses and Income with what
// each comes to in a month (a weekly one counted each time it falls in the person's month)
// and Transfers, "not an expense"; each with its day, account (or "amount changes") and
// next date. A card that is owed with no payment scheduled says so. Entries added from
// Scheduled this month are counted, with a link to them in Activity. Tapping an item opens
// it to change (Same amount / It changes) or stop; Schedule something (or a common one)
// sets a new one up. Every figure and name here is this file's own.

// Where the person is: Malaysia, eight hours ahead of UTC. The clock reads 00:30 on Tuesday
// 10 November there, still the 9th in UTC, so a day taken from UTC is wrong.
const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'Asia/Kuala_Lumpur';
afterAll(() => {
  process.env.TZ = TZ_BEFORE;
});

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const [BANK, VISA, WALLET, OLD] = ['b', 'c', 'd', 'e'].map((c) => c.repeat(16));
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [BILLS, FUN, HEALTH, SALARY] = ['Bills', 'Fun', 'Health', 'Salary'].map(id);

function tenthJustAfterMidnight() {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 0, 30, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

let made = 0;
const scheduled = (more: Partial<Recurring>): Recurring => ({
  id: (++made).toString(16).padStart(16, '9'),
  kind: 'expense',
  accountId: BANK,
  toAccountId: null,
  amountCents: 1_000,
  categoryId: BILLS,
  payee: null,
  schedule: 'monthly',
  day: 1,
  startDate: '2026-10-01',
  nextDue: '2026-12-01',
  archived: false,
  amountVaries: false,
  askFirst: false,
  ...more,
});

const RENT = scheduled({ payee: 'Rent', amountCents: 135_000, day: 1, nextDue: '2026-12-01' });
const STREAMING = scheduled({
  payee: 'Streaming',
  accountId: VISA,
  categoryId: FUN,
  amountCents: 3_990,
  day: 3,
  nextDue: '2026-12-03',
});
const POWER = scheduled({
  payee: 'Power',
  amountCents: 21_040,
  day: 20,
  nextDue: '2026-11-20',
  amountVaries: true,
});
/** Mondays: November 2, 9, 16, 23 and 30 */
const GYM = scheduled({
  payee: 'Gym',
  categoryId: HEALTH,
  amountCents: 1_500,
  schedule: 'weekly',
  day: 1,
  nextDue: '2026-11-16',
});
const PAY = scheduled({
  kind: 'income',
  payee: 'Initech',
  categoryId: SALARY,
  amountCents: 520_000,
  day: 25,
  nextDue: '2026-11-25',
});
const TOP_UP = scheduled({
  kind: 'transfer',
  payee: 'Top-up',
  toAccountId: WALLET,
  categoryId: null,
  amountCents: 8_000,
  day: 5,
  nextDue: '2026-12-05',
});
const STOPPED = scheduled({ payee: 'Old gym', amountCents: 9_900, archived: true });
const ON_OLD = scheduled({ payee: 'Old loan', accountId: OLD, amountCents: 7_700 });

let seeded = 0;
function fromScheduled(
  server: FakeServer,
  r: Recurring,
  date: string,
  more: Partial<Transaction> = {},
) {
  seeded++;
  server.transactions.push({
    id: seeded.toString(16).padStart(16, '0'),
    kind: r.kind,
    accountId: r.accountId,
    toAccountId: r.toAccountId,
    amountCents: r.amountCents,
    categoryId: r.categoryId,
    payee: r.payee,
    note: null,
    date,
    createdAt: seeded,
    scheduled: { recurringId: r.id, due: date, toCheck: false },
    ...more,
  });
}

/** Maybank with RM 5,000, Visa owing RM 800, an e-wallet and an archived account */
function withAccounts(recurring: Recurring[]) {
  const server = fakeServer();
  const account = (accountId: string, name: string, kind: string, openingCents: number) => ({
    id: accountId,
    name,
    kind: kind as 'bank',
    currency: 'MYR',
    openingCents,
    position: server.accounts.length,
    archived: false,
  });
  server.accounts.push(
    account(BANK, 'Maybank', 'bank', 500_000),
    account(VISA, 'Visa', 'card', -80_000),
    account(WALLET, 'Wallet', 'ewallet', 0),
    { ...account(OLD, 'Old', 'bank', 0), archived: true },
  );
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  server.recurring = recurring.map((r) => ({ ...r }));
  return server;
}

/** Everything set up, with five entries added from Scheduled this month */
function everything() {
  const server = withAccounts([RENT, STREAMING, POWER, GYM, PAY, TOP_UP, STOPPED, ON_OLD]);
  fromScheduled(server, RENT, '2026-11-01');
  fromScheduled(server, GYM, '2026-11-02');
  fromScheduled(server, STREAMING, '2026-11-03');
  fromScheduled(server, TOP_UP, '2026-11-05');
  fromScheduled(server, GYM, '2026-11-09');
  return server;
}

/** The text a person sees in `el`, its parts joined by spaces, leaving out what's hidden */
function seen(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) parts.push(text);
      return;
    }
    if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return;
    node.childNodes.forEach(walk);
  };
  walk(el);
  return parts.join(' ');
}

const group = (name: string) => screen.getByRole('region', { name });
const rows = (name: string) => within(group(name)).getAllByRole('button').map(seen);

async function open(server: FakeServer, size: (typeof SIZES)[number]) {
  tenthJustAfterMidnight();
  renderApp(server, '/?plan=scheduled', { size });
  await screen.findByRole('region', { name: 'Expenses' }, { timeout: 3000 });
  return userEvent.setup();
}

/** What a select shows chosen */
const selected = (name: string, scope: Pick<typeof screen, 'getByRole'> = screen) =>
  scope.getByRole<HTMLSelectElement>('combobox', { name }).selectedOptions[0]?.textContent;

describe('every scheduled item', () => {
  test('on a phone: Expenses and Income with what each comes to a month, then Transfers', async () => {
    await open(everything(), 'phone');
    expect(screen.getByRole('heading', { level: 1, name: 'Plan' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeTruthy();
    const halves = screen.getByRole('navigation', { name: 'Plan' });
    expect(
      within(halves).getByRole('link', { name: 'Scheduled' }).getAttribute('aria-current'),
    ).toBe('page');
    // 1,350.00 + 39.90 + 210.40 + five Mondays of 15.00
    expect(seen(group('Expenses'))).toContain('RM 1,675.30 a month');
    expect(rows('Expenses')).toEqual([
      'Rent 1st · Maybank −1,350.00 Next Dec 1',
      'Streaming 3rd · Visa −39.90 Next Dec 3',
      'Power 20th · amount changes −210.40 Next Nov 20',
      'Gym Mondays · Maybank −15.00 Next Nov 16',
    ]);
    expect(seen(group('Income'))).toContain('RM 5,200.00 a month');
    expect(rows('Income')).toEqual(['Salary 25th · Initech +5,200.00 Next Nov 25']);
    expect(seen(group('Transfers'))).toContain('not an expense');
    expect(rows('Transfers')).toEqual(['Top-up to Wallet 5th · from Maybank 80.00 Next Dec 5']);
    // A stopped item, and one on an archived account, are nowhere
    expect(screen.queryByText(/Old gym|Old loan/)).toBeNull();
  });

  test('on a computer: each item by its day of the month, its next date and amount', async () => {
    await open(everything(), 'desktop');
    expect(screen.getByRole('button', { name: 'Schedule something' })).toBeTruthy();
    expect(seen(group('Expenses'))).toContain('RM 1,675.30 a month');
    expect(rows('Expenses')).toEqual([
      'Rent 1st of the month Next Dec 1 −1,350.00',
      'Streaming 3rd of the month Next Dec 3 −39.90',
      'Power 20th of the month Next Nov 20 · amount changes about −210.40',
      'Gym Every Monday Next Nov 16 −15.00',
    ]);
    expect(rows('Income')).toEqual(['Salary, Initech 25th of the month Next Nov 25 +5,200.00']);
    expect(rows('Transfers')).toEqual(['Top-up to Wallet 5th of the month Next Dec 5 80.00']);
  });

  test.each(SIZES)(
    'counts what was added from Scheduled this month, with a link to them (%s)',
    async (size) => {
      await open(everything(), size);
      const link = await screen.findByRole('link', { name: '5 added this month · See them' });
      expect(link.getAttribute('href')).toBe('?activity&scheduled');
    },
  );

  test.each(SIZES)('says nothing of what was added while nothing was (%s)', async (size) => {
    await open(withAccounts([RENT]), size);
    expect(screen.queryByRole('link', { name: /added this month/ })).toBeNull();
  });

  test.each(SIZES)(
    'says a card is owed with no payment scheduled, to the date of its last charge ahead (%s)',
    async (size) => {
      const user = await open(everything(), size);
      // Owed RM 839.90 (RM 800 and Streaming's RM 39.90 this month), and Streaming again on Dec 3
      expect(
        (
          await screen.findAllByText(
            (_, el) =>
              el != null &&
              seen(el) === 'Visa: RM 879.80 owed by Dec 3, no payment scheduled. Schedule one',
          )
        ).length,
      ).toBeGreaterThan(0);
      await user.click(screen.getByRole('link', { name: 'Schedule one' }));
      const form = within(await screen.findByRole('dialog', { name: 'New schedule' }));
      expect(form.getByRole('radio', { name: 'Transfer' })).toHaveProperty('checked', true);
      expect(selected('To', form)).toBe('Visa');
    },
  );

  test.each(SIZES)(
    'counts no charge more than 30 days ahead, and names no date when none is (%s)',
    async (size) => {
      // Visa owes RM 800; its one charge is on December 11, 31 days after the 10th
      await open(
        withAccounts([
          scheduled({
            payee: 'Club',
            accountId: VISA,
            categoryId: FUN,
            day: 11,
            nextDue: '2026-12-11',
          }),
        ]),
        size,
      );
      expect(
        (
          await screen.findAllByText(
            (_, el) =>
              el != null && seen(el) === 'Visa: RM 800.00 owed, no payment scheduled. Schedule one',
          )
        ).length,
      ).toBeGreaterThan(0);
    },
  );

  test.each(SIZES)('says nothing of a card with a payment scheduled into it (%s)', async (size) => {
    const server = everything();
    server.recurring.push(
      scheduled({ kind: 'transfer', payee: 'Card', toAccountId: VISA, categoryId: null, day: 28 }),
    );
    await open(server, size);
    expect(screen.queryByText(/no payment scheduled/)).toBeNull();
  });

  test.each(SIZES)(
    'an overdue one that asks first says when it was due; Home asks about it (%s)',
    async (size) => {
      const server = withAccounts([
        scheduled({
          payee: 'Insurance',
          amountCents: 9_900,
          nextDue: '2026-11-01',
          askFirst: true,
        }),
      ]);
      const user = await open(server, size);
      expect(rows('Expenses')).toEqual([
        size === 'phone'
          ? 'Insurance 1st · Maybank −99.00 Was due Nov 1'
          : 'Insurance 1st of the month Was due Nov 1 −99.00',
      ]);
      await user.click(within(group('Expenses')).getByRole('button'));
      const sheet = within(await screen.findByRole('dialog', { name: 'Insurance' }));
      expect(sheet.getByText('Nov 1 · waiting for you on Home: Log it or Skip')).toBeTruthy();
    },
  );
});

describe('nothing scheduled yet', () => {
  test.each(SIZES)('says so, with common ones to start from (%s)', async (size) => {
    tenthJustAfterMidnight();
    renderApp(withAccounts([]), '/?plan=scheduled', { size });
    expect(await screen.findByRole('heading', { name: 'Nothing scheduled' })).toBeTruthy();
    expect(screen.getByText('Rent, bills and pay, added on their day.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Schedule something' })).toBeTruthy();
    expect(screen.getByText('Common ones')).toBeTruthy();
    for (const name of ['Rent', 'Salary', 'Phone bill', 'Netflix', 'Car loan']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.queryByRole('region', { name: 'Expenses' })).toBeNull();
  });

  test.each(SIZES)('a common one opens a new schedule filled in for it (%s)', async (size) => {
    tenthJustAfterMidnight();
    renderApp(withAccounts([]), '/?plan=scheduled', { size });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Phone bill' }));
    let form = within(await screen.findByRole('dialog', { name: 'New schedule' }));
    expect(form.getByRole('radio', { name: 'Expense' })).toHaveProperty('checked', true);
    expect(form.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Phone bill');
    expect(selected('For', form)).toBe('Bills');
    await user.click(form.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Salary' }));
    form = within(await screen.findByRole('dialog', { name: 'New schedule' }));
    expect(form.getByRole('radio', { name: 'Income' })).toHaveProperty('checked', true);
    expect(selected('For', form)).toBe('Salary');
  });
});

describe('setting one up', () => {
  test.each(SIZES)(
    'Schedule something sets one up, first on the day picked, shown at once (%s)',
    async (size) => {
      const server = everything();
      const user = await open(server, size);
      await user.click(
        screen.getByRole('button', { name: size === 'phone' ? 'Schedule' : 'Schedule something' }),
      );
      const form = within(await screen.findByRole('dialog', { name: 'New schedule' }));
      await user.type(form.getByRole('textbox', { name: 'Name' }), 'Water');
      await user.type(form.getByRole('textbox', { name: 'Amount' }), '30.15');
      await user.click(form.getByRole('radio', { name: 'It changes' }));
      await user.selectOptions(form.getByRole('combobox', { name: 'From' }), 'Maybank');
      await user.selectOptions(form.getByRole('combobox', { name: 'For' }), 'Bills');
      await user.selectOptions(
        form.getByRole('combobox', { name: 'Repeats' }),
        'Monthly on the 12th',
      );
      // The first one after today, on its day
      expect(form.getByLabelText('First on')).toHaveProperty('value', '2026-11-12');
      await user.click(form.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(rows('Expenses')).toContain(
        size === 'phone'
          ? 'Water 12th · amount changes −30.15 Next Nov 12'
          : 'Water 12th of the month Next Nov 12 · amount changes about −30.15',
      );
      await waitFor(() =>
        expect(server.recurring.find((r) => r.payee === 'Water')).toEqual({
          id: expect.stringMatching(/^[0-9a-f]{16}$/),
          kind: 'expense',
          accountId: BANK,
          toAccountId: null,
          amountCents: 3_015,
          categoryId: BILLS,
          payee: 'Water',
          schedule: 'monthly',
          day: 12,
          startDate: '2026-11-10',
          nextDue: '2026-11-12',
          archived: false,
          amountVaries: true,
          askFirst: false,
        }),
      );
    },
  );
});

describe('changing one', () => {
  test.each(SIZES)('opens it with what it adds, and when, from where (%s)', async (size) => {
    const user = await open(everything(), size);
    await user.click(within(group('Expenses')).getByRole('button', { name: /Streaming/ }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Streaming' }));
    expect(sheet.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(sheet.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(sheet.getByRole('textbox', { name: 'Amount' })).toHaveProperty('value', '39.90');
    const each = within(sheet.getByRole('radiogroup', { name: 'Amount each time' }));
    expect(each.getByRole('radio', { name: 'Same amount' })).toHaveProperty('checked', true);
    expect(each.getByRole('radio', { name: 'It changes' })).toHaveProperty('checked', false);
    expect(selected('From', sheet)).toBe('Visa');
    expect(selected('For', sheet)).toBe('Fun');
    expect(selected('Repeats', sheet)).toBe('Monthly on the 3rd');
    expect(sheet.getByText('Dec 3 · added automatically from Visa')).toBeTruthy();
    expect(sheet.getByRole('button', { name: 'Stop scheduling Streaming' })).toBeTruthy();
    expect(sheet.queryByText('last time')).toBeNull();
  });

  test.each(SIZES)(
    'one whose amount changes is added for the person to check (%s)',
    async (size) => {
      const user = await open(everything(), size);
      await user.click(within(group('Expenses')).getByRole('button', { name: /Power/ }));
      const sheet = within(await screen.findByRole('dialog', { name: 'Power' }));
      expect(sheet.getByRole('radio', { name: 'It changes' })).toHaveProperty('checked', true);
      expect(sheet.getByText('last time')).toBeTruthy();
      expect(sheet.getByText('Nov 20 · added at RM 210.40, for you to check')).toBeTruthy();
    },
  );

  test.each(SIZES)('saves a new amount, and that it changes, shown at once (%s)', async (size) => {
    const server = everything();
    const user = await open(server, size);
    await user.click(within(group('Expenses')).getByRole('button', { name: /Streaming/ }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Streaming' }));
    const amount = sheet.getByRole('textbox', { name: 'Amount' });
    await user.clear(amount);
    await user.type(amount, '42.90');
    await user.click(sheet.getByRole('radio', { name: 'It changes' }));
    expect(sheet.getByText('Dec 3 · added at RM 42.90, for you to check')).toBeTruthy();
    await user.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rows('Expenses')[1]).toBe(
      size === 'phone'
        ? 'Streaming 3rd · amount changes −42.90 Next Dec 3'
        : 'Streaming 3rd of the month Next Dec 3 · amount changes about −42.90',
    );
    await waitFor(() =>
      expect(server.recurring.find((r) => r.id === STREAMING.id)).toMatchObject({
        amountCents: 4_290,
        amountVaries: true,
      }),
    );
  });

  test.each(SIZES)('a refused change is put back and says why (%s)', async (size) => {
    const server = everything();
    const user = await open(server, size);
    await user.click(within(group('Expenses')).getByRole('button', { name: /Streaming/ }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Streaming' }));
    const amount = sheet.getByRole('textbox', { name: 'Amount' });
    await user.clear(amount);
    await user.type(amount, '42.90');
    server.failNext.changes = { status: 409, error: 'That no longer repeats' };
    await user.click(sheet.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('That no longer repeats')).toBeTruthy();
    await waitFor(() =>
      expect(rows('Expenses')[1]).toBe(
        size === 'phone'
          ? 'Streaming 3rd · Visa −39.90 Next Dec 3'
          : 'Streaming 3rd of the month Next Dec 3 −39.90',
      ),
    );
    expect(server.recurring.find((r) => r.id === STREAMING.id)?.amountCents).toBe(3_990);
  });

  test.each(SIZES)('stops one, with Undo bringing it back (%s)', async (size) => {
    const server = everything();
    const user = await open(server, size);
    await user.click(within(group('Expenses')).getByRole('button', { name: /Streaming/ }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Streaming' }));
    await user.click(sheet.getByRole('button', { name: 'Stop scheduling Streaming' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rows('Expenses').some((r) => r.startsWith('Streaming'))).toBe(false);
    // RM 1,675.30 less Streaming
    expect(seen(group('Expenses'))).toContain('RM 1,635.40 a month');
    await waitFor(() =>
      expect(server.recurring.find((r) => r.id === STREAMING.id)?.archived).toBe(true),
    );
    expect(screen.getByText('Stopped scheduling Streaming')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(server.recurring.find((r) => r.id === STREAMING.id)?.archived).toBe(false),
    );
    expect(rows('Expenses')[1]).toBe(
      size === 'phone'
        ? 'Streaming 3rd · Visa −39.90 Next Dec 3'
        : 'Streaming 3rd of the month Next Dec 3 −39.90',
    );
    expect(server.recurring.find((r) => r.id === STREAMING.id)?.nextDue).toBe('2026-12-03');
  });

  test.each(SIZES)('stopping one leaves what it added counted (%s)', async (size) => {
    const user = await open(everything(), size);
    await screen.findByRole('link', { name: '5 added this month · See them' });
    await user.click(within(group('Expenses')).getByRole('button', { name: /Streaming/ }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Streaming' }));
    await user.click(sheet.getByRole('button', { name: 'Stop scheduling Streaming' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('link', { name: '5 added this month · See them' })).toBeTruthy();
  });
});

describe("the person's month", () => {
  test.each(SIZES)(
    'from the 28th: a weekly item counts the Mondays from October 28 to November 27 (%s)',
    async (size) => {
      const server = everything();
      server.me.settings = { ...server.me.settings, monthStartDay: 28 };
      // Either side of each edge of October 28 to November 27
      fromScheduled(server, RENT, '2026-10-27');
      fromScheduled(server, RENT, '2026-10-28');
      fromScheduled(server, GYM, '2026-11-27');
      fromScheduled(server, GYM, '2026-11-28');
      await open(server, size);
      // 1,350.00 + 39.90 + 210.40 + four Mondays of 15.00 (Nov 2, 9, 16 and 23)
      await waitFor(() => expect(seen(group('Expenses'))).toContain('RM 1,660.30 a month'));
      expect(
        await screen.findByRole('link', { name: '7 added this month · See them' }),
      ).toBeTruthy();
    },
  );
});

/** The connection drops: the browser says so, and nothing reaches the server */
function goOffline(server: FakeServer) {
  server.health = 'unreachable';
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  act(() => void window.dispatchEvent(new Event('offline')));
  onTestFinished(() => onLine.mockRestore());
  return () => {
    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
  };
}

describe('setting one up: weekly, offline and refused', () => {
  /** Opens New schedule and fills in Water, RM 30.15 from Maybank for Bills */
  async function newWater(user: ReturnType<typeof userEvent.setup>, size: (typeof SIZES)[number]) {
    await user.click(
      screen.getByRole('button', { name: size === 'phone' ? 'Schedule' : 'Schedule something' }),
    );
    const form = within(await screen.findByRole('dialog', { name: 'New schedule' }));
    await user.type(form.getByRole('textbox', { name: 'Name' }), 'Water');
    await user.type(form.getByRole('textbox', { name: 'Amount' }), '30.15');
    await user.selectOptions(form.getByRole('combobox', { name: 'From' }), 'Maybank');
    await user.selectOptions(form.getByRole('combobox', { name: 'For' }), 'Bills');
    return form;
  }

  test.each(SIZES)(
    'a weekly one falls on its weekday, first on the next one (%s)',
    async (size) => {
      const server = everything();
      const user = await open(server, size);
      const form = await newWater(user, size);
      await user.selectOptions(
        form.getByRole('combobox', { name: 'Repeats' }),
        'Weekly on Thursdays',
      );
      // Tuesday the 10th: the next Thursday is the 12th
      expect(form.getByLabelText('First on')).toHaveProperty('value', '2026-11-12');
      await user.click(form.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(server.recurring.find((r) => r.payee === 'Water')).toMatchObject({
          schedule: 'weekly',
          day: 4,
          nextDue: '2026-11-12',
        }),
      );
    },
  );

  test.each(SIZES)(
    'one set up offline shows at once and is saved once, back online, with its first date (%s)',
    async (size) => {
      const server = everything();
      const user = await open(server, size);
      const backOnline = goOffline(server);
      const form = await newWater(user, size);
      await user.selectOptions(
        form.getByRole('combobox', { name: 'Repeats' }),
        'Monthly on the 12th',
      );
      await user.click(form.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(rows('Expenses').some((r) => r.startsWith('Water 12th'))).toBe(true);
      expect(server.recurring.some((r) => r.payee === 'Water')).toBe(false);
      backOnline();
      await waitFor(() =>
        expect(server.recurring.filter((r) => r.payee === 'Water')).toEqual([
          expect.objectContaining({ day: 12, startDate: '2026-11-10', nextDue: '2026-11-12' }),
        ]),
      );
    },
  );

  test.each(SIZES)('a refused one is taken away again and says why (%s)', async (size) => {
    const server = everything();
    const user = await open(server, size);
    const form = await newWater(user, size);
    await user.selectOptions(
      form.getByRole('combobox', { name: 'Repeats' }),
      'Monthly on the 12th',
    );
    server.failNext.changes = {
      status: 409,
      error: 'You can have up to 200 repeating items, stopped ones included',
    };
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('You can have up to 200 repeating items, stopped ones included'),
    ).toBeTruthy();
    await waitFor(() => expect(rows('Expenses').some((r) => r.startsWith('Water'))).toBe(false));
    expect(server.recurring.some((r) => r.payee === 'Water')).toBe(false);
  });
});
