import { describe, expect, test, vi } from 'vitest';
import type { Account, Category, Transaction } from '@shared/api';
import { MAX_ACCOUNTS, MAX_TRANSACTION_CENTS, MAX_TRANSACTIONS_PER_ACCOUNT } from '@shared/ledger';
import {
  accountTotals,
  balancesAfter,
  entryRow,
  groupText,
  kindLine,
  listBalance,
  signedMoneyText,
  startedLine,
  totalsLine,
} from './account-text';

// The words and figures of Accounts and an account's page (R-Accounts, R-Account,
// R-Account-Archived, R-Desk-Accounts). Every figure, name and date here is this file's
// own, never the boards' samples. The archived day is read in the person's own time zone,
// pinned here to one whose day differs from UTC's.

vi.hoisted(() => {
  process.env.TZ = 'Asia/Kuala_Lumpur';
});

let n = 0;
function account(a: Partial<Account> & Pick<Account, 'name'>): Account {
  n++;
  return {
    id: n.toString(16).padStart(16, 'a'),
    kind: 'cash',
    currency: 'MYR',
    openingCents: 0,
    balanceCents: 0,
    position: n,
    archived: false,
    archivedAt: null,
    ...a,
  };
}

const POCKET = account({ name: 'Pocket', balanceCents: 4_310 });
const SAVER = account({ name: 'Saver', kind: 'bank', balanceCents: 812_045 });
const OVERDRAWN = account({ name: 'Current', kind: 'bank', balanceCents: -2_500 });
const WALLET = account({ name: 'Wallet', kind: 'ewallet', balanceCents: 0 });
const CARD = account({ name: 'Cobalt card', kind: 'card', balanceCents: -33_190 });
const CREDIT = account({ name: 'Old card', kind: 'card', balanceCents: 700 });
const GONE = account({ name: 'Gone', kind: 'ewallet', archived: true, balanceCents: 9_999 });

describe('the totals at the top of Accounts', () => {
  test('all together is every running account, cards taking away what is owed on them', () => {
    expect(accountTotals([POCKET, SAVER, OVERDRAWN, WALLET, CARD, GONE])).toEqual({
      togetherCents: 4_310 + 812_045 - 2_500 - 33_190,
      haveCents: 4_310 + 812_045 - 2_500,
      owedCents: 33_190,
      others: true,
      cards: true,
    });
  });

  test('an archived account counts in none of them', () => {
    expect(accountTotals([POCKET, GONE])).toMatchObject({
      togetherCents: 4_310,
      haveCents: 4_310,
    });
  });

  test('a card in credit lessens what is owed', () => {
    expect(accountTotals([CARD, CREDIT])).toEqual({
      togetherCents: -33_190 + 700,
      haveCents: 0,
      owedCents: 33_190 - 700,
      others: false,
      cards: true,
    });
  });

  test('the line under it names what is in accounts and what is owed', () => {
    expect(totalsLine(accountTotals([POCKET, SAVER, CARD]), 'MYR')).toBe(
      'RM 8,163.55 in accounts · RM 331.90 owed',
    );
    // No cards: nothing is owed, so it isn't said
    expect(totalsLine(accountTotals([POCKET]), 'MYR')).toBe('RM 43.10 in accounts');
    // Only cards
    expect(totalsLine(accountTotals([CARD]), 'MYR')).toBe('RM 331.90 owed');
    // Overdrawn on the whole
    expect(totalsLine(accountTotals([OVERDRAWN, CARD]), 'MYR')).toBe(
      '−RM 25.00 in accounts · RM 331.90 owed',
    );
    // In credit on the whole
    expect(totalsLine(accountTotals([POCKET, CREDIT]), 'MYR')).toBe(
      'RM 43.10 in accounts · RM 7.00 in credit',
    );
  });

  test('the figure all together keeps its sign, with the currency', () => {
    expect(signedMoneyText(816_355, 'MYR')).toBe('RM 8,163.55');
    expect(signedMoneyText(-28_880, 'MYR')).toBe('−RM 288.80');
    expect(signedMoneyText(0, 'MYR')).toBe('RM 0.00');
    expect(signedMoneyText(1_050, 'SGD')).not.toContain('RM');
  });

  test("each group's total, without the currency", () => {
    expect(groupText('have', 809_545, 'MYR')).toBe('8,095.45');
    expect(groupText('have', -2_500, 'MYR')).toBe('−25.00');
    expect(groupText('owed', 33_190, 'MYR')).toBe('331.90 owed');
    expect(groupText('owed', -700, 'MYR')).toBe('7.00 in credit');
    expect(groupText('owed', 0, 'MYR')).toBe('0.00 owed');
  });
});

