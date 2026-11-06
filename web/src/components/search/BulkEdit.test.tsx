// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { ChangesBody, LedgerChange, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, holdNext, renderApp, setupAppTests } from '../../testing/app';
import { queryClient } from '../../query-client';
import { monthHeading, thisMonth } from '../../utils/date-input';

// Changing many transactions at once from Search: select several (Select, or a long press
// on a phone), then move them to another category or delete them. A preview says exactly
// what will change, it's applied as one change, and Undo puts every one back. Up to 500
// at once; more is refused with a message.

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const WALLET = 'a'.repeat(16);
const NOW = thisMonth();
const categoryId = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [OTHER, FOOD, TRANSPORT] = ['Other', 'Food', 'Transport'].map(categoryId);

let seeded = 0;
/** A transaction the server has before the app opens: spending on the 1st of this month */
function seed(server: FakeServer, t: Partial<Transaction>) {
  seeded++;
  server.transactions.push({
    id: seeded.toString(16).padStart(16, 'd'),
    kind: 'expense',
    accountId: WALLET,
    toAccountId: null,
    amountCents: 100,
    categoryId: OTHER,
    payee: null,
    note: null,
    date: `${NOW}-01`,
    createdAt: seeded,
    ...t,
  });
}

/**
 * A Wallet opened with RM 100, and this month: RM 1, 2 and 3 in Other ("first other",
 * "second other", "third other"), RM 4 on Transport ("bus fare") and RM 10 on Food
 * ("lunch"). Its balance is RM 80.00; RM 20.00 spent.
 */
function withSpending() {
  const server = fakeServer();
  server.accounts.push({
    id: WALLET,
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 10_000,
    position: 0,
    archived: false,
  });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  seed(server, { amountCents: 100, note: 'first other' });
  seed(server, { amountCents: 200, note: 'second other' });
  seed(server, { amountCents: 300, note: 'third other' });
  seed(server, { amountCents: 400, categoryId: TRANSPORT, note: 'bus fare' });
  seed(server, { amountCents: 1_000, categoryId: FOOD, note: 'lunch' });
  return server;
}

const byNote = (server: FakeServer, note: string) =>
  server.transactions.find((t) => t.note === note)!;

/** Opens Search on its own address and waits for what it finds */
async function openSearch(server: FakeServer, size: (typeof SIZES)[number] = 'desktop') {
  renderApp(server, '/?search', { size });
  // Select is offered once there's something found to select
  await screen.findByRole('button', { name: 'Select' });
  await screen.findByRole('button', { name: /first other/ });
  return userEvent.setup();
}

/** A found transaction's tick box, once selecting */
const tick = (note: string) => screen.getByRole('checkbox', { name: new RegExp(note) });

/** Every change each save carried, in order */
const sentChanges = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST')
    .flatMap(([, init]) => (JSON.parse(init!.body as string) as ChangesBody).changes);

type Bulk = Extract<LedgerChange, { op: 'recategoriseTransactions' | 'removeTransactions' }>;
/** A change, with its ids in a set order, to compare */
const sorted = (c: LedgerChange) => ('ids' in c ? { ...c, ids: [...c.ids].sort() } : c);

/** The Wallet's balance on Home, as shown ("RM 80.00"), or null while it isn't */
function walletBalance() {
  const row = screen.queryByRole('button', { name: /^Wallet,/ });
  return row?.getAttribute('aria-label')?.split(', ').at(-1) ?? null;
}

/** A figure on this month's card, as shown ("RM 20.00"), or null while it isn't */
function monthFigure(label: string) {
  const card = screen.queryByRole('region', { name: monthHeading(NOW) });
  if (card == null) return null;
  return within(card).queryByLabelText(label)?.textContent ?? null;
}

