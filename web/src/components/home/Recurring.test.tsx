// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get } from 'idb-keyval';
import { afterAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Recurring, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, holdNext, reloadApp, renderApp, setupAppTests } from '../../testing/app';
import { outboxKey } from '../../offline/outbox';

// Bills and income that repeat. Each due one (next due today or before) is at the top of
// Home, "Due: Rent RM 1,200.00 from Maybank", with Log it and Skip; nothing is recorded until
// it's confirmed. One total, "Expected at month end", is today's balances of every listed
// account (a card's owed amount counting against them), less the bills still due this
// month, plus the income still due (after today, to the month's last day); tapping it lists
// them, and it says in words when it would be below zero. Set up from a transaction's sheet.

// Where the person is: Malaysia, eight hours ahead of UTC, so a day starts there before it
// does in UTC. Set for this file only (each test file runs in its own process).
const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'Asia/Kuala_Lumpur';
afterAll(() => {
  process.env.TZ = TZ_BEFORE;
});

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const RYAN = 'ryan@example.com';
const BANK = 'b'.repeat(16);
const CARD = 'c'.repeat(16);
const OLD = 'd'.repeat(16);
const BILLS = DEFAULT_CATEGORIES.find((c) => c.name === 'Bills')!.id;
const SALARY = DEFAULT_CATEGORIES.find((c) => c.name === 'Salary')!.id;
/** Friday 6 November 2026, mid-morning where the person is */
const TODAY = '2026-11-06';

