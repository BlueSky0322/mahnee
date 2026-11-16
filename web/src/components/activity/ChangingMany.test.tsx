// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { notifications } from '@mantine/notifications';
import { beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { ChangesBody, LedgerChange, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  fakeServer,
  goToPlace,
  holdNext,
  renderApp,
  settle,
  setupAppTests,
} from '../../testing/app';
import { queryClient } from '../../query-client';
import { monthHeading } from '../../utils/date-input';

// Changing many entries at once on Activity (R-Activity-Select, R-Activity-Move,
// R-Desk-Activity, R-Desk-Bulk). On a phone, Select (or a long press) ticks rows, with
// what's ticked summed at the foot; on a computer every row has a tick box. Change
// category opens a list to move them to, saying where they come from, what moves, and
// what it does to that category's budget this month (the budget month Home shows: the
// calendar month until piece 12's start day); Delete takes them out at once. Each is one
// change through the ledger, kept offline, with Undo; up to 500 at once. Every figure and
// name here is this file's own.

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
type Size = (typeof SIZES)[number];
const WALLET = 'a'.repeat(16);
const BANK = 'b'.repeat(16);
const COFFEE = 'e'.repeat(16);
const categoryId = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [OTHER, FOOD, TRANSPORT, GROCERIES, SALARY] = [
  'Other',
  'Food',
  'Transport',
  'Groceries',
  'Salary',
].map(categoryId);

beforeEach(() => {
  // Tuesday 10 November 2026, in the device's own time
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 10, 0, 0));
  return () => vi.useRealTimers();
});

let seeded = 0;
function seed(server: FakeServer, t: Partial<Transaction>) {
  seeded++;
  server.transactions.push({
    // Padded with 0, so every one is its own (padded with d, 13 and 221 would both be d x 16)
    id: seeded.toString(16).padStart(16, '0'),
    kind: 'expense',
    accountId: WALLET,
    toAccountId: null,
    amountCents: 100,
    categoryId: OTHER,
    payee: null,
    note: null,
    date: '2026-11-01',
    createdAt: seeded,
    ...t,
  });
}

/**
 * A Wallet opened with RM 100, Coffee under Food, a Food budget of RM 50 this month, and:
 *   Nov 7 RM 1 Other "Stall" ("first other"); Nov 6 RM 2 Other "Stall" ("second other");
 *   Nov 5 RM 4 Transport ("bus fare"); Nov 4 RM 10 Food ("lunch");
 *   Oct 23 RM 3 Other "Stall" ("third other").
 * Food has RM 40.00 left. The Wallet holds RM 80.00; RM 17.00 spent this month.
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
  server.categories.push({
    id: COFFEE,
    name: 'Coffee',
    kind: 'expense',
    parentId: FOOD,
    position: 0,
    archived: false,
  });
  server.budgets.push({
    categoryId: FOOD,
    fromMonth: '2026-11',
    amountCents: 5_000,
    carryOver: false,
  });
  seed(server, { date: '2026-10-23', amountCents: 300, payee: 'Stall', note: 'third other' });
  seed(server, { date: '2026-11-04', amountCents: 1_000, categoryId: FOOD, note: 'lunch' });
  seed(server, { date: '2026-11-05', amountCents: 400, categoryId: TRANSPORT, note: 'bus fare' });
  seed(server, { date: '2026-11-06', amountCents: 200, payee: 'Stall', note: 'second other' });
  seed(server, { date: '2026-11-07', amountCents: 100, payee: 'Stall', note: 'first other' });
  return server;
}

const byNote = (server: FakeServer, note: string) =>
  server.transactions.find((t) => t.note === note)!;

/**
 * How each row is told apart: on a computer its note is in the register; on a phone a
 * row is its title, subtitle (with its day, while selecting) and amount
 */
