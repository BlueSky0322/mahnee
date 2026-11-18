// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Recurring, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';

// Scheduled on Home (R-Desk-Home; digest 3.1, 4.6; owner decisions D8, D13 and D19). Entries
// are added on their day by the server, so what needs the person is what's left to check:
// each entry added this month whose amount changes is listed first in a computer's Coming
// up, "amount to check", and opens that day in Activity to confirm it. A phone's Home has no
// Coming up (R-Home; owner, 2026-11-18): there the entries to check are in Activity. An item whose amount changes says
// so on its next date, as it will be added for the person to check; every entry to check is
// listed, and the next three items however many more there are. What Scheduled added in
// the person's month is named under the list ("Added this month: ..."). Log it and Skip are
// only for items that ask first (overdue when the change shipped, or when they were saved);
// every other item is left for the server to add. Essentials keeps the amounts to check. Every
// figure and name here is this file's own.

// Where the person is: Malaysia, eight hours ahead of UTC. The clock reads 00:30 on Tuesday
// 10 November there, still the 9th in UTC.
const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'Asia/Kuala_Lumpur';
afterAll(() => {
  process.env.TZ = TZ_BEFORE;
});

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
/** Coming up is on a computer's Home only */
const COMING_UP_SIZES = ['desktop'] as const;
const BANK = 'b'.repeat(16);
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [BILLS, FUN] = [id('Bills'), id('Fun')];

function tenthJustAfterMidnight() {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 0, 30, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

let made = 0;
const scheduled = (payee: string, more: Partial<Recurring>): Recurring => ({
  id: (++made).toString(16).padStart(16, '9'),
  kind: 'expense',
  accountId: BANK,
  toAccountId: null,
  amountCents: 1_000,
  categoryId: BILLS,
  payee,
  schedule: 'monthly',
  day: 1,
  startDate: '2026-10-01',
  nextDue: '2026-12-01',
  archived: false,
  amountVaries: false,
  askFirst: false,
  ...more,
});

const RENT = scheduled('Rent', { amountCents: 135_000, day: 1, nextDue: '2026-12-01' });
const STREAMING = scheduled('Streaming', {
  categoryId: FUN,
  amountCents: 3_990,
  day: 3,
  nextDue: '2026-12-03',
});
const WATER = scheduled('Water', {
  amountCents: 3_015,
  day: 5,
  nextDue: '2026-12-05',
  amountVaries: true,
});
const POWER = scheduled('Power', {
  amountCents: 21_040,
  day: 20,
  nextDue: '2026-11-20',
  amountVaries: true,
});

let seeded = 0;
function added(server: FakeServer, r: Recurring, date: string, toCheck = false) {
  seeded++;
  const t: Transaction = {
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
    scheduled: { recurringId: r.id, due: date, toCheck },
  };
  server.transactions.push(t);
  return t;
}

/**
 * Maybank with RM 5,000; Rent (Nov 1), Streaming (Nov 3) and Water (Nov 5, its amount to
 * check) added from Scheduled this month; Power, whose amount changes, next on Nov 20
 */
function withScheduled(recurring: Recurring[] = [RENT, STREAMING, WATER, POWER]) {
  const server = fakeServer();
  server.accounts.push({
    id: BANK,
    name: 'Maybank',
    kind: 'bank',
    currency: 'MYR',
    openingCents: 500_000,
    position: 0,
    archived: false,
  });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  server.recurring = recurring.map((r) => ({ ...r }));
  if (recurring.includes(RENT)) added(server, RENT, '2026-11-01');
  if (recurring.includes(STREAMING)) added(server, STREAMING, '2026-11-03');
  if (recurring.includes(WATER)) added(server, WATER, '2026-11-05', true);
  return server;
}

/** The text a person sees in `el`, its parts joined by spaces */
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

const comingUp = () => screen.findByRole('region', { name: 'Coming up' }, { timeout: 3000 });
const comingRows = (region: HTMLElement) => within(region).getAllByRole('listitem').map(seen);

describe('what Scheduled added, on Home', () => {
  test("a phone's Home lists none of it, as drawn", async () => {
    tenthJustAfterMidnight();
    renderApp(withScheduled(), '/', { size: 'phone' });
    expect(
      await screen.findByRole('region', { name: 'Day by day' }, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Coming up' })).toBeNull();
    expect(screen.queryByText(/amount to check/)).toBeNull();
    expect(screen.queryByText(/Added this month/)).toBeNull();
  });

  test.each(COMING_UP_SIZES)(
    'lists each entry still to check first, then what is coming, and names what was added (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(withScheduled(), '/', { size });
      const coming = await comingUp();
      await waitFor(() =>
        expect(comingRows(coming)).toEqual([
          'Water · RM 30.15 Nov 5 · amount to check',
          'Power · RM 210.40 Nov 20 · amount to check',
          'Rent · RM 1,350.00 Dec 1 · Maybank',
          'Streaming · RM 39.90 Dec 3 · Maybank',
        ]),
      );
      // The entry to check opens its day in Activity, where it's confirmed
      expect(
        within(coming)
          .getByRole('link', { name: /^Water/ })
          .getAttribute('href'),
      ).toBe('?activity&day=2026-11-05');
      expect(within(coming).getByText('Added this month: Rent, Streaming, Water')).toBeTruthy();
    },
  );

  test.each(COMING_UP_SIZES)(
    'says nothing of what was added while nothing was (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(withScheduled([POWER]), '/', { size });
      const coming = await comingUp();
      await waitFor(() =>
        expect(comingRows(coming)).toEqual(['Power · RM 210.40 Nov 20 · amount to check']),
      );
      expect(within(coming).queryByText(/Added this month/)).toBeNull();
    },
  );

  test.each(COMING_UP_SIZES)(
    'an entry confirmed elsewhere leaves the list at once, though still added (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      const server = withScheduled();
      renderApp(server, '/?activity&day=2026-11-05', { size });
      const user = userEvent.setup();
      // A computer's register names the payee
      await user.click(await screen.findByRole('button', { name: 'Water' }, { timeout: 3000 }));
      const form = within(await screen.findByRole('complementary', { name: /^Water, Nov 5/ }));
      await user.click(form.getByRole('button', { name: 'Save' }));
      await user.click(screen.getAllByRole('link', { name: 'Home' })[0]);
      const coming = await comingUp();
      await waitFor(() =>
        expect(comingRows(coming)[0]).toBe('Power · RM 210.40 Nov 20 · amount to check'),
      );
      expect(within(coming).getByText('Added this month: Rent, Streaming, Water')).toBeTruthy();
    },
  );

  test.each(COMING_UP_SIZES)(
    'Essentials keeps the amounts to check and the next item (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      const server = withScheduled();
      server.me.settings = { ...server.me.settings, homeDensity: 'essentials' };
      renderApp(server, '/', { size });
      const coming = await comingUp();
      await waitFor(() =>
        expect(comingRows(coming)).toEqual([
          'Water · RM 30.15 Nov 5 · amount to check',
          'Power · RM 210.40 Nov 20 · amount to check',
        ]),
      );
    },
  );
});