describe('moving several to another category', () => {
  test.each(SIZES)(
    'Select, tick three, preview, one change, and Undo puts every one back (%s)',
    async (size) => {
      const server = withSpending();
      const user = await openSearch(server, size);

      await user.click(screen.getByRole('button', { name: 'Select' }));
      await user.click(tick('first other'));
      await user.click(tick('second other'));
      await user.click(tick('third other'));
      expect(screen.getByText('3 selected')).toBeTruthy();
      expect(tick('bus fare')).toHaveProperty('checked', false);

      await user.click(screen.getByRole('button', { name: 'Change category' }));
      const preview = within(await screen.findByRole('dialog'));
      await user.selectOptions(preview.getByLabelText('Category'), 'Food');
      expect(preview.getByText('Move 3 transactions from Other to Food')).toBeTruthy();
      await user.click(preview.getByRole('button', { name: 'Move' }));

      // Shown in Food at once
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /first other/ }).textContent).toMatch(/Food/),
      );
      await waitFor(() =>
        expect(
          ['first other', 'second other', 'third other'].map((n) => byNote(server, n).categoryId),
        ).toEqual([FOOD, FOOD, FOOD]),
      );
      const ids = ['first other', 'second other', 'third other']
        .map((n) => byNote(server, n).id)
        .sort();
      expect(sentChanges().map(sorted)).toEqual([
        { op: 'recategoriseTransactions', ids, categoryId: FOOD },
      ]);
      expect(byNote(server, 'bus fare').categoryId).toBe(TRANSPORT);

      expect(await screen.findByText('Moved 3 transactions to Food')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(() =>
        expect(
          ['first other', 'second other', 'third other'].map((n) => byNote(server, n).categoryId),
        ).toEqual([OTHER, OTHER, OTHER]),
      );
      expect(sentChanges().map(sorted)).toEqual([
        { op: 'recategoriseTransactions', ids, categoryId: FOOD },
        { op: 'recategoriseTransactions', ids, categoryId: OTHER },
      ]);
    },
  );

  test('from several categories, says so, and Undo puts each back in its own', async () => {
    const server = withSpending();
    const user = await openSearch(server);
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(tick('first other'));
    await user.click(tick('bus fare'));
    await user.click(screen.getByRole('button', { name: 'Change category' }));
    const preview = within(await screen.findByRole('dialog'));
    await user.selectOptions(preview.getByLabelText('Category'), 'Food');
    expect(preview.getByText('Move 2 transactions from 2 categories to Food')).toBeTruthy();
    await user.click(preview.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(byNote(server, 'bus fare').categoryId).toBe(FOOD));

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(byNote(server, 'bus fare').categoryId).toBe(TRANSPORT));
    expect(byNote(server, 'first other').categoryId).toBe(OTHER);
    const [first, bus] = [byNote(server, 'first other').id, byNote(server, 'bus fare').id];
    // One change per category they came from
    expect(sentChanges().slice(1).map(sorted)).toEqual(
      expect.arrayContaining([
        { op: 'recategoriseTransactions', ids: [first], categoryId: OTHER },
        { op: 'recategoriseTransactions', ids: [bus], categoryId: TRANSPORT },
      ]),
    );
    expect(sentChanges()).toHaveLength(3);
  });
});

describe('deleting several', () => {
  test.each(SIZES)(
    'previews, deletes in one change, and Undo adds each again as it was (%s)',
    async (size) => {
      const server = withSpending();
      const user = await openSearch(server, size);
      const before = [byNote(server, 'first other'), byNote(server, 'bus fare')].map((t) => ({
        ...t,
      }));

      await user.click(screen.getByRole('button', { name: 'Select' }));
      await user.click(tick('first other'));
      await user.click(tick('bus fare'));
      expect(screen.getByText('2 selected')).toBeTruthy();
      // Held, to see they're gone before the server answers
      const answer = holdNext(server, 'POST', '/api/changes');
      await user.click(screen.getByRole('button', { name: 'Delete' }));
      const preview = within(await screen.findByRole('dialog'));
      expect(preview.getByText('Delete 2 transactions')).toBeTruthy();
      await user.click(preview.getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(screen.queryByRole('button', { name: /bus fare/ })).toBeNull());
      expect(screen.queryByRole('button', { name: /first other/ })).toBeNull();
      expect(screen.getByRole('button', { name: /second other/ })).toBeTruthy();
      answer.release();
      await waitFor(() => expect(server.transactions).toHaveLength(3));
      expect(sentChanges().map(sorted)).toEqual([
        { op: 'removeTransactions', ids: before.map((t) => t.id).sort() },
      ]);

      expect(await screen.findByText('Deleted 2 transactions')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(server.transactions).toHaveLength(5));
      // Each again with its own id, as it was
      for (const t of before) {
        const { createdAt: _at, ...rest } = t;
        expect(server.transactions.find((x) => x.id === t.id)).toMatchObject(rest);
      }
      expect(await screen.findByRole('button', { name: /bus fare/ })).toBeTruthy();
    },
  );

  test.each(SIZES)(
    'moves the balance and the month at once, and counts them once when the answer is lost (%s)',
    async (size) => {
      const server = withSpending();
      const user = await openSearch(server, size);
      await user.click(screen.getByRole('button', { name: 'Select' }));
      await user.click(tick('first other'));
      await user.click(tick('bus fare'));
      // Saved, but the answer never reaches the app: it's sent again later
      server.loseNext.changes = true;
      await user.click(screen.getByRole('button', { name: 'Delete' }));
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
      );
      await waitFor(() => expect(server.transactions).toHaveLength(3));
      const resend = holdNext(server, 'POST', '/api/changes');

      await user.click(screen.getByRole('button', { name: 'Home' }));
      // RM 80 + RM 5 back, RM 20 - RM 5 spent: counted once, though the server has it
      await waitFor(() => expect(walletBalance()).toBe('RM 85.00'));
      await waitFor(() => expect(monthFigure('Spent')).toBe('RM 15.00'));
      await act(() => queryClient.refetchQueries({ type: 'active' }));
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(walletBalance()).toBe('RM 85.00');
      expect(monthFigure('Spent')).toBe('RM 15.00');

      resend.release();
      await act(() => new Promise((r) => setTimeout(r, 50)));
      await waitFor(() => expect(sentChanges()).toHaveLength(2), { timeout: 8000 });
      await act(() => new Promise((r) => setTimeout(r, 100)));
      expect(server.transactions).toHaveLength(3);
      expect(walletBalance()).toBe('RM 85.00');
      expect(monthFigure('Spent')).toBe('RM 15.00');
    },
  );
});

