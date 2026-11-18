import { describe, expect, it } from 'vitest';
import type { Account, Ledger, LedgerChange, Recurring } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { MAX_TRANSACTION_CENTS } from '@shared/ledger';
import { MAX_RECURRING, fallsOn, nextAfter } from '@shared/recurring';
import { apply } from './apply';
import { comingUp, dueNow, monthEndForecast, nextThirtyDays } from './forecast';

// What's expected at the end of this month: today's balances of every listed account (what's
// owed on a card counts against it), less the repeating bills still due this month, plus the
// repeating income still due. "Still due" is every occurrence not yet logged or skipped, from
// its next due date (today's and overdue ones too) up to and including the month's last day.
// Transfers between the person's own accounts change nothing. And what's due now (next due
// today or before), which Home asks to log or skip.

const TODAY = '2026-11-06';
const BANK = 'b'.repeat(16);
const CARD = 'c'.repeat(16);
const OLD = 'd'.repeat(16);
const BILLS = DEFAULT_CATEGORIES.find((c) => c.name === 'Bills')!.id;
const SALARY = DEFAULT_CATEGORIES.find((c) => c.name === 'Salary')!.id;

const account = (id: string, name: string, balanceCents: number, more: Partial<Account> = {}) =>
  ({
    id,
    name,
    kind: 'bank',
    currency: 'MYR',
    openingCents: balanceCents,
    balanceCents,
    position: 0,
    archived: false,
    ...more,
  }) satisfies Account;

let made = 0;
const item = (payee: string, more: Partial<Recurring> = {}): Recurring => ({
  id: (++made).toString(16).padStart(16, 'e'),
  kind: 'expense',
  accountId: BANK,
  toAccountId: null,
  amountCents: 1_000,
  categoryId: BILLS,
  payee,
  schedule: 'monthly',
  day: 1,
  startDate: '2026-10-01',
  nextDue: '2026-11-01',
  archived: false,
  ...more,
});

/** Maybank with RM 3,000, a card owing RM 500, and an archived account with RM 900 */
const ledgerWith = (recurring: Recurring[]): Ledger => ({
  accounts: [
    account(BANK, 'Maybank', 300_000),
    account(CARD, 'Visa', -50_000, { kind: 'card' }),
    account(OLD, 'Old', 90_000, { archived: true }),
  ],
  categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
  recurring,
});

const names = (items: { recurring: Recurring }[]) => items.map((i) => i.recurring.payee);

describe('when a repeating item falls due', () => {
  it.each([
    ['monthly', 31, '2026-01-31', '2026-02-28'],
    ['monthly', 31, '2028-01-31', '2028-02-29'],
    ['monthly', 31, '2026-02-28', '2026-03-31'],
    ['monthly', 30, '2026-03-30', '2026-04-30'],
    ['monthly', 1, '2026-11-01', '2026-12-01'],
    ['monthly', 15, '2026-11-06', '2026-11-15'],
    ['monthly', 1, '2026-12-01', '2027-01-01'],
    // 1 is Monday and 7 Sunday; 6 Nov 2026 is a Friday
    ['weekly', 1, '2026-11-06', '2026-11-09'],
    ['weekly', 5, '2026-11-06', '2026-11-13'],
    ['weekly', 7, '2026-11-06', '2026-11-08'],
    ['weekly', 4, '2026-12-31', '2027-01-07'],
  ] as const)('%s on day %i, the next after %s is %s', (schedule, day, after, next) => {
    expect(nextAfter(schedule, day, after)).toBe(next);
    expect(fallsOn(schedule, day, next)).toBe(true);
  });

  it.each([
    ['monthly', 31, '2026-11-30', true],
    ['monthly', 31, '2026-11-29', false],
    ['monthly', 30, '2026-02-28', true],
    ['monthly', 29, '2028-02-29', true],
    ['monthly', 15, '2026-11-16', false],
    ['weekly', 5, '2026-11-06', true],
    ['weekly', 1, '2026-11-06', false],
  ] as const)('%s on day %i falls on %s: %s', (schedule, day, date, falls) => {
    expect(fallsOn(schedule, day, date)).toBe(falls);
  });
});