const PHONE_NAMES: Record<string, RegExp> = {
  'first other': /^Stall, Other · Wallet · Nov 7, −1\.00$/,
  'second other': /^Stall, Other · Wallet · Nov 6, −2\.00$/,
  'third other': /^Stall, Other · Wallet · Oct 23, −3\.00$/,
  'bus fare': /^bus fare, Transport · Wallet · Nov 5, −4\.00$/,
  'lunch': /^lunch, Food · Wallet · Nov 4, −10\.00$/,
};

/** A row's tick box, if it's shown */
function findTick(note: string) {
  return (
    screen
      .queryAllByRole('checkbox')
      .find((box) =>
        box.closest('tr') != null
          ? (box.closest('tr')?.textContent ?? '').includes(note)
          : (PHONE_NAMES[note] ?? new RegExp(`^${note}, `)).test(
              box.getAttribute('aria-label') ?? '',
            ),
      ) ?? null
  );
}
function tick(note: string) {
  const box = findTick(note);
  if (box == null) throw new Error(`No tick box for ${note}`);
  return box;
}

/** The elements whose whole text is `text` however it's split, the innermost of each */
const lines = (text: string) =>
  screen.queryAllByText(
    (_, el) =>
      el != null &&
      el.textContent === text &&
      ![...el.children].some((child) => child.textContent === text),
  );
const hasLine = (text: string) => expect(lines(text).length).toBeGreaterThan(0);

/** Every change each save carried, in order */
const sentChanges = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST')
    .flatMap(([, init]) => (JSON.parse(init!.body as string) as ChangesBody).changes);
type Bulk = Extract<LedgerChange, { op: 'recategoriseTransactions' | 'removeTransactions' }>;
const sorted = (c: LedgerChange) => ('ids' in c ? { ...c, ids: [...c.ids].sort() } : c);

/** Opens Activity on every month and waits for what it finds; a phone starts selecting */
async function openActivity(server: FakeServer, size: Size, path = '/?activity&dates=all') {
  renderApp(server, path, { size });
  await screen.findByRole('heading', { name: 'Activity', level: 1 });
  // "bus fare" has no payee, so it's the row's title on a phone and in the register
  await screen.findAllByText(/bus fare/);
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  if (size === 'phone') await user.click(screen.getByRole('button', { name: 'Select' }));
  return user;
}

const changeCategory = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Change category' }));

/** Opens Change category and picks `to` in it; answers the sheet */
async function moveTo(user: ReturnType<typeof userEvent.setup>, to: string) {
  await changeCategory(user);
  const sheet = within(await screen.findByRole('dialog'));
  await user.click(
    within(sheet.getByRole('radiogroup', { name: 'Move to' })).getByRole('radio', { name: to }),
  );
  return sheet;
}

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