describe('the totals at their largest', () => {
  test('every account at the most it can hold still adds up to the cent', () => {
    // The most a balance can reach either way, less a cent so the cents are tested too
    const most = (MAX_TRANSACTIONS_PER_ACCOUNT + 1) * MAX_TRANSACTION_CENTS - 1;
    const banks = Array.from({ length: 30 }, (_, i) =>
      account({ name: `Bank ${i}`, kind: 'bank', balanceCents: most }),
    );
    const cards = Array.from({ length: MAX_ACCOUNTS - 30 }, (_, i) =>
      account({ name: `Card ${i}`, kind: 'card', balanceCents: -most }),
    );
    const big = BigInt(most);
    const have = Number(big * 30n);
    const owed = Number(big * BigInt(MAX_ACCOUNTS - 30));
    const totals = accountTotals([...banks, ...cards]);
    expect(totals).toMatchObject({ haveCents: have, owedCents: owed, togetherCents: have - owed });
    for (const cents of [totals.haveCents, totals.owedCents, totals.togetherCents]) {
      expect(Number.isSafeInteger(cents)).toBe(true);
    }
    expect(groupText('have', totals.haveCents, 'MYR')).toBe('30,000,299,999,999.70');
    expect(groupText('owed', totals.owedCents, 'MYR')).toBe('20,000,199,999,999.80 owed');
    expect(signedMoneyText(totals.togetherCents, 'MYR')).toBe('RM 10,000,099,999,999.90');
  });
});

describe('an account in the list', () => {
  test('its balance without the currency, overdrawn with a minus', () => {
    expect(listBalance(SAVER)).toEqual({ amount: '8,120.45', note: null });
    expect(listBalance(OVERDRAWN)).toEqual({ amount: '−25.00', note: null });
    expect(listBalance(WALLET)).toEqual({ amount: '0.00', note: null });
  });

  test("a card's is what's owed, or what it holds in credit", () => {
    expect(listBalance(CARD)).toEqual({ amount: '331.90', note: 'owed' });
    expect(listBalance(CREDIT)).toEqual({ amount: '7.00', note: 'in credit' });
    expect(listBalance({ ...CARD, balanceCents: 0 })).toEqual({ amount: '0.00', note: 'owed' });
  });

  test('its kind, and the day an archived one was archived, in the local day', () => {
    // 22:40 UTC on Aug 13 is already Aug 14 in Kuala Lumpur
    const archivedAt = Date.parse('2026-08-13T22:40:00Z');
    const today = new Date(2026, 10, 16, 9, 0);
    expect(kindLine(SAVER, today)).toBe('Bank');
    expect(kindLine(WALLET, today)).toBe('E-wallet');
    expect(kindLine(CARD, today)).toBe('Card');
    expect(kindLine({ ...GONE, archivedAt }, today)).toBe('E-wallet · archived Aug 14');
    // Another year's is said with its year
    expect(kindLine({ ...GONE, archivedAt: Date.parse('2025-03-03T04:00:00Z') }, today)).toBe(
      'E-wallet · archived Mar 3, 2025',
    );
    // Archived before the day was kept, or in a copy kept from then: no day to say
    expect(kindLine({ ...GONE, archivedAt: null }, today)).toBe('E-wallet · archived');
    expect(kindLine({ ...GONE, archivedAt: undefined }, today)).toBe('E-wallet · archived');
  });

  test('what it started at, on the desktop pane', () => {
    expect(startedLine({ ...SAVER, openingCents: 150_075 })).toBe('Bank · started at RM 1,500.75');
    expect(startedLine({ ...POCKET, openingCents: 0 })).toBe('Cash · started at RM 0.00');
    expect(startedLine({ ...OVERDRAWN, openingCents: -1_000 })).toBe('Bank · started at −RM 10.00');
    expect(startedLine({ ...CARD, openingCents: -20_000 })).toBe(
      'Card · started at RM 200.00 owed',
    );
    expect(startedLine({ ...CARD, openingCents: 300 })).toBe('Card · started at RM 3.00 in credit');
  });
});