describe('expected at month end', () => {
  it('is the listed balances when nothing repeats: a card owing counts against them', () => {
    const forecast = monthEndForecast(ledgerWith([]), TODAY);
    // RM 3,000 less RM 500 owed; the archived account's RM 900 is left out
    expect(forecast.balancesCents).toBe(250_000);
    expect(forecast.cents).toBe(250_000);
    expect(forecast.items).toEqual([]);
  });

  it('takes away bills and adds income still due this month, each occurrence once', () => {
    const netflix = item('Netflix', {
      accountId: CARD,
      amountCents: 5_500,
      day: 20,
      nextDue: '2026-11-20',
    });
    const salary = item('Salary', {
      kind: 'income',
      categoryId: SALARY,
      amountCents: 500_000,
      day: 25,
      nextDue: '2026-11-25',
    });
    // Mondays: the 9th, 16th, 23rd and 30th
    const gym = item('Gym', {
      schedule: 'weekly',
      day: 1,
      nextDue: '2026-11-09',
      startDate: '2026-11-02',
    });
    // On the 31st, which November falls on its last day, the 30th
    const loan = item('Loan', { amountCents: 20_000, day: 31, nextDue: '2026-11-30' });
    const forecast = monthEndForecast(ledgerWith([netflix, salary, gym, loan]), TODAY);
    expect(forecast.cents).toBe(250_000 - 5_500 + 500_000 - 4 * 1_000 - 20_000);
    expect(forecast.items.map((i) => [i.recurring.payee, i.date, i.cents])).toEqual([
      ['Gym', '2026-11-09', -1_000],
      ['Gym', '2026-11-16', -1_000],
      ['Netflix', '2026-11-20', -5_500],
      ['Gym', '2026-11-23', -1_000],
      ['Salary', '2026-11-25', 500_000],
      ['Gym', '2026-11-30', -1_000],
      ['Loan', '2026-11-30', -20_000],
    ]);
  });

  it('leaves out transfers, stopped items, ones on archived accounts and ones due next month', () => {
    const forecast = monthEndForecast(
      ledgerWith([
        item('Card payment', {
          kind: 'transfer',
          toAccountId: CARD,
          categoryId: null,
          amountCents: 30_000,
          day: 28,
          nextDue: '2026-11-28',
        }),
        item('Stopped', { day: 10, nextDue: '2026-11-10', archived: true }),
        item('On old', { accountId: OLD, day: 12, nextDue: '2026-11-12' }),
        item('Insurance', { day: 5, nextDue: '2026-12-05' }),
      ]),
      TODAY,
    );
    expect(forecast.cents).toBe(250_000);
    expect(forecast.items).toEqual([]);
  });

  it("counts every occurrence not yet logged or skipped, up to the month's end: one due today or overdue too", () => {
    const forecast = monthEndForecast(
      ledgerWith([
        item('Rent', { amountCents: 120_000, nextDue: '2026-11-01' }),
        item('Phone', { amountCents: 8_000, day: 6, nextDue: TODAY }),
        // Overdue since Monday 26 Oct: 26 Oct, 2 Nov, then 9, 16, 23 and 30 Nov
        item('Gym', { schedule: 'weekly', day: 1, nextDue: '2026-10-26' }),
      ]),
      TODAY,
    );
    expect(forecast.items.map((i) => [i.recurring.payee, i.date])).toEqual([
      ['Gym', '2026-10-26'],
      ['Rent', '2026-11-01'],
      ['Gym', '2026-11-02'],
      ['Phone', TODAY],
      ['Gym', '2026-11-09'],
      ['Gym', '2026-11-16'],
      ['Gym', '2026-11-23'],
      ['Gym', '2026-11-30'],
    ]);
    expect(names(forecast.items).filter((n) => n === 'Gym')).toHaveLength(6);
    expect(forecast.cents).toBe(250_000 - 120_000 - 8_000 - 6 * 1_000);
    expect(forecast.cents).toBe(116_000);
  });

  it('on the last day, counts what is due that day', () => {
    const forecast = monthEndForecast(
      ledgerWith([item('Loan', { day: 31, nextDue: '2026-11-30' })]),
      '2026-11-30',
    );
    expect(forecast.cents).toBe(249_000);
    expect(forecast.items.map((i) => [i.recurring.payee, i.date, i.cents])).toEqual([
      ['Loan', '2026-11-30', -1_000],
    ]);
  });

  it('on the last day, with the next one due next month, is the balances alone', () => {
    const forecast = monthEndForecast(
      ledgerWith([item('Loan', { day: 31, nextDue: '2026-12-31' })]),
      '2026-11-30',
    );
    expect(forecast).toEqual({
      cents: 250_000,
      balancesCents: 250_000,
      billsCents: 0,
      payCents: 0,
      items: [],
    });
  });

  it('can be exactly zero (which is not below it)', () => {
    const forecast = monthEndForecast(
      ledgerWith([item('Rent', { amountCents: 250_000, day: 20, nextDue: '2026-11-20' })]),
      TODAY,
    );
    expect(forecast.cents).toBe(0);
  });

  it('income into a card raises it: what is owed shrinks', () => {
    const forecast = monthEndForecast(
      ledgerWith([
        item('Cashback', {
          kind: 'income',
          categoryId: SALARY,
          accountId: CARD,
          amountCents: 10_000,
          day: 20,
          nextDue: '2026-11-20',
        }),
      ]),
      TODAY,
    );
    expect(forecast.cents).toBe(260_000);
  });

  it('ignores a transfer whatever its ends, even to an archived account', () => {
    const forecast = monthEndForecast(
      ledgerWith([
        item('To old', {
          kind: 'transfer',
          toAccountId: OLD,
          categoryId: null,
          amountCents: 30_000,
          day: 28,
          nextDue: '2026-11-28',
        }),
      ]),
      TODAY,
    );
    expect(forecast.cents).toBe(250_000);
    expect(forecast.items).toEqual([]);
  });

  it('stays exact with 200 weekly items at the largest amount, overdue since 2000', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    // Mondays from 3 Jan 2000 to 30 Nov 2026, both included
    const mondays = (Date.UTC(2026, 10, 30) - Date.UTC(2000, 0, 3)) / DAY_MS / 7 + 1;
    const items = Array.from({ length: 200 }, (_, i) =>
      item(`Weekly ${i}`, {
        schedule: 'weekly',
        day: 1,
        amountCents: 1_000_000_000,
        startDate: '2000-01-03',
        nextDue: '2000-01-03',
      }),
    );
    const ledger: Ledger = {
      ...ledgerWith(items),
      // The largest balance one account can hold: its opening and 100,000 transactions
      accounts: [account(BANK, 'Maybank', 100_001_000_000_000)],
    };
    const forecast = monthEndForecast(ledger, TODAY);
    const exact = 100_001_000_000_000n - 200n * BigInt(mondays) * 1_000_000_000n;
    expect(BigInt(forecast.cents)).toBe(exact);
    expect(Number.isSafeInteger(forecast.cents)).toBe(true);
  });

  it('can be below zero', () => {
    const forecast = monthEndForecast(
      ledgerWith([item('Rent', { amountCents: 400_000, day: 20, nextDue: '2026-11-20' })]),
      TODAY,
    );
    expect(forecast.cents).toBe(-150_000);
  });
});