describe('how much Home lists', () => {
  test.each(COMING_UP_SIZES)(
    'every entry still to check, and the next three items, however many more there are (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      const gas = scheduled('Gas', {
        amountCents: 4_444,
        day: 6,
        nextDue: '2026-12-06',
        amountVaries: true,
      });
      const server = withScheduled([
        RENT,
        STREAMING,
        WATER,
        POWER,
        gas,
        scheduled('Gym', { amountCents: 1_500, day: 22, nextDue: '2026-11-22' }),
        scheduled('Loan', { amountCents: 50_000, day: 28, nextDue: '2026-11-28' }),
      ]);
      added(server, gas, '2026-11-06', true);
      renderApp(server, '/', { size });
      const coming = await comingUp();
      await waitFor(() =>
        expect(comingRows(coming)).toEqual([
          'Water · RM 30.15 Nov 5 · amount to check',
          'Gas · RM 44.44 Nov 6 · amount to check',
          'Power · RM 210.40 Nov 20 · amount to check',
          'Gym · RM 15.00 Nov 22 · Maybank',
          'Loan · RM 500.00 Nov 28 · Maybank',
        ]),
      );
    },
  );

  test.each(COMING_UP_SIZES)(
    "names what was added in the person's month: from the 25th, October 25 to November 24 (%s)",
    async (size) => {
      tenthJustAfterMidnight();
      const server = withScheduled([POWER]);
      server.me.settings = { ...server.me.settings, monthStartDay: 25 };
      const early = scheduled('Early', { day: 24, nextDue: '2026-11-24' });
      const late = scheduled('Late', { day: 26, nextDue: '2026-11-26' });
      server.recurring.push(early, late);
      added(server, early, '2026-10-24');
      added(server, late, '2026-10-26');
      renderApp(server, '/', { size });
      const coming = await comingUp();
      expect(await within(coming).findByText('Added this month: Late')).toBeTruthy();
    },
  );
});

describe('Log it and Skip are for the items that ask first (D19)', () => {
  test.each(SIZES)(
    'an overdue item that asks first is asked about; one that does not is left to Scheduled (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      const server = withScheduled([
        scheduled('Insurance', {
          amountCents: 9_900,
          day: 1,
          nextDue: '2026-11-01',
          askFirst: true,
        }),
        // Due last night and not added yet: the server adds it, nothing to ask
        scheduled('Phone', { amountCents: 6_000, day: 9, nextDue: '2026-11-09' }),
      ]);
      renderApp(server, '/', { size });
      const due = await screen.findByRole('group', {
        name: 'Due: Insurance RM 99.00 from Maybank',
      });
      expect(within(due).getByRole('button', { name: 'Log it' })).toBeTruthy();
      expect(within(due).getByRole('button', { name: 'Skip' })).toBeTruthy();
      expect(screen.queryByText(/^Due: Phone/)).toBeNull();
    },
  );
});