describe('moving several to another category', () => {
  test.each(SIZES)(
    'tick three, see where they go and what it does to the budget, one change, and Undo (%s)',
    async (size) => {
      const server = withSpending();
      const user = await openActivity(server, size);
      await user.click(tick('first other'));
      await user.click(tick('second other'));
      await user.click(tick('third other'));
      expect(screen.getByText('3 selected')).toBeTruthy();
      expect(tick('bus fare')).toHaveProperty('checked', false);
      expect(screen.getByRole('button', { name: 'Delete 3' })).toBeTruthy();
      if (size === 'phone') hasLine('3 entries · RM 6.00 · all Stall');
      else expect(screen.getByRole('button', { name: 'Select all 5' })).toBeTruthy();

      await changeCategory(user);
      const sheet = within(
        await screen.findByRole('dialog', {
          name: size === 'phone' ? 'Change the category of 3' : 'Change the category of 3 entries',
        }),
      );
      if (size === 'phone') {
        hasLine('Stall, Nov 7, 6 and Oct 23 · now in Other');
      } else {
        hasLine('All Stall, now in Other');
        expect(sheet.getByRole('heading', { name: 'Move them to' })).toBeTruthy();
        expect(sheet.getAllByText('Stall · Wallet')).toHaveLength(3);
      }
      expect(
        sheet.getByRole('searchbox', { name: 'Find a category' }).getAttribute('placeholder'),
      ).toBe('Find an expense category');
      const to = within(sheet.getByRole('radiogroup', { name: 'Move to' }));
      await user.click(to.getByRole('radio', { name: 'Food' }));
      hasLine('RM 6.00 from Other to Food');
      // Only the two from this month are in its budget
      hasLine('Food budget: RM 40.00 → RM 37.00 left');
      await user.click(sheet.getByRole('button', { name: 'Move 3 to Food' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(await screen.findByText('Moved 3 to Food')).toBeTruthy();
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

  test('to a category under another, or to one with no budget; the list can be searched', async () => {
    const server = withSpending();
    const user = await openActivity(server, 'phone');
    await user.click(tick('first other'));
    await user.click(tick('second other'));
    const sheet = await moveTo(user, 'Coffee');
    expect(screen.getByRole('dialog', { name: 'Change the category of 2' })).toBeTruthy();
    hasLine('RM 3.00 from Other to Food › Coffee');
    hasLine('Food budget: RM 40.00 → RM 37.00 left');
    expect(sheet.getByRole('button', { name: 'Move 2 to Coffee' })).toBeTruthy();
    const to = within(sheet.getByRole('radiogroup', { name: 'Move to' }));
    await user.click(to.getByRole('radio', { name: 'Groceries' }));
    hasLine('Groceries has no budget');

    await user.type(sheet.getByRole('searchbox', { name: 'Find a category' }), 'cof');
    expect(to.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Food', 'Coffee']);
    await user.click(to.getByRole('radio', { name: 'Coffee' }));
    await user.click(sheet.getByRole('button', { name: 'Move 2 to Coffee' }));
    await waitFor(() => expect(byNote(server, 'first other').categoryId).toBe(COFFEE));
    expect(await screen.findByText('Moved 2 to Coffee')).toBeTruthy();
    expect(byNote(server, 'third other').categoryId).toBe(OTHER);
  });

  test("leaves the budget as it is for what's in it already, or from other months", async () => {
    const server = withSpending();
    const user = await openActivity(server, 'desktop');
    // Lunch is in Food already: to Coffee, under Food, it stays in Food's budget
    await user.click(tick('lunch'));
    await moveTo(user, 'Coffee');
    hasLine('RM 10.00 from Food to Food › Coffee');
    hasLine('Food budget: RM 40.00 left');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Only October's: this month's budget doesn't move
    await user.click(tick('lunch'));
    await user.click(tick('third other'));
    await moveTo(user, 'Food');
    hasLine('RM 3.00 from Other to Food');
    hasLine('Food budget: RM 40.00 left');
  });

  test('from several categories, says so, and Undo puts each back in its own', async () => {
    const server = withSpending();
    const user = await openActivity(server, 'desktop');
    await user.click(tick('first other'));
    await user.click(tick('bus fare'));
    const sheet = await moveTo(user, 'Food');
    expect(screen.getByRole('dialog', { name: 'Change the category of 2 entries' })).toBeTruthy();
    hasLine('Now in 2 categories');
    hasLine('RM 5.00 from 2 categories to Food');
    hasLine('Food budget: RM 40.00 → RM 35.00 left');
    await user.click(sheet.getByRole('button', { name: 'Move 2 to Food' }));
    await waitFor(() => expect(byNote(server, 'bus fare').categoryId).toBe(FOOD));

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(byNote(server, 'bus fare').categoryId).toBe(TRANSPORT));
    expect(byNote(server, 'first other').categoryId).toBe(OTHER);
    const [first, bus] = [byNote(server, 'first other').id, byNote(server, 'bus fare').id];
    expect(sentChanges().slice(1).map(sorted)).toEqual(
      expect.arrayContaining([
        { op: 'recategoriseTransactions', ids: [first], categoryId: OTHER },
        { op: 'recategoriseTransactions', ids: [bus], categoryId: TRANSPORT },
      ]),
    );
    expect(sentChanges()).toHaveLength(3);
  });

  test('refuses transfers, and spending with income, before anything opens; income has no budget', async () => {
    const server = withSpending();
    server.accounts.push({ ...server.accounts[0], id: BANK, name: 'Bank', position: 1 });
    seed(server, {
      date: '2026-11-08',
      kind: 'transfer',
      toAccountId: BANK,
      categoryId: null,
      note: 'to bank',
    });
    seed(server, {
      date: '2026-11-08',
      kind: 'income',
      amountCents: 2_500,
      categoryId: SALARY,
      note: 'pay',
    });
    const user = await openActivity(server, 'desktop');
    await user.click(tick('to bank'));
    await changeCategory(user);
    expect(
      await screen.findByText('Transfers have no category. Leave them out to change the category.'),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(tick('to bank'));
    await user.click(tick('pay'));
    await user.click(tick('lunch'));
    await changeCategory(user);
    expect(
      await screen.findByText('Pick only spending, or only income, to change their category.'),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Income alone moves among income's categories, with no budget to speak of
    await user.click(tick('lunch'));
    const sheet = await moveTo(user, 'Other income');
    expect(
      sheet.getByRole('searchbox', { name: 'Find a category' }).getAttribute('placeholder'),
    ).toBe('Find an income category');
    expect(
      within(sheet.getByRole('radiogroup', { name: 'Move to' })).queryByRole('radio', {
        name: 'Food',
      }),
    ).toBeNull();
    hasLine('RM 25.00 from Salary to Other income');
    expect(sheet.queryByText(/budget/)).toBeNull();
    expect(sentChanges()).toEqual([]);
  });
});

describe('deleting several', () => {
  test.each(SIZES)(
    'takes them out at once in one change; Undo adds each again as it was (%s)',
    async (size) => {
      const server = withSpending();
      const user = await openActivity(server, size);
      const before = [byNote(server, 'first other'), byNote(server, 'bus fare')].map((t) => ({
        ...t,
      }));
      await user.click(tick('first other'));
      await user.click(tick('bus fare'));
      expect(screen.getByText('2 selected')).toBeTruthy();
      // Held, to see they're gone before the server answers
      const answer = holdNext(server, 'POST', '/api/changes');
      await user.click(screen.getByRole('button', { name: 'Delete 2' }));
      await waitFor(() => expect(findTick('bus fare')).toBeNull());
      expect(findTick('first other')).toBeNull();
      expect(findTick('second other')).not.toBeNull();
      answer.release();
      await waitFor(() => expect(server.transactions).toHaveLength(3));
      expect(sentChanges().map(sorted)).toEqual([
        { op: 'removeTransactions', ids: before.map((t) => t.id).sort() },
      ]);

      expect(await screen.findByText('Deleted 2 entries')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(server.transactions).toHaveLength(5));
      for (const t of before) {
        const { createdAt: _at, ...rest } = t;
        expect(server.transactions.find((x) => x.id === t.id)).toMatchObject(rest);
      }
    },
  );

  test('Undo is offered for a few seconds, then goes', async () => {
    const server = withSpending();
    const user = await openActivity(server, 'desktop');
    await user.click(tick('lunch'));
    await user.click(screen.getByRole('button', { name: 'Delete 1' }));
    expect(await screen.findByText('Deleted 1 entry')).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 5_000)));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull(), {
      timeout: 3_000,
    });
  }, 15_000);

  test('offline, takes them out at once, keeps the change, and sends it once back', async () => {
    const server = withSpending();
    const user = await openActivity(server, 'phone');
    const back = goOffline(server);
    await user.click(tick('first other'));
    await user.click(tick('lunch'));
    await user.click(screen.getByRole('button', { name: 'Delete 2' }));
    await waitFor(() => expect(findTick('lunch')).toBeNull());
    expect(server.transactions).toHaveLength(5);
    back();
    await waitFor(() => expect(server.transactions).toHaveLength(3), { timeout: 8000 });
    expect(sentChanges().filter((c) => c.op === 'removeTransactions')).toHaveLength(1);
  });

  test('moves the balance and the month at once, and counts them once when the answer is lost', async () => {
    const server = withSpending();
    const user = await openActivity(server, 'desktop');
    await user.click(tick('first other'));
    await user.click(tick('bus fare'));
    server.loseNext.changes = true;
    await user.click(screen.getByRole('button', { name: 'Delete 2' }));
    await waitFor(() => expect(server.transactions).toHaveLength(3));
    const resend = holdNext(server, 'POST', '/api/changes');

    // The balances and the month's card are both on Plan for now
    await goToPlace('Plan');
    const walletBalance = () =>
      screen
        .queryByRole('button', { name: /^Wallet,/ })
        ?.getAttribute('aria-label')
        ?.split(', ')
        .at(-1) ?? null;
    const spent = () => {
      const card = screen.queryByRole('region', { name: monthHeading('2026-11') });
      return card == null ? null : within(card).queryByLabelText('Spent')?.textContent ?? null;
    };
    // RM 80 + RM 5 back, RM 17 - RM 5 spent: counted once, though the server has it
    await waitFor(() => expect(walletBalance()).toBe('RM 85.00'));
    await waitFor(() => expect(spent()).toBe('RM 12.00'));
    await act(() => queryClient.refetchQueries({ type: 'active' }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(walletBalance()).toBe('RM 85.00');
    expect(spent()).toBe('RM 12.00');
    resend.release();
    await waitFor(() => expect(sentChanges()).toHaveLength(2), { timeout: 8000 });
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(server.transactions).toHaveLength(3);
    expect(walletBalance()).toBe('RM 85.00');
  });
});

describe('selecting', () => {
  test('one alone: "1 entry", moved and deleted', async () => {
    const server = withSpending();
    const user = await openActivity(server, 'phone');
    await user.click(tick('first other'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    hasLine('1 entry · RM 1.00 · all Stall');
    await changeCategory(user);
    const sheet = within(await screen.findByRole('dialog', { name: 'Change the category of 1' }));
    await user.click(
      within(sheet.getByRole('radiogroup', { name: 'Move to' })).getByRole('radio', {
        name: 'Food',
      }),
    );
    await user.click(sheet.getByRole('button', { name: 'Move 1 to Food' }));
    expect(await screen.findByText('Moved 1 to Food')).toBeTruthy();
    await waitFor(() => expect(byNote(server, 'first other').categoryId).toBe(FOOD));

    await user.click(tick('bus fare'));
    await user.click(screen.getByRole('button', { name: 'Delete 1' }));
    expect(await screen.findByText('Deleted 1 entry')).toBeTruthy();
    await waitFor(() => expect(server.transactions).toHaveLength(4));
  });

  test('a long press on a phone starts selecting with that one ticked; a tap still opens it', async () => {
    const server = withSpending();
    renderApp(server, '/?activity&dates=all', { size: 'phone' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByRole('button', { name: /^lunch, / }));
    expect(await screen.findByRole('dialog', { name: 'lunch' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const row = screen.getByRole('button', { name: 'Stall, Other · Wallet, −2.00' });
    fireEvent.pointerDown(row);
    await act(() => new Promise((r) => setTimeout(r, 800)));
    fireEvent.pointerUp(row);
    expect(await screen.findByText('1 selected')).toBeTruthy();
    expect(tick('second other')).toHaveProperty('checked', true);
    expect(tick('lunch')).toHaveProperty('checked', false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('up to 500 at once: 501 is refused with a message, 500 deleted in one change and brought back', async () => {
    const server = withSpending();
    for (let i = 0; i < 496; i++)
      seed(server, { amountCents: 1, note: `bulk ${i}`, date: '2025-01-01' });
    const user = await openActivity(server, 'desktop');
    // The buttons are looked for in the bar above the register, not the whole page: with
    // 501 rows drawn, finding one by its role across the page takes 20 seconds or more
    const selectAll = screen.getByText('Select all 501').closest('button');
    const bar = () => within(selectAll!.parentElement!);
    await user.click(bar().getByRole('button', { name: 'Select all 501' }));
    expect(await screen.findByText('501 selected', undefined, { timeout: 15_000 })).toBeTruthy();
    await user.click(bar().getByRole('button', { name: 'Change category' }));
    expect(await screen.findByText('You can change up to 500 transactions at once')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => notifications.clean());
    await waitFor(() =>
      expect(screen.queryByText('You can change up to 500 transactions at once')).toBeNull(),
    );
    await user.click(bar().getByRole('button', { name: 'Delete 501' }));
    expect(await screen.findByText('You can change up to 500 transactions at once')).toBeTruthy();
    await settle();
    expect(sentChanges()).toEqual([]);
    expect(server.transactions).toHaveLength(501);
    expect(screen.getByText('501 selected')).toBeTruthy();

    await user.click(tick('lunch'));
    expect(screen.getByText('500 selected')).toBeTruthy();
    await user.click(bar().getByRole('button', { name: 'Delete 500' }));
    await waitFor(() => expect(server.transactions.map((t) => t.note)).toEqual(['lunch']), {
      timeout: 8000,
    });
    const sent = sentChanges();
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe('removeTransactions');
    expect((sent[0] as Bulk).ids).toHaveLength(500);
    expect(await screen.findByText('Deleted 500 entries')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(server.transactions).toHaveLength(501), { timeout: 15_000 });
  }, 90_000);

  test("Tidy up's address, Select all, and they move in one go, with no other page opened", async () => {
    const server = withSpending();
    const pages = new Set<string>();
    const note = () => pages.add(window.location.search.split('&')[0]);
    const watch = setInterval(note, 20);
    onTestFinished(() => clearInterval(watch));
    renderApp(server, `/?activity&category=${OTHER}&from=2026-10-01&select`, { size: 'phone' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await waitFor(() => hasLine('3 found in Other'));
    await user.click(screen.getByRole('button', { name: 'Select all 3' }));
    expect(await screen.findByText('3 selected')).toBeTruthy();
    const sheet = await moveTo(user, 'Groceries');
    await user.click(sheet.getByRole('button', { name: 'Move 3 to Groceries' }));
    expect(await screen.findByRole('heading', { name: 'No transactions match' })).toBeTruthy();
    await waitFor(() =>
      expect(server.transactions.filter((t) => t.categoryId === GROCERIES)).toHaveLength(3),
    );
    note();
    expect([...pages]).toEqual(['?activity']);
  });
});

describe('offline', () => {
  test('a move shows at once, is kept, and is saved once the connection is back', async () => {
    const server = withSpending();
    const user = await openActivity(server, 'phone');
    const back = goOffline(server);
    await user.click(tick('first other'));
    await user.click(tick('second other'));
    const sheet = await moveTo(user, 'Food');
    await user.click(sheet.getByRole('button', { name: 'Move 2 to Food' }));
    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: /^Stall, Food · Wallet · Nov 7, −1\.00$/ }),
      ).toBeTruthy(),
    );
    expect(byNote(server, 'first other').categoryId).toBe(OTHER);

    back();
    await waitFor(() => expect(byNote(server, 'first other').categoryId).toBe(FOOD), {
      timeout: 8000,
    });
    expect(byNote(server, 'second other').categoryId).toBe(FOOD);
    expect(sentChanges().filter((c) => c.op === 'recategoriseTransactions')).toHaveLength(1);
  });
});