describe('due now', () => {
  it('is every listed item next due today or before, oldest first, on a listed account', () => {
    // Each asks first (D19): the others are added on their day by the server
    const asking = { askFirst: true };
    const due = dueNow(
      ledgerWith([
        item('Phone', { day: 6, nextDue: TODAY, ...asking }),
        item('Rent', { nextDue: '2026-11-01', ...asking }),
        item('Netflix', { day: 20, nextDue: '2026-11-20', ...asking }),
        item('Stopped', { nextDue: '2026-11-01', archived: true, ...asking }),
        item('On old', { accountId: OLD, nextDue: '2026-11-01', ...asking }),
        item('Card payment', {
          kind: 'transfer',
          toAccountId: CARD,
          categoryId: null,
          day: 2,
          nextDue: '2026-11-02',
          ...asking,
        }),
      ]),
      TODAY,
    );
    expect(due.map((d) => [d.recurring.payee, d.due])).toEqual([
      ['Rent', '2026-11-01'],
      ['Card payment', '2026-11-02'],
      ['Phone', TODAY],
    ]);
  });
});

describe('repeating items changed before the server has them', () => {
  const rent = item('Rent', { amountCents: 120_000, nextDue: '2026-11-01' });
  const log = (transactionId: string): LedgerChange => ({
    op: 'logRecurring',
    id: rent.id,
    due: '2026-11-01',
    transaction: {
      id: transactionId,
      kind: 'expense',
      accountId: BANK,
      toAccountId: null,
      amountCents: 120_000,
      categoryId: BILLS,
      payee: 'Rent',
      note: null,
      date: '2026-11-01',
    },
  });

  it('logging moves the balance and the next due date together, once', () => {
    const before = ledgerWith([rent]);
    // Rent is still due, so the total already has it taken away
    expect(monthEndForecast(before, TODAY).cents).toBe(250_000 - 120_000);
    const once = apply(before, [log('a'.repeat(16))]);
    // Paid: out of the balance instead, so the total holds steady
    expect(monthEndForecast(once, TODAY).cents).toBe(250_000 - 120_000);
    expect(once.accounts.find((a) => a.id === BANK)?.balanceCents).toBe(180_000);
    expect(once.recurring?.[0].nextDue).toBe('2026-12-01');
    // A copy that holds it already (fresh from the server) comes out the same
    expect(apply(once, [log('a'.repeat(16))])).toEqual(once);
    expect(dueNow(once, TODAY)).toEqual([]);
  });

  it('skipping moves the next due date only, once', () => {
    const skipped = apply(ledgerWith([rent]), [
      { op: 'skipRecurring', id: rent.id, due: '2026-11-01' },
    ]);
    expect(skipped.accounts.find((a) => a.id === BANK)?.balanceCents).toBe(300_000);
    expect(skipped.recurring?.[0].nextDue).toBe('2026-12-01');
    // It won't be paid this month, so the total goes up by it
    expect(monthEndForecast(skipped, TODAY).cents).toBe(250_000);
    expect(
      apply(skipped, [{ op: 'skipRecurring', id: rent.id, due: '2026-11-01' }]).recurring?.[0]
        .nextDue,
    ).toBe('2026-12-01');
  });

  it('setting one up lists it, next due after the day it was set up from', () => {
    const added = apply(ledgerWith([]), [
      {
        op: 'addRecurring',
        recurring: {
          id: 'f'.repeat(16),
          kind: 'expense',
          accountId: BANK,
          toAccountId: null,
          amountCents: 5_500,
          categoryId: BILLS,
          payee: 'Netflix',
          schedule: 'monthly',
          day: 31,
          startDate: '2026-10-31',
        },
      },
    ]);
    expect(added.recurring).toEqual([
      expect.objectContaining({ id: 'f'.repeat(16), nextDue: '2026-11-30', archived: false }),
    ]);
    expect(monthEndForecast(added, TODAY).cents).toBe(250_000 - 5_500);
  });

  it('changing, stopping and bringing one back', () => {
    const netflix = item('Netflix', { amountCents: 5_500, day: 20, nextDue: '2026-11-20' });
    let ledger = apply(ledgerWith([netflix]), [
      { op: 'updateRecurring', id: netflix.id, amountCents: 6_000, day: 21, nextDue: '2026-11-21' },
    ]);
    expect(ledger.recurring?.[0]).toMatchObject({
      amountCents: 6_000,
      day: 21,
      nextDue: '2026-11-21',
    });
    expect(monthEndForecast(ledger, TODAY).cents).toBe(250_000 - 6_000);
    ledger = apply(ledger, [{ op: 'archiveRecurring', id: netflix.id, archived: true }]);
    expect(monthEndForecast(ledger, TODAY).cents).toBe(250_000);
    ledger = apply(ledger, [{ op: 'archiveRecurring', id: netflix.id, archived: false }]);
    expect(monthEndForecast(ledger, TODAY).cents).toBe(250_000 - 6_000);
  });

  it('Undo of a log takes the transaction back and makes it due again', () => {
    // Log it is for an item that asks first (D19)
    const logged = apply(ledgerWith([{ ...rent, askFirst: true }]), [log('a'.repeat(16))]);
    const undone = apply(
      logged,
      [
        { op: 'removeTransaction', id: 'a'.repeat(16) },
        { op: 'updateRecurring', id: rent.id, nextDue: '2026-11-01' },
      ],
      (id) =>
        id === 'a'.repeat(16)
          ? {
              ...(log(id) as Extract<LedgerChange, { op: 'logRecurring' }>).transaction,
              createdAt: 1,
            }
          : undefined,
    );
    expect(undone.accounts.find((a) => a.id === BANK)?.balanceCents).toBe(300_000);
    expect(dueNow(undone, TODAY).map((d) => d.recurring.payee)).toEqual(['Rent']);
  });
});

