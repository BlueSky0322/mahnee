// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  addEntry,
  fakeServer,
  finishConversion,
  goToPlace,
  holdNext,
  renderApp,
  setupAppTests,
} from '../../testing/app';
import { CONVERSION_POLL_MS } from '../../profile/ProfileContext';

// A change of home currency is taken at once and the app stays usable while the server
// converts every amount: places open, search takes typing, and entries are added (kept on the
// device until it's done). Totals say "conversion pending" until then, and how far it has
// got shows in the freshness line ("Converting to USD… 40%"); then they're the new
// currency's. A change refused says why under the row, with Try again. The server is asked
// how it's going one ask at a time. Every figure and name here is this file's own.

setupAppTests();

const SIZES = ['phone', 'desktop'] as const;
const WALLET = 'a'.repeat(16);
const FOOD = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;

const spend = (n: number): Transaction => ({
  id: n.toString(16).padStart(16, 'e'),
  kind: 'expense',
  accountId: WALLET,
  toAccountId: null,
  amountCents: 1_000 * n,
  categoryId: FOOD,
  payee: `Kedai ${n}`,
  note: null,
  date: new Date().toISOString().slice(0, 10),
  createdAt: n,
});

/** A wallet with RM 100.00 to start and two entries, RM 30.00 in all; USD at 0.25 */
function withWallet(): FakeServer {
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
  server.transactions.push(spend(1), spend(2));
  server.rates.set('MYRUSD', 0.25);
  return server;
}

