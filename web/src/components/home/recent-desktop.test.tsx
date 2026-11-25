// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  addButton,
  addEntry,
  addForm,
  addSaveButton,
  fakeServer,
  holdNext,
  reloadApp,
  renderApp,
  setupAppTests,
  typeAmount,
} from '../../testing/app';
import { TOKENS, addStyles, moduleCss, readBeside, textColour, tokensCss } from '../../testing/css';
import homeCss from './Home.module.css';

// A computer's Home lists the latest entries (owner request 2026-11-25): beside the Day by
// day calendar, the 8 newest across every account, newest first, each with its day, what
// it was, its category and account (or the two accounts of a transfer) and its signed
// amount, opening the entry as Activity does; See all goes to Activity. On this month they
// are the latest of all; on an earlier month, that month's last 8. Phones and tablets are
// left as they were. Every name and figure is made up.

vi.hoisted(() => {
  process.env.TZ = 'Asia/Kuala_Lumpur';
});

setupAppTests();

const [CASH, BANK] = ['c', 'b'].map((c) => c.repeat(16));
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [FOOD, TRANSPORT, SALARY] = [id('Food'), id('Transport'), id('Salary')];

/** Wednesday 25 November 2026, mid-morning where the person is; the clock still ticks */
function onTheTwentyFifth() {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 25, 10, 0, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** Cash and Maybank, with the default categories */
function aServer() {
  const server = fakeServer();
  server.accounts.push(
    {
      id: CASH,
      name: 'Cash',
      kind: 'cash',
      currency: 'MYR',
      openingCents: 500_000,
      position: 0,
      archived: false,
    },
    {
      id: BANK,
      name: 'Maybank',
      kind: 'bank',
      currency: 'MYR',
      openingCents: 1_000_000,
      position: 1,
      archived: false,
    },
  );
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  return server;
}

/** An entry, the later added the newer */
function seed(server: FakeServer, date: string, amountCents: number, more: Partial<Transaction>) {
  const n = server.transactions.length + 1;
  server.transactions.push({
    id: n.toString(16).padStart(16, '0'),
    kind: 'expense',
    accountId: CASH,
    toAccountId: null,
    amountCents,
    categoryId: FOOD,
    payee: null,
    note: null,
    date,
    createdAt: n,
    ...more,
  });
}

/** Twelve entries from October 28 to today, spending, pay and transfers both ways */
function aFewWeeks() {
  const server = aServer();
  seed(server, '2026-10-28', 1_500, { payee: 'Kopitiam' });
  seed(server, '2026-10-30', 9_000, { payee: 'Pasar malam' });
  seed(server, '2026-10-31', 4_000, { categoryId: TRANSPORT, accountId: BANK });
  seed(server, '2026-11-02', 2_000, { payee: 'Roti canai' });
  seed(server, '2026-11-10', 12_000, { categoryId: TRANSPORT, accountId: BANK, payee: 'Petronas' });
  seed(server, '2026-11-18', 325_000, {
    kind: 'income',
    accountId: BANK,
    categoryId: SALARY,
    payee: 'Acme',
  });
  seed(server, '2026-11-20', 50_000, {
    kind: 'transfer',
    accountId: BANK,
    toAccountId: CASH,
    categoryId: null,
    note: 'top-up',
  });
  seed(server, '2026-11-21', 3_000, { payee: 'Kedai Ali' });
  seed(server, '2026-11-23', 5_500, { categoryId: TRANSPORT, accountId: BANK, payee: 'Grab' });
  seed(server, '2026-11-24', 2_200, { payee: 'Kopi' });
  seed(server, '2026-11-25', 1_800, { payee: 'Nasi lemak' });
  seed(server, '2026-11-25', 7_500, {
    kind: 'transfer',
    accountId: CASH,
    toAccountId: BANK,
    categoryId: null,
  });
  return server;
}

/** The 8 newest of aFewWeeks, as each row is read out */
const NEWEST_EIGHT = [
  'Cash to Maybank, Transfer, Today, RM 75.00',
  'Nasi lemak, Food · Cash, Today, −RM 18.00',
  'Kopi, Food · Cash, Yesterday, −RM 22.00',
  'Grab, Transport · Maybank, Mon, Nov 23, −RM 55.00',
  'Kedai Ali, Food · Cash, Sat, Nov 21, −RM 30.00',
  'top-up, Maybank to Cash, Fri, Nov 20, RM 500.00',
  'Acme, Salary · Maybank, Wed, Nov 18, +RM 3,250.00',
  'Petronas, Transport · Maybank, Tue, Nov 10, −RM 120.00',
];

const recent = (name = 'Recent activity') => screen.findByRole('region', { name });

/** Each row's name, top to bottom, once the rows are in */
async function rowNames(region: HTMLElement) {
  const list = await within(region).findByRole('list');
  return within(list)
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label'));
}

/** The requests for Home's latest entries made so far */
const recentReads = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(
      ([url]) => typeof url === 'string' && url.startsWith('/api/search') && /limit=8\b/.test(url),
    );

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

describe('a computer’s Home lists the latest entries', () => {
  test('the 8 newest across every account, newest first, beside the calendar', async () => {
    onTheTwentyFifth();
    renderApp(aFewWeeks(), '/', { size: 'desktop' });
    const region = await recent();
    await waitFor(async () => expect(await rowNames(region)).toEqual(NEWEST_EIGHT));
    // What each row shows, as well as says
    const [transfer, food] = within(within(region).getByRole('list')).getAllByRole('button');
    expect(within(transfer).getByText('Cash to Maybank')).toBeTruthy();
    expect(within(transfer).getByText('Transfer')).toBeTruthy();
    expect(within(food).getByText('Nasi lemak')).toBeTruthy();
    expect(within(food).getByText('Food · Cash')).toBeTruthy();
    expect(within(food).getByText('Today')).toBeTruthy();
    expect(within(food).getByText('−RM 18.00')).toBeTruthy();
    // In the calendar's row, which had room to spare
    const days = await screen.findByRole('region', { name: 'Day by day' });
    expect(region.closest('[data-home-row]')).toBe(days.closest('[data-home-row]'));
    expect(region.closest('[data-home-row]')).not.toBeNull();
    // Asked for once, 8 at most
    expect(recentReads()).toHaveLength(1);
    // Every kind, transfers too
    expect(recentReads()[0][0]).not.toContain('kind=');
  });

  test('amounts are coloured as Activity colours them', async () => {
    onTheTwentyFifth();
    const remove = addStyles([
      tokensCss(),
      moduleCss(readBeside('./Home.module.css', import.meta.url), homeCss),
    ]);
    onTestFinished(remove);
    renderApp(aFewWeeks(), '/', { size: 'desktop' });
    const region = await recent();
    await waitFor(async () => expect(await rowNames(region)).toEqual(NEWEST_EIGHT));
    expect(textColour(within(region).getByText('−RM 18.00'))).toBe(TOKENS.light['--ink']);
    expect(textColour(within(region).getByText('+RM 3,250.00'))).toBe(TOKENS.light['--pos']);
    expect(textColour(within(region).getByText('RM 75.00'))).toBe(TOKENS.light['--ink-3']);
  });

  test('a row opens that entry, from a click or the keyboard', async () => {
    onTheTwentyFifth();
    renderApp(aFewWeeks(), '/', { size: 'desktop' });
    const region = await recent();
    await waitFor(async () => expect(await rowNames(region)).toEqual(NEWEST_EIGHT));
    const user = userEvent.setup();
    await user.click(within(region).getByRole('button', { name: NEWEST_EIGHT[3] }));
    let dialog = await screen.findByRole('dialog', { name: 'Edit transaction' });
    expect(within(dialog).getByDisplayValue('Grab')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    within(region).getByRole('button', { name: NEWEST_EIGHT[6] }).focus();
    await user.keyboard('{Enter}');
    dialog = await screen.findByRole('dialog', { name: 'Edit transaction' });
    expect(within(dialog).getByDisplayValue('Acme')).toBeTruthy();
  });

  test('See all opens every entry in Activity, newest first', async () => {
    onTheTwentyFifth();
    renderApp(aFewWeeks(), '/', { size: 'desktop' });
    const region = await recent();
    const link = within(region).getByRole('link', { name: 'See all' });
    expect(link.getAttribute('href')).toBe('?activity&kind=all&dates=all');
    await userEvent.setup().click(link);
    await screen.findByRole('heading', { level: 1, name: 'Activity' });
    expect(window.location.search).toBe('?activity&kind=all&dates=all');
    const results = await screen.findByRole('table', { name: 'Transactions' });
    await waitFor(() => expect(within(results).getAllByRole('row')).toHaveLength(13));
  });

  test('with nothing logged yet, says so and where to add one', async () => {
    onTheTwentyFifth();
    renderApp(aServer(), '/', { size: 'desktop' });
    const region = await recent();
    expect(
      await within(region).findByText('Nothing logged yet. New entry (N) adds one.'),
    ).toBeTruthy();
    expect(within(region).queryByRole('list')).toBeNull();
    // New entry is the sidebar's, not repeated here
    expect(within(region).queryByRole('button')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'New entry' })).toHaveLength(1);
  });

  test('placeholders only while nothing is kept, never over what is shown', async () => {
    onTheTwentyFifth();
    const server = aFewWeeks();
    const held = holdNext(server, 'GET', '/api/search');
    renderApp(server, '/', { size: 'desktop' });
    const region = await recent();
    expect(within(region).getByText('Loading recent activity')).toBeTruthy();
    expect(within(region).queryByRole('list')).toBeNull();
    held.release();
    await waitFor(async () => expect(await rowNames(region)).toEqual(NEWEST_EIGHT));
    expect(within(region).queryByText('Loading recent activity')).toBeNull();

    // Another read on its way (a new entry saved, the list asked again): the rows stay
    holdNext(server, 'GET', '/api/search');
    await addEntry('9');
    expect(within(region).queryByText('Loading recent activity')).toBeNull();
    expect(within(region).getByRole('list')).toBeTruthy();
  });

  test('an entry added from New entry shows at the top at once', async () => {
    onTheTwentyFifth();
    const server = aFewWeeks();
    renderApp(server, '/', { size: 'desktop' });
    const region = await recent();
    await waitFor(async () => expect(await rowNames(region)).toEqual(NEWEST_EIGHT));
    // The answer to its save still on its way
    const saving = holdNext(server, 'POST', '/api/changes');
    await addEntry('12.34');
    await waitFor(async () => expect((await rowNames(region))[0]).toMatch(/, Today, −RM 12\.34$/));
    // Still 8: the oldest of them makes room
    expect(await rowNames(region)).toEqual([
      expect.stringMatching(/, Today, −RM 12\.34$/),
      ...NEWEST_EIGHT.slice(0, 7),
    ]);
    // Once the server's answer is in, it stays where it is
    saving.release();
    await waitFor(() => expect(screen.queryByText(/waiting/)).toBeNull());
    expect((await rowNames(region))[0]).toMatch(/, Today, −RM 12\.34$/);
    expect(await rowNames(region)).toHaveLength(8);
  });

  test('offline, entries waiting to save and for a rate show as they do elsewhere', async () => {
    onTheTwentyFifth();
    const server = aFewWeeks();
    server.me.settings = { ...server.me.settings, otherCurrencies: ['THB'] };
    renderApp(server, '/', { size: 'desktop' });
    const region = await recent();
    await waitFor(async () => expect(await rowNames(region)).toEqual(NEWEST_EIGHT));
    goOffline(server);

    // Waiting to save: listed as any other, at the top
    await addEntry('4');
    await waitFor(async () => expect((await rowNames(region))[0]).toMatch(/, Today, −RM 4\.00$/));

    // Typed in baht with no rate known: what was typed, and that its conversion is pending
    const user = userEvent.setup();
    await user.click(await addButton());
    await user.click((await addForm()).getByRole('button', { name: /, currency$/ }));
    await user.click(await screen.findByRole('option', { name: /^THB/ }));
    const form = await addForm();
    await typeAmount(form, '120');
    await form.findByText(/^Conversion pending/);
    await user.click(addSaveButton(form));
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );
    // Both waiting, above everything saved (two made the same moment come in either order)
    await waitFor(async () =>
      expect((await rowNames(region)).slice(0, 2).sort()).toEqual([
        'Food, Cash, Today, −RM 4.00',
        'Food, Cash, Today, −THB 120.00, conversion pending',
      ]),
    );
    expect((await rowNames(region))[2]).toBe(NEWEST_EIGHT[0]);
    const pending = within(region).getByRole('button', { name: /conversion pending$/ });
    expect(within(pending).getByText('−THB 120.00')).toBeTruthy();
    expect(within(pending).getByText('conversion pending')).toBeTruthy();
    expect(server.transactions).toHaveLength(12);
  });

  test('opened offline with no copy on this device, says so', async () => {
    onTheTwentyFifth();
    const server = aFewWeeks();
    renderApp(server, '/', { size: 'desktop' });
    await recent();
    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    await reloadApp(server, '/', { size: 'desktop' });
    const region = await recent();
    expect(
      await within(region).findByText(
        "Your entries aren't on this device yet.",
        {},
        { timeout: 6000 },
      ),
    ).toBeTruthy();
  });

  test('an earlier month lists its own last 8, and See all opens that month', async () => {
    onTheTwentyFifth();
    const server = aFewWeeks();
    for (let day = 1; day <= 7; day++) {
      seed(server, `2026-10-0${day}`, 100 * day, { payee: `October ${day}` });
    }
    renderApp(server, '/?month=2026-10', { size: 'desktop' });
    const region = await recent('Latest in October');
    await waitFor(async () =>
      expect(await rowNames(region)).toEqual([
        'Transport, Maybank, Sat, Oct 31, −RM 40.00',
        'Pasar malam, Food · Cash, Fri, Oct 30, −RM 90.00',
        'Kopitiam, Food · Cash, Wed, Oct 28, −RM 15.00',
        'October 7, Food · Cash, Wed, Oct 7, −RM 7.00',
        'October 6, Food · Cash, Tue, Oct 6, −RM 6.00',
        'October 5, Food · Cash, Mon, Oct 5, −RM 5.00',
        'October 4, Food · Cash, Sun, Oct 4, −RM 4.00',
        'October 3, Food · Cash, Sat, Oct 3, −RM 3.00',
      ]),
    );
    expect(within(region).getByRole('link', { name: 'See all' }).getAttribute('href')).toBe(
      '?activity&kind=all&from=2026-10-01&to=2026-10-31',
    );
    expect(screen.queryByRole('region', { name: 'Recent activity' })).toBeNull();

    // Back to this month: the latest of all again
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next month' }));
    await waitFor(async () => expect(await rowNames(await recent())).toEqual(NEWEST_EIGHT));
  });

  test('an earlier month with nothing in it says so', async () => {
    onTheTwentyFifth();
    renderApp(aFewWeeks(), '/?month=2026-09', { size: 'desktop' });
    const region = await recent('Latest in September');
    expect(await within(region).findByText('Nothing logged in September.')).toBeTruthy();
  });

  test.each(['phone', 'tablet'] as const)('a %s’s Home is left as it was', async (size) => {
    onTheTwentyFifth();
    renderApp(aFewWeeks(), '/', { size });
    await screen.findByRole('region', { name: 'Day by day' });
    await screen.findByRole('region', { name: 'Budgets' });
    expect(screen.queryByRole('region', { name: 'Recent activity' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'See all' })).toBeNull();
    expect(recentReads()).toHaveLength(0);
  });
});
