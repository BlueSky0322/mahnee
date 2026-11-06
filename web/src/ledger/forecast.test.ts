import { describe, expect, it } from 'vitest';
import type { Account, Ledger, LedgerChange, Recurring } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { fallsOn, nextAfter } from '@shared/recurring';
import { apply } from './apply';
import { dueNow, monthEndForecast } from './forecast';

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
    expect(forecast).toEqual({ cents: 250_000, balancesCents: 250_000, items: [] });
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
    const due = dueNow(
      ledgerWith([
        item('Phone', { day: 6, nextDue: TODAY }),
        item('Rent', { nextDue: '2026-11-01' }),
        item('Netflix', { day: 20, nextDue: '2026-11-20' }),
        item('Stopped', { nextDue: '2026-11-01', archived: true }),
        item('On old', { accountId: OLD, nextDue: '2026-11-01' }),
        item('Card payment', {
          kind: 'transfer',
          toAccountId: CARD,
          categoryId: null,
          day: 2,
          nextDue: '2026-11-02',
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
    const logged = apply(ledgerWith([rent]), [log('a'.repeat(16))]);
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