describe('selecting', () => {
  test('says "1 transaction" for one alone, moving and deleting', async () => {
    const server = withSpending();
    const user = await openSearch(server);
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(tick('first other'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Change category' }));
    let preview = within(await screen.findByRole('dialog'));
    await user.selectOptions(preview.getByLabelText('Category'), 'Food');
    expect(preview.getByText('Move 1 transaction from Other to Food')).toBeTruthy();
    await user.click(preview.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('Moved 1 transaction to Food')).toBeTruthy();
    await waitFor(() => expect(byNote(server, 'first other').categoryId).toBe(FOOD));

    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(tick('bus fare'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    preview = within(await screen.findByRole('dialog'));
    expect(preview.getByText('Delete 1 transaction')).toBeTruthy();
    await user.click(preview.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Deleted 1 transaction')).toBeTruthy();
    await waitFor(() => expect(server.transactions).toHaveLength(4));
  });

  test('a long press on a phone starts selecting with that one ticked; a tap still opens it', async () => {
    const server = withSpending();
    const user = await openSearch(server, 'phone');

    // A tap opens it to change, as anywhere else
    await user.click(screen.getByRole('button', { name: /lunch/ }));
    expect(await screen.findByRole('dialog', { name: 'Edit transaction' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const row = screen.getByRole('button', { name: /second other/ });
    fireEvent.pointerDown(row);
    await act(() => new Promise((r) => setTimeout(r, 800)));
    fireEvent.pointerUp(row);
    expect(await screen.findByText('1 selected')).toBeTruthy();
    expect(tick('second other')).toHaveProperty('checked', true);
    expect(tick('lunch')).toHaveProperty('checked', false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('up to 500 at once: 501 is refused with a message, 500 is deleted in one change', async () => {
    const server = withSpending();
    // Earlier than the rest, so the first page shows the five above
    for (let i = 0; i < 496; i++) {
      seed(server, { amountCents: 1, note: `bulk ${i}`, date: '2025-01-01' });
    }
    // 3 in Other, 1 on Transport, 1 on Food and 496 more in Other: 501 in all
    const user = await openSearch(server);
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(await screen.findByText('501 selected', undefined, { timeout: 15_000 })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Change category' }));
    expect(await screen.findByText('You can change up to 500 transactions at once')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sentChanges()).toEqual([]);
    expect(server.transactions).toHaveLength(501);

    await user.click(tick('lunch'));
    expect(screen.getByText('500 selected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const preview = within(await screen.findByRole('dialog'));
    expect(preview.getByText('Delete 500 transactions')).toBeTruthy();
    await user.click(preview.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(server.transactions.map((t) => t.note)).toEqual(['lunch']), {
      timeout: 8000,
    });
    const sent = sentChanges();
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe('removeTransactions');
    expect((sent[0] as Bulk).ids).toHaveLength(500);
  }, 60_000);
});