/** Picks `code` as the main currency on Settings › Money */
async function pickCurrency(code: string) {
  const user = userEvent.setup();
  const card = await screen.findByRole('region', { name: 'Money' });
  await user.click(await within(card).findByRole('button', { name: /^Main currency/ }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Main currency' }));
  await user.click(dialog.getByRole('option', { name: new RegExp(`^${code}`) }));
  return user;
}

/** Back from Settings to the places, as a phone (Back twice) or a computer (Close) does */
async function leaveSettings(user: ReturnType<typeof userEvent.setup>) {
  const close = screen.queryByRole('button', { name: 'Close settings' });
  if (close != null) return user.click(close);
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  await user.click(await screen.findByRole('button', { name: 'Home' }));
}

const together = async () =>
  (await screen.findByRole('group', { name: 'All together' })).textContent ?? '';

describe.each(SIZES)('changing the main currency (%s)', (size) => {
  test('the app stays usable while it converts: places open, search types, an entry is added and saved once done', async () => {
    const server = withWallet();
    renderApp(server, '/?settings=money', { size });
    const user = await pickCurrency('USD');
    await waitFor(() => expect(server.me.conversion?.to).toBe('USD'));

    await leaveSettings(user);
    await goToPlace('Activity');
    const search = await screen.findByRole('searchbox', { name: 'Search' });
    await user.type(search, 'kedai 2');
    expect((search as HTMLInputElement).value).toBe('kedai 2');
    // What's typed is searched for, while the conversion is still under way
    expect((await screen.findAllByText('Kedai 2')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByText('Kedai 1')).toBeNull());
    expect(server.me.conversion?.refused).toBeNull();

    // An entry added meanwhile shows at once, says it waits, and is saved once it's done
    await user.clear(search);
    await goToPlace('Home');
    await addEntry('8');
    expect((await screen.findAllByText(/8\.00/)).length).toBeGreaterThan(0);
    expect(await screen.findByText(/^Converting to USD….* · 1 change waiting$/)).toBeTruthy();
    expect(server.transactions).toHaveLength(2);

    await goToPlace('Accounts');
    // RM 100.00 less RM 30.00 and the RM 8.00 just added, still in ringgit
    await waitFor(async () => expect(await together()).toContain('RM 62.00'));

    finishConversion(server);
    await waitFor(() => expect(server.transactions).toHaveLength(3), {
      timeout: CONVERSION_POLL_MS * 5,
    });
    // Typed in ringgit, saved in dollars at the day's rate: RM 8.00 is $ 2.00
    expect(server.transactions.at(-1)).toMatchObject({ kind: 'expense', amountCents: 200 });
    await waitFor(async () => expect(await together()).toContain('$ 15.50'), {
      timeout: CONVERSION_POLL_MS * 4,
    });
    expect(screen.queryByText(/change waiting/)).toBeNull();
  }, 30_000);

  test('totals say conversion pending, with how far it has got, then are the new currency', async () => {
    const server = withWallet();
    renderApp(server, '/?settings=money', { size });
    const user = await pickCurrency('USD');
    await waitFor(() => expect(server.me.conversion?.to).toBe('USD'));
    await leaveSettings(user);

    await goToPlace('Accounts');
    // Still in ringgit (RM 100.00 less RM 30.00), said to be pending
    await waitFor(async () => expect(await together()).toContain('RM 70.00'));
    expect(await together()).toContain('conversion pending');
    // Half way, as the server says on its next answer
    server.me = {
      ...server.me,
      conversion: { ...server.me.conversion!, progress: { done: 1, total: 2 } },
    };
    expect(
      await screen.findByText('Converting to USD… 50%', {}, { timeout: CONVERSION_POLL_MS * 3 }),
    ).toBeTruthy();

    finishConversion(server);
    await waitFor(async () => expect(await together()).toContain('$ 17.50'), {
      timeout: CONVERSION_POLL_MS * 4,
    });
    expect(await together()).not.toContain('conversion pending');
    expect(screen.queryByText(/^Converting to USD/)).toBeNull();
  });
});

describe.each(SIZES)('totals still in the old currency say so (%s)', (size) => {
  test.each([
    ['Home', '/'],
    ['Activity', '/?activity'],
    ['an account', `/?account=${WALLET}`],
    ['Plan', '/?plan'],
  ])('%s', async (_page, path) => {
    const server = withWallet();
    server.me = {
      ...server.me,
      settings: { ...server.me.settings, currency: 'USD' },
      conversion: { from: 'MYR', to: 'USD', since: Date.now(), refused: null },
    };
    renderApp(server, path, { size });
    expect((await screen.findAllByText('conversion pending')).length).toBeGreaterThan(0);
    finishConversion(server);
    await waitFor(() => expect(screen.queryAllByText('conversion pending')).toHaveLength(0), {
      timeout: CONVERSION_POLL_MS * 3,
    });
  });
});

test('a refused change says why, and Try again asks for it once more', async () => {
  const server = withWallet();
  server.me.conversion = { from: 'MYR', to: 'IDR', since: Date.now(), refused: 'rates' };
  renderApp(server, '/?settings=money', { size: 'phone' });
  const card = within(await screen.findByRole('region', { name: 'Money' }));
  expect(
    await card.findByText(
      "Kept MYR: rates for IDR weren't available, so nothing was converted. Try again later",
    ),
  ).toBeTruthy();
  await userEvent.setup().click(card.getByRole('button', { name: 'Try IDR again' }));
  await waitFor(() =>
    expect(server.me.conversion).toMatchObject({ from: 'MYR', to: 'IDR', refused: null }),
  );
  expect(await card.findByText(/^Converting to IDR…/)).toBeTruthy();
  expect(card.queryByRole('button', { name: 'Try IDR again' })).toBeNull();
});

test('asks the server how it is going one ask at a time, however slow it answers', async () => {
  const server = withWallet();
  server.me.conversion = { from: 'MYR', to: 'USD', since: Date.now(), refused: null };
  server.me.settings = { ...server.me.settings, currency: 'USD' };
  renderApp(server, '/?accounts');
  await screen.findByRole('group', { name: 'All together' });
  const asks = () =>
    vi
      .mocked(fetch)
      .mock.calls.filter(
        ([input, init]) =>
          new URL(input instanceof Request ? input.url : input.toString(), 'http://app')
            .pathname === '/api/me' && (init?.method ?? 'GET') === 'GET',
      ).length;
  const before = asks();
  // The next answer takes three rounds of asking to come
  const held = holdNext(server, 'GET', '/api/me');
  await act(() => new Promise((r) => setTimeout(r, CONVERSION_POLL_MS * 3 + 200)));
  expect(asks() - before).toBe(1);
  held.release();
  await act(() => new Promise((r) => setTimeout(r, CONVERSION_POLL_MS + 200)));
  expect(asks() - before).toBe(2);
}, 20_000);

test('a pick made just before the app is hidden still saves, though no frame is drawn', async () => {
  const server = withWallet();
  renderApp(server, '/?settings=money', { size: 'phone' });
  const user = userEvent.setup();
  const card = await screen.findByRole('region', { name: 'Money' });
  await user.click(await within(card).findByRole('button', { name: /^Main currency/ }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Main currency' }));
  // Then the app is hidden: a hidden tab or a backgrounded app draws no frames
  vi.stubGlobal('requestAnimationFrame', () => 0);
  await user.click(dialog.getByRole('option', { name: /^USD/ }));
  await waitFor(() => expect(server.me.conversion?.to).toBe('USD'), { timeout: 1_000 });
});