/** The app's clock reads `at` (local time where the person is), and still ticks */
function clockAt(at: Date) {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(at);
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** The app's clock reads Friday 6 November 2026, mid-morning, and still ticks */
const onTheSixth = () => clockAt(new Date(2026, 10, 6, 10, 0, 0));

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

let made = 0;
const repeating = (payee: string | null, more: Partial<Recurring> = {}): Recurring => ({
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

const RENT = () => repeating('Rent', { amountCents: 120_000, nextDue: '2026-11-01' });
const PHONE = () => repeating('Phone', { amountCents: 8_000, day: 6, nextDue: TODAY });
const NETFLIX = () =>
  repeating('Netflix', { accountId: CARD, amountCents: 5_500, day: 20, nextDue: '2026-11-20' });
const SALARY_IN = (nextDue = '2026-11-25') =>
  repeating('Salary', {
    kind: 'income',
    categoryId: SALARY,
    amountCents: 500_000,
    day: 25,
    nextDue,
  });
/** Mondays; after today that's the 9th, 16th, 23rd and 30th */
const GYM = (nextDue = '2026-11-09') =>
  repeating('Gym', { schedule: 'weekly', day: 1, startDate: '2026-10-19', nextDue });
const CARD_PAYMENT = (nextDue = '2026-11-28') =>
  repeating('Card payment', {
    kind: 'transfer',
    toAccountId: CARD,
    categoryId: null,
    amountCents: 30_000,
    day: 28,
    nextDue,
  });

/**
 * Maybank with RM 3,000, a Visa card owing RM 500, and an archived account holding RM 900,
 * with these repeating
 */
function withAccounts(recurring: Recurring[], bankCents = 300_000) {
  const server = fakeServer();
  const account = (id: string, name: string, kind: 'bank' | 'card', openingCents: number) => ({
    id,
    name,
    kind,
    currency: 'MYR',
    openingCents,
    position: server.accounts.length,
    archived: false,
  });
  server.accounts.push(
    account(BANK, 'Maybank', 'bank', bankCents),
    account(CARD, 'Visa', 'card', -50_000),
    { ...account(OLD, 'Old', 'bank', 90_000), archived: true },
  );
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  server.recurring = recurring;
  return server;
}

/** Everything the run's first screen has: due, still due this month, and left out */
const everything = () => [
  RENT(),
  PHONE(),
  NETFLIX(),
  SALARY_IN(),
  GYM(),
  CARD_PAYMENT(),
  repeating('Old gym', { amountCents: 99_900, day: 10, nextDue: '2026-11-10', archived: true }),
  repeating('Insurance', { amountCents: 20_000, day: 5, nextDue: '2026-12-05' }),
];

/** The total on Home, as its button is named ("Expected at month end: RM 7,405.00"), or null */
const expected = () =>
  screen.queryByRole('button', { name: /^Expected at month end/ })?.getAttribute('aria-label') ??
  screen.queryByRole('button', { name: /^Expected at month end/ })?.textContent ??
  null;

/** A November day as the person's language writes it: "9 Nov", or "Nov 9" */
const day = (n: number) => new RegExp(`\\b${n} Nov\\b|\\bNov ${n}\\b`);

/** The name of the total's button for `money` */
const total = (money: string) => `Expected at month end: ${money}`;

/** Maybank's balance on Home, as read out ("RM 3,000.00"), or null while it isn't shown */
const maybank = () =>
  screen
    .queryByRole('button', { name: /^Maybank,/ })
    ?.getAttribute('aria-label')
    ?.split(', ')
    .at(-1) ?? null;

/** A due item's row, by what it says */
const dueRow = async (text: string) => {
  await screen.findByText(text);
  return within(screen.getByRole('group', { name: text }));
};

/** What's still waiting on this device for Ryan, as kept there */
const keptForRyan = async () =>
  (await get<{ email: string; value: unknown[] }>(outboxKey(RYAN)))?.value ?? [];

const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

const nextDueOn = (server: FakeServer, payee: string) =>
  server.recurring.find((r) => r.payee === payee)?.nextDue;

describe('repeating bills and income on Home', () => {
  test.each(SIZES)(
    'shows what is due at the top of Home, recording nothing until it is confirmed (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts(everything());
      renderApp(server, '/', { size });

      const rent = await screen.findByText(/Due: Rent/);
      expect(rent.textContent).toBe('Due: Rent RM 1,200.00 from Maybank');
      expect(await screen.findByText('Due: Phone RM 80.00 from Maybank')).toBeTruthy();
      // Not due yet, stopped, or next month: not asked about
      for (const later of [
        /Due: Netflix/,
        /Due: Salary/,
        /Due: Gym/,
        /Due: Old gym/,
        /Due: Insurance/,
      ]) {
        expect(screen.queryByText(later)).toBeNull();
      }
      // At the top: before the month and the accounts
      const month = screen.getByRole('region', { name: /November 2026/ });
      expect(rent.compareDocumentPosition(month) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(
        rent.compareDocumentPosition(screen.getByRole('button', { name: /^Maybank,/ })) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      const row = await dueRow('Due: Rent RM 1,200.00 from Maybank');
      expect(row.getByRole('button', { name: 'Log it' })).toBeTruthy();
      expect(row.getByRole('button', { name: 'Skip' })).toBeTruthy();

      // Nothing moved: no transaction saved, the balance as it was
      await pause(100);
      expect(server.transactions).toEqual([]);
      expect(maybank()).toBe('RM 3,000.00');
    },
  );

  test.each(SIZES)(
    'names income, transfers and an item with no payee in words (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([
        SALARY_IN('2026-11-01'),
        CARD_PAYMENT('2026-11-02'),
        repeating(null, { amountCents: 10_000, day: 3, nextDue: '2026-11-03' }),
      ]);
      renderApp(server, '/', { size });
      expect(await screen.findByText('Due: Salary RM 5,000.00 into Maybank')).toBeTruthy();
      expect(screen.getByText('Due: Card payment RM 300.00 from Maybank to Visa')).toBeTruthy();
      expect(screen.getByText('Due: Bills RM 100.00 from Maybank')).toBeTruthy();
    },
  );

  test.each(SIZES)(
    'shows one total expected at month end, and lists what makes it up when tapped (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts(everything());
      renderApp(server, '/', { size });
      const user = userEvent.setup();

      await screen.findByText(/Expected at month end/);
      // RM 3,000 less RM 500 owed on Visa (Old is archived), less Rent RM 1,200 and Phone RM 80
      // (due now, still to pay), Netflix RM 55 and Gym 4 x RM 10, plus Salary RM 5,000. The card
      // payment is a transfer.
      await waitFor(() => expect(expected()).toBe(total('RM 6,125.00')));
      expect(screen.getAllByRole('button', { name: /^Expected at month end/ })).toHaveLength(1);
      expect(screen.queryByText(/below zero/)).toBeNull();

      await user.click(screen.getByRole('button', { name: /^Expected at month end/ }));
      const dialog = within(await screen.findByRole('dialog', { name: 'Expected at month end' }));
      const rows = within(dialog.getByRole('list', { name: 'Still due this month' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent ?? '');
      expect(rows.map((r) => /Rent|Phone|Gym|Netflix|Salary/.exec(r)?.[0])).toEqual([
        'Rent',
        'Phone',
        'Gym',
        'Gym',
        'Netflix',
        'Gym',
        'Salary',
        'Gym',
      ]);
      expect(rows[0]).toMatch(day(1));
      expect(rows[0]).toMatch(/RM 1,200\.00/);
      expect(rows[1]).toMatch(day(6));
      expect(rows[1]).toMatch(/RM 80\.00/);
      expect(rows[2]).toMatch(day(9));
      expect(rows[2]).toMatch(/RM 10\.00/);
      expect(rows[4]).toMatch(day(20));
      expect(rows[4]).toMatch(/RM 55\.00/);
      expect(rows[6]).toMatch(/RM 5,000\.00/);
      expect(dialog.getByText(/RM 2,500\.00/)).toBeTruthy();
      for (const left of [/Card payment/, /Old gym/, /Insurance/]) {
        expect(
          within(dialog.getByRole('list', { name: 'Still due this month' })).queryByText(left),
        ).toBeNull();
      }
    },
  );

  test.each(SIZES)('says in words when it would go below zero (%s)', async (size) => {
    onTheSixth();
    const server = withAccounts(
      [repeating('Rent', { amountCents: 120_000, day: 20, nextDue: '2026-11-20' })],
      60_000,
    );
    renderApp(server, '/', { size });
    // RM 600 less RM 500 owed, less RM 1,200
    await waitFor(() => expect(expected()).toBe(total('−RM 1,100.00')));
    expect(screen.getByText(/RM 1,100\.00 below zero/)).toBeTruthy();
  });

  test.each(SIZES)('is not shown while nothing repeats (%s)', async (size) => {
    onTheSixth();
    renderApp(withAccounts([]), '/', { size });
    await screen.findByRole('button', { name: /^Maybank,/ });
    await pause(100);
    expect(screen.queryByText(/Expected at month end/)).toBeNull();
  });

  test.each(SIZES)(
    'Log it records it on the day it was due and moves the balance and the next due date; Undo puts both back (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([RENT(), NETFLIX()]);
      renderApp(server, '/', { size });
      const user = userEvent.setup();
      // RM 3,000 less RM 500 owed, less Netflix RM 55 and Rent RM 1,200 (due now, still to pay).
      // Logged, Rent moves from what's still due into the balance: the total holds steady.
      await waitFor(() => expect(expected()).toBe(total('RM 1,245.00')));

      const row = await dueRow('Due: Rent RM 1,200.00 from Maybank');
      await user.click(row.getByRole('button', { name: 'Log it' }));
      await waitFor(() => expect(server.transactions).toHaveLength(1));
      expect(server.transactions[0]).toMatchObject({
        kind: 'expense',
        accountId: BANK,
        toAccountId: null,
        amountCents: 120_000,
        categoryId: BILLS,
        payee: 'Rent',
        date: '2026-11-01',
      } satisfies Partial<Transaction>);
      await waitFor(() => expect(nextDueOn(server, 'Rent')).toBe('2026-12-01'));
      expect(screen.queryByText(/Due: Rent/)).toBeNull();
      expect(maybank()).toBe('RM 1,800.00');
      expect(expected()).toBe(total('RM 1,245.00'));

      await user.click(await screen.findByRole('button', { name: 'Undo' }));
      expect(await screen.findByText('Due: Rent RM 1,200.00 from Maybank')).toBeTruthy();
      expect(maybank()).toBe('RM 3,000.00');
      await waitFor(() => expect(server.transactions).toEqual([]));
      await waitFor(() => expect(nextDueOn(server, 'Rent')).toBe('2026-11-01'));
      expect(expected()).toBe(total('RM 1,245.00'));
    },
  );

  test.each(SIZES)(
    'Skip moves the next due date and records nothing; Undo makes it due again (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([PHONE(), NETFLIX()]);
      renderApp(server, '/', { size });
      const user = userEvent.setup();
      // RM 3,000 less RM 500 owed, less Netflix RM 55 and Phone RM 80 (due now)
      await waitFor(() => expect(expected()).toBe(total('RM 2,365.00')));

      const row = await dueRow('Due: Phone RM 80.00 from Maybank');
      await user.click(row.getByRole('button', { name: 'Skip' }));
      await waitFor(() => expect(nextDueOn(server, 'Phone')).toBe('2026-12-06'));
      expect(screen.queryByText(/Due: Phone/)).toBeNull();
      expect(server.transactions).toEqual([]);
      expect(maybank()).toBe('RM 3,000.00');
      // It won't be paid this month: the total goes up by it
      expect(expected()).toBe(total('RM 2,445.00'));

      await user.click(await screen.findByRole('button', { name: 'Undo' }));
      expect(await screen.findByText('Due: Phone RM 80.00 from Maybank')).toBeTruthy();
      await waitFor(() => expect(nextDueOn(server, 'Phone')).toBe(TODAY));
      expect(expected()).toBe(total('RM 2,365.00'));
    },
  );

  test.each(SIZES)(
    'a weekly item overdue for two weeks is asked about once for each (%s)',
    async (size) => {
      onTheSixth();
      // Due Monday 26 Oct and Monday 2 Nov; the next, Monday 9 Nov, isn't due yet
      const server = withAccounts([GYM('2026-10-26')]);
      renderApp(server, '/', { size });
      const user = userEvent.setup();
      let row = await dueRow('Due: Gym RM 10.00 from Maybank');
      await user.click(row.getByRole('button', { name: 'Log it' }));
      await waitFor(() => expect(nextDueOn(server, 'Gym')).toBe('2026-11-02'));
      row = await dueRow('Due: Gym RM 10.00 from Maybank');
      await user.click(row.getByRole('button', { name: 'Log it' }));
      await waitFor(() => expect(nextDueOn(server, 'Gym')).toBe('2026-11-09'));
      await waitFor(() => expect(screen.queryByText(/Due: Gym/)).toBeNull());
      expect(server.transactions.map((t) => t.date).sort()).toEqual(['2026-10-26', '2026-11-02']);
    },
  );

  test.each(SIZES)(
    'a log saved whose answer was lost is counted once in the balance and the total, across a reload (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([RENT(), NETFLIX()]);
      renderApp(server, '/', { size });
      const user = userEvent.setup();
      await waitFor(() => expect(expected()).toBe(total('RM 1,245.00')));

      server.loseNext.changes = true;
      const row = await dueRow('Due: Rent RM 1,200.00 from Maybank');
      await user.click(row.getByRole('button', { name: 'Log it' }));
      await waitFor(() => expect(server.transactions).toHaveLength(1));
      expect(server.loseNext.changes).toBe(false);
      expect(await keptForRyan()).toHaveLength(1);

      // Reopened while it's sent again (held up): the fresh balances hold it already
      const resend = holdNext(server, 'POST', '/api/changes');
      await reloadApp(server, '/', { size });
      const seen = { balance: new Set<string>(), total: new Set<string>(), due: false };
      const note = () => {
        const [b, t] = [maybank(), expected()];
        if (b != null) seen.balance.add(b);
        if (t != null) seen.total.add(t);
        if (screen.queryByText(/Due: Rent/) != null) seen.due = true;
      };
      const observer = new MutationObserver(note);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      try {
        await waitFor(() => expect(maybank()).not.toBeNull());
        await waitFor(() => expect(expected()).not.toBeNull());
        await pause(50);
        expect(maybank()).toBe('RM 1,800.00');
        expect(expected()).toBe(total('RM 1,245.00'));

        resend.release();
        await waitFor(async () => expect(await keptForRyan()).toEqual([]), { timeout: 8000 });
        await pause(50);
        note();
        expect(server.transactions).toHaveLength(1);
        expect(nextDueOn(server, 'Rent')).toBe('2026-12-01');
        // Since the reload, only ever counted once, and never asked about again
        expect([...seen.balance]).toEqual(['RM 1,800.00']);
        expect([...seen.total]).toEqual([total('RM 1,245.00')]);
        expect(seen.due).toBe(false);
      } finally {
        resend.release();
        observer.disconnect();
      }
    },
    20_000,
  );

  test.each(SIZES)(
    "sets one up from a transaction's sheet, monthly on its day, next due the month after (%s)",
    async (size) => {
      onTheSixth();
      const server = withAccounts([]);
      server.transactions.push({
        id: 'a'.repeat(16),
        kind: 'expense',
        accountId: BANK,
        toAccountId: null,
        amountCents: 120_000,
        categoryId: BILLS,
        payee: 'Rent',
        note: null,
        date: '2026-11-01',
        createdAt: 1,
      });
      renderApp(server, `/?account=${BANK}`, { size });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Bills, Rent, −RM 1,200.00' }));
      const sheet = within(await screen.findByRole('dialog', { name: 'Edit transaction' }));
      if (sheet.getByRole('button', { name: 'More' }).getAttribute('aria-expanded') !== 'true') {
        await user.click(sheet.getByRole('button', { name: 'More' }));
      }
      await user.selectOptions(sheet.getByLabelText('Repeat'), 'Monthly');
      await user.click(sheet.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(server.recurring).toEqual([
          expect.objectContaining({
            kind: 'expense',
            accountId: BANK,
            toAccountId: null,
            amountCents: 120_000,
            categoryId: BILLS,
            payee: 'Rent',
            schedule: 'monthly',
            day: 1,
            startDate: '2026-11-01',
            nextDue: '2026-12-01',
            archived: false,
          }),
        ]),
      );
      // The transaction itself stays one
      expect(server.transactions).toHaveLength(1);
      await reloadApp(server, '/', { size });
      // RM 3,000 less RM 1,200 less RM 500 owed; the next Rent is in December
      await waitFor(() => expect(expected()).toBe(total('RM 1,300.00')));
      expect(screen.queryByText(/Due: Rent/)).toBeNull();
    },
  );

  test.each(SIZES)('sets one up weekly on the day of the week it was on (%s)', async (size) => {
    onTheSixth();
    const server = withAccounts([]);
    // Wednesday 4 November
    server.transactions.push({
      id: 'a'.repeat(16),
      kind: 'expense',
      accountId: BANK,
      toAccountId: null,
      amountCents: 1_000,
      categoryId: BILLS,
      payee: 'Gym',
      note: null,
      date: '2026-11-04',
      createdAt: 1,
    });
    renderApp(server, `/?account=${BANK}`, { size });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Bills, Gym, −RM 10.00' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Edit transaction' }));
    if (sheet.getByRole('button', { name: 'More' }).getAttribute('aria-expanded') !== 'true') {
      await user.click(sheet.getByRole('button', { name: 'More' }));
    }
    await user.selectOptions(sheet.getByLabelText('Repeat'), 'Weekly');
    await user.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(server.recurring).toEqual([
        expect.objectContaining({
          schedule: 'weekly',
          day: 3,
          startDate: '2026-11-04',
          nextDue: '2026-11-11',
        }),
      ]),
    );
    await reloadApp(server, '/', { size });
    // RM 2,990 less RM 500 owed, less the 11th, 18th and 25th
    await waitFor(() => expect(expected()).toBe(total('RM 2,460.00')));
  });

  test.each(SIZES)(
    'changes or stops one from the list behind the total, with Undo (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([NETFLIX(), SALARY_IN()]);
      renderApp(server, '/', { size });
      const user = userEvent.setup();
      // RM 2,500 less RM 55 plus RM 5,000
      await waitFor(() => expect(expected()).toBe(total('RM 7,445.00')));
      await user.click(screen.getByRole('button', { name: /^Expected at month end/ }));
      let dialog = within(await screen.findByRole('dialog', { name: 'Expected at month end' }));
      await user.click(dialog.getByRole('button', { name: /^Netflix/ }));
      let sheet = within(await screen.findByRole('dialog', { name: 'Repeating' }));
      await user.click(sheet.getByRole('button', { name: 'Stop repeating' }));
      await waitFor(() =>
        expect(server.recurring.find((r) => r.payee === 'Netflix')?.archived).toBe(true),
      );
      await waitFor(() => expect(expected()).toBe(total('RM 7,500.00')));
      await user.click(await screen.findByRole('button', { name: 'Undo' }));
      await waitFor(() =>
        expect(server.recurring.find((r) => r.payee === 'Netflix')?.archived).toBe(false),
      );
      await waitFor(() => expect(expected()).toBe(total('RM 7,445.00')));

      if (screen.queryByRole('dialog', { name: 'Expected at month end' }) == null) {
        await user.click(screen.getByRole('button', { name: /^Expected at month end/ }));
      }
      dialog = within(await screen.findByRole('dialog', { name: 'Expected at month end' }));
      await user.click(dialog.getByRole('button', { name: /^Salary/ }));
      sheet = within(await screen.findByRole('dialog', { name: 'Repeating' }));
      const amount = sheet.getByLabelText('Amount');
      await user.clear(amount);
      await user.type(amount, '5500');
      await user.click(sheet.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(server.recurring.find((r) => r.payee === 'Salary')?.amountCents).toBe(550_000),
      );
      await waitFor(() => expect(expected()).toBe(total('RM 7,945.00')));
    },
  );
});