// Home's month-end line ("RM 8,157.00 today − RM 189.00 bills + RM 6,800.00 pay") and its
// Coming up list: the bills and the pay still due this month, each in total, and the next
// time each listed item falls after today.
describe('the bills and pay still due', () => {
  it('are totalled apart, so the balances less the bills plus the pay is the total', () => {
    const forecast = monthEndForecast(
      ledgerWith([
        item('Netflix', { amountCents: 5_500, day: 20, nextDue: '2026-11-20' }),
        item('Rent', { amountCents: 120_000, nextDue: '2026-11-01' }),
        item('Salary', {
          kind: 'income',
          categoryId: SALARY,
          amountCents: 500_000,
          day: 25,
          nextDue: '2026-11-25',
        }),
        item('Card payment', {
          kind: 'transfer',
          toAccountId: CARD,
          categoryId: null,
          amountCents: 30_000,
          day: 28,
          nextDue: '2026-11-28',
        }),
        item('Insurance', { day: 5, nextDue: '2026-12-05' }),
      ]),
      TODAY,
    );
    expect(forecast.billsCents).toBe(125_500);
    expect(forecast.payCents).toBe(500_000);
    expect(forecast.cents).toBe(forecast.balancesCents - forecast.billsCents + forecast.payCents);
  });

  it('are 0 when nothing is due', () => {
    const forecast = monthEndForecast(ledgerWith([]), TODAY);
    expect([forecast.billsCents, forecast.payCents]).toEqual([0, 0]);
  });
});

