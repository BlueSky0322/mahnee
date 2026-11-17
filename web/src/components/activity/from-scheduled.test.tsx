// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Recurring, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';

// Entries added from Scheduled (owner decision D8; R-Account "Bills · from Scheduled";
// digest 4.6): they say so where entries are listed, in Activity and on an account's page,
// and one whose amount changes says "amount to check" until the person confirms it. Opening
// it says what was added, with the amount ready to type; saving it, as it is or with the
// amount the bill came to, confirms it, and a new amount on the item's latest entry becomes
// the item's amount for next time ("last time"); an older entry's leaves the item as it is.
// Activity can show only what Scheduled added (?activity&scheduled, Plan's "See them"). An
// entry deleted and brought back with Undo is still from Scheduled. Every figure and name is this file's.

// Where the person is: Malaysia. The clock reads 00:30 on Tuesday 10 November there.
const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'Asia/Kuala_Lumpur';
afterAll(() => {
  process.env.TZ = TZ_BEFORE;
});

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const BANK = 'b'.repeat(16);
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [BILLS, FOOD] = [id('Bills'), id('Food')];

function tenthJustAfterMidnight() {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 0, 30, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

const item = (itemId: string, payee: string, more: Partial<Recurring>): Recurring => ({
  id: itemId,
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
const RENT = item('9'.repeat(16), 'Rent', { amountCents: 135_000, day: 1, nextDue: '2026-12-01' });
const WATER = item('8'.repeat(16), 'Water', {
  amountCents: 3_015,
  day: 5,
  nextDue: '2026-12-05',
  amountVaries: true,
});

let seeded = 0;
function entry(server: FakeServer, more: Partial<Transaction>) {
  seeded++;
  const t: Transaction = {
    id: seeded.toString(16).padStart(16, '0'),
    kind: 'expense',
    accountId: BANK,
    toAccountId: null,
    amountCents: 900,
    categoryId: FOOD,
    payee: 'Kiosk',
    note: null,
    date: '2026-11-07',
    createdAt: seeded,
    ...more,
  };
  server.transactions.push(t);
  return t;
}

/** Maybank with Rent added on the 1st, Water on the 5th (to check), and a kiosk on the 7th */
function withAdded() {
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
  server.recurring = [{ ...RENT }, { ...WATER }];
  const rent = entry(server, {
    payee: 'Rent',
    categoryId: BILLS,
    amountCents: 135_000,
    date: '2026-11-01',
    scheduled: { recurringId: RENT.id, due: '2026-11-01', toCheck: false },
  });
  const water = entry(server, {
    payee: 'Water',
    categoryId: BILLS,
    amountCents: 3_015,
    date: '2026-11-05',
    scheduled: { recurringId: WATER.id, due: '2026-11-05', toCheck: true },
  });
  entry(server, {});
  return { server, rent, water };
}

/** Activity's rows on a phone, by their names */
const listRows = () =>
  within(screen.getByRole('region', { name: 'Results' }))
    .queryAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? '')
    .filter((name) => name.includes(', '));

/** A computer's register, each row's cells after the tick box */
const registerRows = () =>
  within(screen.getByRole('table', { name: 'Transactions' }))
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .slice(1)
        .map((cell) => cell.textContent?.trim()),
    );

describe('where entries are listed', () => {
  test('Activity on a phone says which came from Scheduled, and which is to check', async () => {
    tenthJustAfterMidnight();
    renderApp(withAdded().server, '/?activity', { size: 'phone' });
    await waitFor(() =>
      expect(listRows()).toEqual([
        'Kiosk, Food · Maybank, −9.00',
        'Water, Bills · Maybank · amount to check, −30.15',
        'Rent, Bills · Maybank · from Scheduled, −1,350.00',
      ]),
    );
  });

  test('Activity on a computer says it beside the category', async () => {
    tenthJustAfterMidnight();
    renderApp(withAdded().server, '/?activity', { size: 'desktop' });
    await waitFor(() =>
      expect(registerRows()).toEqual([
        ['Nov 7', 'Kiosk', 'Food', 'Maybank', '−9.00'],
        ['Nov 5', 'Water', 'Bills · amount to check', 'Maybank', '−30.15'],
        ['Nov 1', 'Rent', 'Bills · from Scheduled', 'Maybank', '−1,350.00'],
      ]),
    );
  });

  test("an account's own page says it under the category, as drawn", async () => {
    tenthJustAfterMidnight();
    renderApp(withAdded().server, `/?account=${BANK}`, { size: 'phone' });
    expect(
      await screen.findByRole('button', { name: 'Rent, Bills · from Scheduled, −1,350.00' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Water, Bills · amount to check, −30.15' }),
    ).toBeTruthy();
  });

  test.each(SIZES)(
    'Activity shows only what Scheduled added, until the chip is taken off (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(withAdded().server, '/?activity&scheduled', { size });
      const user = userEvent.setup();
      const filters = within(await screen.findByRole('group', { name: 'Filters' }));
      const chip = filters.getByRole('button', { name: 'From Scheduled' });
      expect(chip.getAttribute('aria-pressed')).toBe('true');
      await waitFor(() =>
        expect(size === 'phone' ? listRows() : registerRows().map((cells) => cells[1])).toEqual(
          size === 'phone'
            ? [
                'Water, Bills · Maybank · amount to check, −30.15',
                'Rent, Bills · Maybank · from Scheduled, −1,350.00',
              ]
            : ['Water', 'Rent'],
        ),
      );
      await user.click(chip);
      await waitFor(() => expect(window.location.search).toBe('?activity'));
      await waitFor(() => expect(size === 'phone' ? listRows() : registerRows()).toHaveLength(3));
    },
  );
});

describe('confirming an amount to check', () => {
  /** Opens Water: its sheet on a phone, its pane on a computer */
  async function openWater(size: (typeof SIZES)[number]) {
    const user = userEvent.setup();
    if (size === 'phone') {
      await user.click(await screen.findByRole('button', { name: /^Water, / }, { timeout: 3000 }));
      return { user, form: within(await screen.findByRole('dialog', { name: 'Water' })) };
    }
    await user.click(await screen.findByRole('button', { name: 'Water' }, { timeout: 3000 }));
    return {
      user,
      form: within(await screen.findByRole('complementary', { name: /^Water, Nov 5/ })),
    };
  }

  test.each(SIZES)('says what was added, and saving it as it is confirms it (%s)', async (size) => {
    tenthJustAfterMidnight();
    const { server, water } = withAdded();
    renderApp(server, '/?activity', { size });
    const { user, form } = await openWater(size);
    expect(form.getByText('Added at RM 30.15 from Scheduled, for you to check')).toBeTruthy();
    // Opened to check the amount, the amount is ready to type in
    await waitFor(() =>
      expect(document.activeElement).toBe(form.getByRole('textbox', { name: 'Amount' })),
    );
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(server.transactions.find((t) => t.id === water.id)?.scheduled).toEqual({
        recurringId: WATER.id,
        due: '2026-11-05',
        toCheck: false,
      }),
    );
    if (size === 'phone') {
      await waitFor(() =>
        expect(listRows()).toContain('Water, Bills · Maybank · from Scheduled, −30.15'),
      );
    } else {
      await waitFor(() =>
        expect(registerRows()[1]).toEqual([
          'Nov 5',
          'Water',
          'Bills · from Scheduled',
          'Maybank',
          '−30.15',
        ]),
      );
    }
    // Nothing else changed: the amount and the item's amount are as they were
    expect(server.transactions.find((t) => t.id === water.id)?.amountCents).toBe(3_015);
    expect(server.recurring.find((r) => r.id === WATER.id)?.amountCents).toBe(3_015);
  });

  test.each(SIZES)(
    'what the bill came to confirms it, and is the amount next time (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      const { server, water } = withAdded();
      renderApp(server, '/?activity', { size });
      const { user, form } = await openWater(size);
      const amount = form.getByRole('textbox', { name: 'Amount' });
      await user.clear(amount);
      await user.type(amount, '31.70');
      await user.click(form.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(server.transactions.find((t) => t.id === water.id)).toMatchObject({
          amountCents: 3_170,
          scheduled: { recurringId: WATER.id, due: '2026-11-05', toCheck: false },
        }),
      );
      await waitFor(() =>
        expect(server.recurring.find((r) => r.id === WATER.id)?.amountCents).toBe(3_170),
      );
    },
  );

  test.each(SIZES)(
    'an older entry confirmed leaves the item at its latest amount (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      const { server, water } = withAdded();
      // November's Water was confirmed at RM 31.70, the item's amount since; October's is
      // still to check
      Object.assign(water, {
        amountCents: 3_170,
        scheduled: { recurringId: WATER.id, due: '2026-11-05', toCheck: false },
      });
      server.recurring.find((r) => r.id === WATER.id)!.amountCents = 3_170;
      const october = entry(server, {
        payee: 'Water',
        categoryId: BILLS,
        amountCents: 3_015,
        date: '2026-10-05',
        scheduled: { recurringId: WATER.id, due: '2026-10-05', toCheck: true },
      });
      renderApp(server, '/?activity&day=2026-10-05', { size });
      const user = userEvent.setup();
      let form;
      if (size === 'phone') {
        await user.click(
          await screen.findByRole('button', { name: /^Water, / }, { timeout: 3000 }),
        );
        form = within(await screen.findByRole('dialog', { name: 'Water' }));
      } else {
        await user.click(await screen.findByRole('button', { name: 'Water' }, { timeout: 3000 }));
        form = within(await screen.findByRole('complementary', { name: /^Water, Oct 5/ }));
      }
      const amount = form.getByRole('textbox', { name: 'Amount' });
      await user.clear(amount);
      await user.type(amount, '30.50');
      await user.click(form.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(server.transactions.find((t) => t.id === october.id)).toMatchObject({
          amountCents: 3_050,
          scheduled: { toCheck: false },
        }),
      );
      expect(server.recurring.find((r) => r.id === WATER.id)?.amountCents).toBe(3_170);
    },
  );

  test.each(SIZES)('an item whose amount stays the same keeps its amount (%s)', async (size) => {
    tenthJustAfterMidnight();
    const { server, rent } = withAdded();
    renderApp(server, '/?activity', { size });
    const user = userEvent.setup();
    if (size === 'phone') {
      await user.click(await screen.findByRole('button', { name: /^Rent, / }, { timeout: 3000 }));
    } else {
      await user.click(await screen.findByRole('button', { name: 'Rent' }, { timeout: 3000 }));
    }
    const form =
      size === 'phone'
        ? within(await screen.findByRole('dialog', { name: 'Rent' }))
        : within(await screen.findByRole('complementary', { name: /^Rent, Nov 1/ }));
    expect(form.queryByText(/for you to check/)).toBeNull();
    const amount = form.getByRole('textbox', { name: 'Amount' });
    await user.clear(amount);
    await user.type(amount, '1400');
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(server.transactions.find((t) => t.id === rent.id)?.amountCents).toBe(140_000),
    );
    expect(server.recurring.find((r) => r.id === RENT.id)?.amountCents).toBe(135_000);
  });
});

describe('deleting one', () => {
  test.each(SIZES)(
    'Undo brings it back still from Scheduled, still to check (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      const { server, water } = withAdded();
      renderApp(server, '/?activity', { size });
      const user = userEvent.setup();
      if (size === 'phone') {
        await user.click(
          await screen.findByRole('button', { name: /^Water, / }, { timeout: 3000 }),
        );
      } else {
        await user.click(await screen.findByRole('button', { name: 'Water' }, { timeout: 3000 }));
      }
      const form =
        size === 'phone'
          ? within(await screen.findByRole('dialog', { name: 'Water' }))
          : within(await screen.findByRole('complementary', { name: /^Water, Nov 5/ }));
      await user.click(form.getByRole('button', { name: 'Delete' }));
      await waitFor(() =>
        expect(server.transactions.find((t) => t.id === water.id)).toBeUndefined(),
      );
      await user.click(await screen.findByRole('button', { name: 'Undo' }));
      await waitFor(() =>
        expect(server.transactions.find((t) => t.id === water.id)?.scheduled).toEqual({
          recurringId: WATER.id,
          due: '2026-11-05',
          toCheck: true,
        }),
      );
    },
  );
});