describe('repeating items: edges, refusals and the order of answers', () => {
  test.each(SIZES)('a total of exactly RM 0.00 is not said to be below zero (%s)', async (size) => {
    onTheSixth();
    // RM 1,000 less RM 500 owed, less a RM 500 bill on the 20th
    const server = withAccounts(
      [repeating('Rent', { amountCents: 50_000, day: 20, nextDue: '2026-11-20' })],
      100_000,
    );
    renderApp(server, '/', { size });
    await waitFor(() => expect(expected()).toBe(total('RM 0.00')));
    expect(screen.queryByText(/below zero/)).toBeNull();
  });

  test.each(SIZES)(
    "uses the person's own day: at 00:30 on the 7th in Kuala Lumpur, the 7th's item is due (%s)",
    async (size) => {
      // Still the 6th in UTC (16:30)
      clockAt(new Date(2026, 10, 7, 0, 30, 0));
      const server = withAccounts([
        repeating('Phone', { amountCents: 8_000, day: 7, nextDue: '2026-11-07' }),
      ]);
      renderApp(server, '/', { size });
      const user = userEvent.setup();
      const row = await dueRow('Due: Phone RM 80.00 from Maybank');
      // RM 2,500 less the RM 80 still to pay
      expect(expected()).toBe(total('RM 2,420.00'));
      await user.click(row.getByRole('button', { name: 'Log it' }));
      await waitFor(() => expect(server.transactions).toHaveLength(1));
      expect(server.transactions[0].date).toBe('2026-11-07');
      await waitFor(() => expect(nextDueOn(server, 'Phone')).toBe('2026-12-07'));
      expect(expected()).toBe(total('RM 2,420.00'));
    },
  );

  test.each(SIZES)(
    "at 23:30 on 30 November, the month ends tonight: the 30th counts, the 1st doesn't (%s)",
    async (size) => {
      clockAt(new Date(2026, 10, 30, 23, 30, 0));
      const server = withAccounts([
        repeating('Loan', { amountCents: 20_000, day: 30, nextDue: '2026-11-30' }),
        repeating('Insurance', { amountCents: 20_000, day: 1, nextDue: '2026-12-01' }),
      ]);
      renderApp(server, '/', { size });
      expect(await screen.findByText('Due: Loan RM 200.00 from Maybank')).toBeTruthy();
      expect(screen.queryByText(/Due: Insurance/)).toBeNull();
      await waitFor(() => expect(expected()).toBe(total('RM 2,300.00')));
    },
  );

  test.each(SIZES)(
    'stopping the only repeating item takes the total away, and Undo brings it back (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([NETFLIX()]);
      renderApp(server, '/', { size });
      const user = userEvent.setup();
      await waitFor(() => expect(expected()).toBe(total('RM 2,445.00')));
      await user.click(screen.getByRole('button', { name: /^Expected at month end/ }));
      const dialog = within(await screen.findByRole('dialog', { name: 'Expected at month end' }));
      await user.click(dialog.getByRole('button', { name: /^Netflix/ }));
      const sheet = within(await screen.findByRole('dialog', { name: 'Repeating' }));
      await user.click(sheet.getByRole('button', { name: 'Stop repeating' }));
      await waitFor(() => expect(expected()).toBeNull());
      await waitFor(() => expect(server.recurring[0].archived).toBe(true));
      await user.click(await screen.findByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(expected()).toBe(total('RM 2,445.00')));
      await waitFor(() => expect(server.recurring[0].archived).toBe(false));
    },
  );

  test.each(SIZES)(
    'Log it refused because another device skipped it first: put back, said why, nothing saved (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([RENT(), NETFLIX()]);
      renderApp(server, '/', { size });
      const user = userEvent.setup();
      const row = await dueRow('Due: Rent RM 1,200.00 from Maybank');
      await waitFor(() => expect(maybank()).toBe('RM 3,000.00'));
      // Skipped on another device; this one still shows it due
      server.recurring.find((r) => r.payee === 'Rent')!.nextDue = '2026-12-01';
      await user.click(row.getByRole('button', { name: 'Log it' }));
      expect(await screen.findByText('That was logged or skipped already')).toBeTruthy();
      await pause(100);
      expect(server.transactions).toEqual([]);
      expect(nextDueOn(server, 'Rent')).toBe('2026-12-01');
      // What the server has: nothing paid, and Rent no longer due
      await waitFor(() => expect(maybank()).toBe('RM 3,000.00'));
      await waitFor(() => expect(screen.queryByText(/Due: Rent/)).toBeNull());
      // RM 2,500 less Netflix RM 55; Rent was skipped
      await waitFor(() => expect(expected()).toBe(total('RM 2,445.00')));
    },
  );

  test.each(SIZES)('two quick taps on Log it record it once (%s)', async (size) => {
    onTheSixth();
    const server = withAccounts([RENT()]);
    renderApp(server, '/', { size });
    const user = userEvent.setup();
    const row = await dueRow('Due: Rent RM 1,200.00 from Maybank');
    await user.dblClick(row.getByRole('button', { name: 'Log it' }));
    await waitFor(() => expect(nextDueOn(server, 'Rent')).toBe('2026-12-01'));
    await pause(200);
    expect(server.transactions).toHaveLength(1);
    expect(maybank()).toBe('RM 1,800.00');
  });

  test.each(SIZES)(
    'Log it offline shows at once and is saved once back online (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([RENT(), NETFLIX()]);
      renderApp(server, '/', { size });
      const user = userEvent.setup();
      const row = await dueRow('Due: Rent RM 1,200.00 from Maybank');
      await waitFor(() => expect(expected()).toBe(total('RM 1,245.00')));
      const backOnline = goOffline(server);
      await user.click(row.getByRole('button', { name: 'Log it' }));
      expect(maybank()).toBe('RM 1,800.00');
      expect(screen.queryByText(/Due: Rent/)).toBeNull();
      expect(expected()).toBe(total('RM 1,245.00'));
      await pause(100);
      expect(server.transactions).toEqual([]);
      backOnline();
      await waitFor(() => expect(server.transactions).toHaveLength(1), { timeout: 8000 });
      await waitFor(async () => expect(await keptForRyan()).toEqual([]), { timeout: 8000 });
      expect(nextDueOn(server, 'Rent')).toBe('2026-12-01');
      expect(maybank()).toBe('RM 1,800.00');
    },
    20_000,
  );

  /**
   * Opens Rent (RM 1,200 on Maybank, on `date`) on Maybank's page and sets it repeating
   * `schedule` from its sheet, as the person would
   */
  async function repeatRentFrom(
    server: FakeServer,
    date: string,
    schedule: 'Monthly' | 'Weekly',
    size: (typeof SIZES)[number],
  ) {
    server.transactions.push({
      id: 'a'.repeat(16),
      kind: 'expense',
      accountId: BANK,
      toAccountId: null,
      amountCents: 120_000,
      categoryId: BILLS,
      payee: 'Rent',
      note: null,
      date,
      createdAt: 1,
    });
    renderApp(server, `/?account=${BANK}`, { size });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Bills, Rent, −RM 1,200.00' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Edit transaction' }));
    if (sheet.getByRole('button', { name: 'More' }).getAttribute('aria-expanded') !== 'true') {
      await user.click(sheet.getByRole('button', { name: 'More' }));
    }
    await user.selectOptions(sheet.getByLabelText('Repeat'), schedule);
    await user.click(sheet.getByRole('button', { name: 'Save' }));
    return user;
  }

  test.each(SIZES)(
    'set up from an old transaction, it starts from the next one after today: nothing missed is due (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([]);
      await repeatRentFrom(server, '2026-08-15', 'Monthly', size);
      await waitFor(() =>
        expect(server.recurring).toEqual([
          expect.objectContaining({
            schedule: 'monthly',
            day: 15,
            startDate: '2026-08-15',
            nextDue: '2026-11-15',
          }),
        ]),
      );
      await reloadApp(server, '/', { size });
      // RM 3,000 less the RM 1,200 paid in August, less RM 500 owed, less Rent on the 15th
      await waitFor(() => expect(expected()).toBe(total('RM 100.00')));
      expect(screen.queryByText(/Due: Rent/)).toBeNull();
      // Nothing was recorded for the months since
      expect(server.transactions.map((t) => t.date)).toEqual(['2026-08-15']);
    },
    20_000,
  );

  test.each(SIZES)(
    'shows the first due date after today at once, before the server has it (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([]);
      const held = holdNext(server, 'POST', '/api/changes');
      onTestFinished(() => held.release());
      const user = await repeatRentFrom(server, '2026-08-15', 'Monthly', size);
      await user.click(await screen.findByRole('button', { name: /^Home$/ }));
      // RM 3,000 less the RM 1,200 paid in August, less RM 500 owed, less Rent on the 15th
      await waitFor(() => expect(expected()).toBe(total('RM 100.00')));
      expect(screen.queryByText(/Due: Rent/)).toBeNull();
      held.release();
      await waitFor(() => expect(nextDueOn(server, 'Rent')).toBe('2026-11-15'));
      expect(screen.queryByText(/Due: Rent/)).toBeNull();
    },
    20_000,
  );

  test.each(SIZES)(
    'set up weekly from an old transaction, it starts from the next of its weekday after today (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([]);
      // Wednesday 7 October; the next Wednesday after Friday the 6th is the 11th
      await repeatRentFrom(server, '2026-10-07', 'Weekly', size);
      await waitFor(() =>
        expect(server.recurring).toEqual([
          expect.objectContaining({
            schedule: 'weekly',
            day: 3,
            startDate: '2026-10-07',
            nextDue: '2026-11-11',
          }),
        ]),
      );
      await reloadApp(server, '/', { size });
      await screen.findByRole('button', { name: /^Expected at month end/ });
      expect(screen.queryByText(/Due: Rent/)).toBeNull();
    },
    20_000,
  );

  test.each(SIZES)(
    'set up from an old transaction on the day of the month it is today, it starts next month (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([]);
      // The 6th, as today is: today's isn't due, the first is 6 December
      await repeatRentFrom(server, '2026-10-06', 'Monthly', size);
      await waitFor(() =>
        expect(server.recurring).toEqual([
          expect.objectContaining({
            schedule: 'monthly',
            day: 6,
            startDate: '2026-10-06',
            nextDue: '2026-12-06',
          }),
        ]),
      );
      await reloadApp(server, '/', { size });
      // RM 3,000 less the RM 1,200 paid in October, less RM 500 owed: nothing more this month
      await waitFor(() => expect(expected()).toBe(total('RM 1,300.00')));
      expect(screen.queryByText(/Due: Rent/)).toBeNull();
    },
    20_000,
  );

  test.each(SIZES)(
    'one set up before still asks about each occurrence it missed (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([
        repeating('Rent', {
          amountCents: 120_000,
          day: 15,
          startDate: '2026-08-15',
          nextDue: '2026-09-15',
        }),
      ]);
      renderApp(server, '/', { size });
      const user = userEvent.setup();
      let row = await dueRow('Due: Rent RM 1,200.00 from Maybank');
      await user.click(row.getByRole('button', { name: 'Log it' }));
      await waitFor(() => expect(nextDueOn(server, 'Rent')).toBe('2026-10-15'));
      row = await dueRow('Due: Rent RM 1,200.00 from Maybank');
      await user.click(row.getByRole('button', { name: 'Skip' }));
      await waitFor(() => expect(nextDueOn(server, 'Rent')).toBe('2026-11-15'));
      // 15 November isn't due yet
      await waitFor(() => expect(screen.queryByText(/Due: Rent/)).toBeNull());
      expect(server.transactions.map((t) => t.date)).toEqual(['2026-09-15']);
    },
    20_000,
  );

  /** The person is in `zone` for this test; set before its clock is built */
  function inZone(zone: string) {
    const before = process.env.TZ;
    process.env.TZ = zone;
    onTestFinished(() => {
      process.env.TZ = before;
    });
  }

  test.each(SIZES)(
    "counts after the person's own day, not UTC's: past midnight in Kuala Lumpur (%s)",
    async (size) => {
      inZone('Asia/Kuala_Lumpur');
      // Saturday 7 November, 1 a.m. there; still the 6th in UTC
      clockAt(new Date(2026, 10, 7, 1, 0, 0));
      const server = withAccounts([]);
      await repeatRentFrom(server, '2026-10-07', 'Monthly', size);
      // After the 7th: 7 December (after UTC's 6th it would be 7 November)
      await waitFor(() =>
        expect(server.recurring).toEqual([
          expect.objectContaining({ day: 7, startDate: '2026-10-07', nextDue: '2026-12-07' }),
        ]),
      );
    },
    20_000,
  );

  test.each(SIZES)(
    "counts after the person's own day, not UTC's: an evening in Los Angeles (%s)",
    async (size) => {
      inZone('America/Los_Angeles');
      // Friday 6 November, 8 p.m. there; already the 7th in UTC
      clockAt(new Date(2026, 10, 6, 20, 0, 0));
      const server = withAccounts([]);
      await repeatRentFrom(server, '2026-10-07', 'Monthly', size);
      // After the 6th: 7 November (after UTC's 7th it would be 7 December)
      await waitFor(() =>
        expect(server.recurring).toEqual([
          expect.objectContaining({ day: 7, startDate: '2026-10-07', nextDue: '2026-11-07' }),
        ]),
      );
    },
    20_000,
  );

  test.each(SIZES)(
    'set up offline, it keeps the first due date it had when set up, saved once back (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts([]);
      server.transactions.push({
        id: 'a'.repeat(16),
        kind: 'expense',
        accountId: BANK,
        toAccountId: null,
        amountCents: 120_000,
        categoryId: BILLS,
        payee: 'Rent',
        note: null,
        date: '2026-08-15',
        createdAt: 1,
      });
      renderApp(server, `/?account=${BANK}`, { size });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Bills, Rent, −RM 1,200.00' }));
      const sheet = within(await screen.findByRole('dialog', { name: 'Edit transaction' }));
      if (sheet.getByRole('button', { name: 'More' }).getAttribute('aria-expanded') !== 'true') {
        await user.click(sheet.getByRole('button', { name: 'More' }));
      }
      const backOnline = goOffline(server);
      await user.selectOptions(sheet.getByLabelText('Repeat'), 'Monthly');
      await user.click(sheet.getByRole('button', { name: 'Save' }));
      await pause(100);
      expect(server.recurring).toEqual([]);
      // Back online on the 20th: the 15th it was set up with has passed, and is due
      vi.setSystemTime(new Date(2026, 10, 20, 10, 0, 0));
      backOnline();
      await waitFor(() => expect(nextDueOn(server, 'Rent')).toBe('2026-11-15'), { timeout: 8000 });
      expect(server.recurring).toEqual([
        expect.objectContaining({ day: 15, startDate: '2026-08-15', nextDue: '2026-11-15' }),
      ]);
    },
    20_000,
  );

  test.each(SIZES)('sets one up while adding a transaction too (%s)', async (size) => {
    onTheSixth();
    const server = withAccounts([]);
    renderApp(server, '/', { size });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Add transaction' }));
    await waitFor(() => expect(document.activeElement).toBe(sheet.getByLabelText('Amount')));
    await user.keyboard('80');
    await user.selectOptions(sheet.getByLabelText('Account'), 'Maybank');
    if (sheet.getByRole('button', { name: 'More' }).getAttribute('aria-expanded') !== 'true') {
      await user.click(sheet.getByRole('button', { name: 'More' }));
    }
    await user.type(sheet.getByLabelText('Paid to'), 'Phone');
    await user.selectOptions(sheet.getByLabelText('Repeat'), 'Monthly');
    await user.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    expect(server.transactions[0]).toMatchObject({
      amountCents: 8_000,
      date: TODAY,
      payee: 'Phone',
    });
    await waitFor(() =>
      expect(server.recurring).toEqual([
        expect.objectContaining({
          kind: 'expense',
          accountId: BANK,
          amountCents: 8_000,
          payee: 'Phone',
          schedule: 'monthly',
          day: 6,
          startDate: TODAY,
          nextDue: '2026-12-06',
        }),
      ]),
    );
  });
});