describe('coming up', () => {
  it("is each listed item's next day after today, soonest first, as many as asked", () => {
    const ledger = ledgerWith([
      item('Rent', { amountCents: 120_000, nextDue: '2026-11-01' }),
      item('Netflix', { amountCents: 5_500, day: 20, nextDue: '2026-11-20' }),
      item('Salary', {
        kind: 'income',
        categoryId: SALARY,
        amountCents: 500_000,
        day: 25,
        nextDue: '2026-11-25',
      }),
      // Due today: its next after today is the 13th
      item('Gym', { schedule: 'weekly', day: 5, nextDue: TODAY }),
      item('Card payment', {
        kind: 'transfer',
        toAccountId: CARD,
        categoryId: null,
        amountCents: 30_000,
        day: 28,
        nextDue: '2026-11-28',
      }),
      item('Stopped', { day: 10, nextDue: '2026-11-10', archived: true }),
      item('On old', { accountId: OLD, day: 12, nextDue: '2026-11-12' }),
    ]);
    expect(comingUp(ledger, TODAY, 10).map((c) => [c.recurring.payee, c.date])).toEqual([
      ['Gym', '2026-11-13'],
      ['Netflix', '2026-11-20'],
      ['Salary', '2026-11-25'],
      ['Card payment', '2026-11-28'],
      // Rent was due on the 1st and is still to log; its next after today is in December
      ['Rent', '2026-12-01'],
    ]);
    expect(comingUp(ledger, TODAY, 3).map((c) => c.recurring.payee)).toEqual([
      'Gym',
      'Netflix',
      'Salary',
    ]);
  });

  it('runs past the end of the month and the year', () => {
    const ledger = ledgerWith([item('Rent', { day: 1, nextDue: '2027-01-01' })]);
    expect(comingUp(ledger, '2026-12-31', 3).map((c) => c.date)).toEqual(['2027-01-01']);
  });

  it('is nothing when nothing repeats', () => {
    expect(comingUp(ledgerWith([]), TODAY, 3)).toEqual([]);
  });
});

// Scheduled entries are added on their day by the server (owner decision D8); only items that
// ask first (D19: overdue when the change shipped, or saved with their day passed) are asked
// about on Home. An item that doesn't ask first, overdue only until the server's next run,
// is still due in the month-end total but never asked about.
describe('due now, once Scheduled adds entries on their day', () => {
  it('asks only about items that ask first', () => {
    const ledger = ledgerWith([
      item('Insurance', { nextDue: '2026-11-01', askFirst: true }),
      item('Phone', { day: 5, nextDue: '2026-11-05', askFirst: false }),
      item('Gym', { day: 6, nextDue: TODAY }),
    ]);
    expect(dueNow(ledger, TODAY).map((d) => [d.recurring.payee, d.due])).toEqual([
      ['Insurance', '2026-11-01'],
    ]);
    // Phone and Gym are still to come out of this month's money
    expect(monthEndForecast(ledger, TODAY).billsCents).toBe(3_000);
  });

  it('keeps asking after Log it while still overdue, until its next is after today', () => {
    const asking = ledgerWith([
      item('Insurance', { schedule: 'weekly', day: 5, nextDue: '2026-10-30', askFirst: true }),
    ]);
    const once = apply(asking, [
      { op: 'skipRecurring', id: asking.recurring![0].id, due: '2026-10-30' },
    ] as LedgerChange[]);
    expect(dueNow(once, TODAY).map((d) => d.due)).toEqual([TODAY]);
    const twice = apply(once, [
      { op: 'skipRecurring', id: asking.recurring![0].id, due: TODAY },
    ] as LedgerChange[]);
    expect(dueNow(twice, TODAY)).toEqual([]);
  });
});