const FOOD = 'f'.repeat(16);
const LUNCH = 'e'.repeat(16);
const PAY = 'd'.repeat(16);
const categories: Category[] = [
  { id: FOOD, name: 'Food', kind: 'expense', parentId: null, position: 0, archived: false },
  { id: LUNCH, name: 'Lunch', kind: 'expense', parentId: FOOD, position: 0, archived: false },
  { id: PAY, name: 'Wages', kind: 'income', parentId: null, position: 0, archived: false },
];

let t = 0;
function entry(e: Partial<Transaction>): Transaction {
  t++;
  return {
    id: t.toString(16).padStart(16, 'c'),
    kind: 'expense',
    accountId: SAVER.id,
    toAccountId: null,
    amountCents: 725,
    categoryId: FOOD,
    payee: null,
    note: null,
    date: '2026-11-03',
    createdAt: t,
    ...e,
  };
}

describe("an entry on an account's own page", () => {
  const row = (e: Transaction) => entryRow(e, SAVER.id, [SAVER, WALLET], categories);

  test('titled by its payee, the category under it, spending with a minus in ink', () => {
    expect(row(entry({ payee: 'Kedai Ali', categoryId: LUNCH }))).toEqual({
      title: 'Kedai Ali',
      subtitle: 'Food › Lunch',
      amount: '−7.25',
      incoming: false,
    });
  });

  test('a note goes beside the category when the payee is the title', () => {
    expect(row(entry({ payee: 'Kedai Ali', note: 'with Mei' }))).toMatchObject({
      title: 'Kedai Ali',
      subtitle: 'Food · with Mei',
    });
  });

  test('with no payee, the note is the title; with neither, the category is', () => {
    expect(row(entry({ note: 'teh tarik' }))).toMatchObject({
      title: 'teh tarik',
      subtitle: 'Food',
    });
    expect(row(entry({}))).toMatchObject({ title: 'Food', subtitle: 'Food' });
  });

  test('income has a plus', () => {
    expect(
      row(entry({ kind: 'income', categoryId: PAY, payee: 'Acme', amountCents: 325_000 })),
    ).toEqual({ title: 'Acme', subtitle: 'Wages', amount: '+3,250.00', incoming: true });
  });

  test("a transfer is signed by what it did to this account's balance", () => {
    const out = entry({
      kind: 'transfer',
      toAccountId: WALLET.id,
      categoryId: null,
      amountCents: 6_000,
    });
    expect(row(out)).toEqual({
      title: 'To Wallet',
      subtitle: 'Transfer',
      amount: '−60.00',
      incoming: false,
    });
    const back = entry({
      kind: 'transfer',
      accountId: WALLET.id,
      toAccountId: SAVER.id,
      categoryId: null,
      amountCents: 1_500,
      note: 'left over',
    });
    expect(row(back)).toEqual({
      title: 'From Wallet',
      subtitle: 'Transfer · left over',
      amount: '+15.00',
      incoming: true,
    });
  });
});

describe('the balance after each entry, on the desktop register', () => {
  test('worked back from the balance now, newest first', () => {
    const rows = [
      entry({ amountCents: 1_000 }),
      entry({ kind: 'income', categoryId: PAY, amountCents: 50_000 }),
      entry({ kind: 'transfer', toAccountId: WALLET.id, categoryId: null, amountCents: 2_000 }),
      entry({
        kind: 'transfer',
        accountId: WALLET.id,
        toAccountId: SAVER.id,
        categoryId: null,
        amountCents: 300,
      }),
    ];
    // 100.00 now, after the newest; after the one before it, 110.00 (the 10.00 not yet
    // spent); after the one before that, −390.00 (the 500.00 not yet in); then −370.00
    expect(balancesAfter(10_000, SAVER.id, rows)).toEqual([10_000, 11_000, -39_000, -37_000]);
  });

  test('none for no entries', () => {
    expect(balancesAfter(10_000, SAVER.id, [])).toEqual([]);
  });
});