// The next 30 days on Scheduled (owner decision D12): from today's balances and what's
// scheduled, today through the day 30 days on, what comes in and goes out, and each account's
// lowest balance and the day it's first reached. Transfers move money between the person's
// own accounts: each side's balance moves, the totals don't. An occurrence overdue (waiting
// on Home) counts as today's.
describe('the next 30 days', () => {
  const lows = (ledger: Ledger, today = TODAY) =>
    nextThirtyDays(ledger, today).lowest.map((l) => [l.account.name, l.cents, l.date]);

  it('runs from today to the day 30 days on, and with nothing scheduled moves nothing', () => {
    expect(nextThirtyDays(ledgerWith([]), TODAY)).toEqual({
      until: '2026-12-06',
      inCents: 0,
      outCents: 0,
      lowest: [],
    });
  });

  it('finds where an account dips before pay brings it back, and the day it does', () => {
    const rent = item('Rent', { amountCents: 200_000, day: 10, nextDue: '2026-11-10' });
    const phone = item('Phone', { amountCents: 5_000, day: 12, nextDue: '2026-11-12' });
    const salary = item('Salary', {
      kind: 'income',
      categoryId: SALARY,
      amountCents: 150_000,
      day: 25,
      nextDue: '2026-11-25',
    });
    const next = nextThirtyDays(ledgerWith([rent, phone, salary]), TODAY);
    expect(next.inCents).toBe(150_000);
    expect(next.outCents).toBe(205_000);
    // RM 3,000, less 2,000 on the 10th and 50 on the 12th, back up by 1,500 on the 25th
    expect(lows(ledgerWith([rent, phone, salary]))).toEqual([['Maybank', 95_000, '2026-11-12']]);
  });

  it('counts the days across month end, both ends of the window included', () => {
    // From December 20 to January 19: the 31st falls on December 31, the 1st on January 1
    const loan = item('Loan', { amountCents: 20_000, day: 31, nextDue: '2026-12-31' });
    const club = item('Club', { amountCents: 3_000, day: 1, nextDue: '2027-01-01' });
    // Today's and the last day's; the day after that is out
    const today = item('Today', { amountCents: 100, day: 20, nextDue: '2026-12-20' });
    const last = item('Last', { amountCents: 10, day: 19, nextDue: '2027-01-19' });
    const after = item('After', { amountCents: 1, day: 20, nextDue: '2027-01-20' });
    const next = nextThirtyDays(ledgerWith([loan, club, today, last, after]), '2026-12-20');
    expect(next.until).toBe('2027-01-19');
    // Today's again on January 20 is past the window
    expect(next.outCents).toBe(20_000 + 3_000 + 100 + 10);
    expect(lows(ledgerWith([loan, club, today, last, after]), '2026-12-20')).toEqual([
      ['Maybank', 300_000 - 23_110, '2027-01-19'],
    ]);
  });

  it('takes a bill on the 31st on the last day of a short month, and an overdue one today', () => {
    // From February 10 to March 12: January 31's is overdue and counts today, then February 28;
    // March 31 is past the window
    const loan = item('Loan', { amountCents: 20_000, day: 31, nextDue: '2027-01-31' });
    const next = nextThirtyDays(ledgerWith([loan]), '2027-02-10');
    expect(next.outCents).toBe(2 * 20_000);
    expect(lows(ledgerWith([loan]), '2027-02-10')).toEqual([['Maybank', 260_000, '2027-02-28']]);
  });

  it('leaves out a transfer to or from an archived account, moving neither side', () => {
    const toOld = item('To old', {
      kind: 'transfer',
      toAccountId: OLD,
      categoryId: null,
      amountCents: 50_000,
      day: 20,
      nextDue: '2026-11-20',
    });
    const fromOld = item('From old', {
      kind: 'transfer',
      accountId: OLD,
      toAccountId: BANK,
      categoryId: null,
      amountCents: 70_000,
      day: 22,
      nextDue: '2026-11-22',
    });
    expect(nextThirtyDays(ledgerWith([toOld, fromOld]), TODAY)).toEqual({
      until: '2026-12-06',
      inCents: 0,
      outCents: 0,
      lowest: [],
    });
  });

  it('moves both accounts for a transfer, and counts it in neither total', () => {
    const payCard = item('Card', {
      kind: 'transfer',
      toAccountId: CARD,
      categoryId: null,
      amountCents: 50_000,
      day: 20,
      nextDue: '2026-11-20',
    });
    const charge = item('Charge', {
      accountId: CARD,
      amountCents: 2_000,
      day: 8,
      nextDue: '2026-11-08',
    });
    const next = nextThirtyDays(ledgerWith([payCard, charge]), TODAY);
    expect(next.inCents).toBe(0);
    expect(next.outCents).toBe(2_000);
    // In the person's order: Maybank lowest once the card's paid; the card most owed on the 8th
    expect(lows(ledgerWith([payCard, charge]))).toEqual([
      ['Maybank', 250_000, '2026-11-20'],
      ['Visa', -52_000, '2026-11-08'],
    ]);
  });

  it("names today when nothing scheduled takes an account below today's balance", () => {
    const salary = item('Salary', {
      kind: 'income',
      categoryId: SALARY,
      amountCents: 10_000,
      day: 25,
      nextDue: '2026-11-25',
    });
    expect(lows(ledgerWith([salary]))).toEqual([['Maybank', 300_000, TODAY]]);
  });

  it('nets a dip and its recovery on the same day, and names the first of equal lows', () => {
    const out = item('Out', { amountCents: 400_000, day: 15, nextDue: '2026-11-15' });
    const back = item('Back', {
      kind: 'income',
      categoryId: SALARY,
      amountCents: 400_000,
      day: 15,
      nextDue: '2026-11-15',
    });
    const later = item('Later', { amountCents: 1_000, day: 20, nextDue: '2026-11-20' });
    const refund = item('Refund', {
      kind: 'income',
      categoryId: SALARY,
      amountCents: 1_000,
      day: 22,
      nextDue: '2026-11-22',
    });
    const evenAgain = item('Again', { amountCents: 1_000, day: 28, nextDue: '2026-11-28' });
    // The 15th ends where it began; 2,990 on the 20th, again on the 28th: the 20th is named
    expect(lows(ledgerWith([out, back, later, refund, evenAgain]))).toEqual([
      ['Maybank', 299_000, '2026-11-20'],
    ]);
  });

  it('counts what waits on Home as today, and leaves out stopped items and archived accounts', () => {
    const waiting = item('Insurance', {
      schedule: 'weekly',
      day: 5,
      nextDue: '2026-10-23',
      askFirst: true,
    });
    const stopped = item('Stopped', { amountCents: 99_999, archived: true });
    const onOld = item('Old', {
      accountId: OLD,
      amountCents: 99_999,
      day: 9,
      nextDue: '2026-11-09',
    });
    const next = nextThirtyDays(ledgerWith([waiting, stopped, onOld]), TODAY);
    // October 23 and 30 and today, the 6th, all count today; then the 13th to December 4
    expect(next.outCents).toBe(7 * 1_000);
    expect(lows(ledgerWith([waiting, stopped, onOld]))).toEqual([
      ['Maybank', 293_000, '2026-12-04'],
    ]);
  });

  it('stays exact at the limits: every item at the most, five times in the window', () => {
    // From Monday November 9 to December 9: Mondays the 9th to December 7, five of them
    const most = Array.from({ length: MAX_RECURRING }, (_, i) =>
      item(`Most ${i}`, {
        schedule: 'weekly',
        day: 1,
        amountCents: MAX_TRANSACTION_CENTS,
        nextDue: '2026-11-09',
      }),
    );
    const next = nextThirtyDays(ledgerWith(most), '2026-11-09');
    expect(next.outCents).toBe(MAX_RECURRING * 5 * MAX_TRANSACTION_CENTS);
    expect(lows(ledgerWith(most), '2026-11-09')).toEqual([
      ['Maybank', 300_000 - MAX_RECURRING * 5 * MAX_TRANSACTION_CENTS, '2026-12-07'],
    ]);
  });
});
