// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import { afterAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Recurring, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  fakeServer,
  goToPlace,
  holdNext,
  reloadApp,
  renderApp,
  setupAppTests,
} from '../../testing/app';

// While a page waits on the server it shows placeholders shaped like what's coming, read out
// once as "Loading …" in a region marked busy, never an empty page or "No accounts yet"; they
// go once the answer lands, and a page with a copy already on hand (from earlier, or kept on
// the device) draws that copy at once, with no placeholders over it. Every figure and name
// here is this file's own.

const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'Asia/Kuala_Lumpur';
afterAll(() => {
  process.env.TZ = TZ_BEFORE;
});

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const BANK = 'b'.repeat(16);
const FOOD = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;
const BILLS = DEFAULT_CATEGORIES.find((c) => c.name === 'Bills')!.id;

function tenthOfNovember() {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 12, 0, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

const entry = (n: number, more: Partial<Transaction> = {}): Transaction => ({
  id: n.toString(16).padStart(16, 'a'),
  kind: 'expense',
  accountId: BANK,
  toAccountId: null,
  amountCents: 1_250 * n,
  categoryId: FOOD,
  payee: `Stall ${n}`,
  note: null,
  date: `2026-11-0${n}`,
  createdAt: n,
  ...more,
});

const rent: Recurring = {
  id: '9'.repeat(16),
  kind: 'expense',
  accountId: BANK,
  toAccountId: null,
  amountCents: 90_000,
  categoryId: BILLS,
  payee: 'Rent',
  schedule: 'monthly',
  day: 1,
  startDate: '2026-10-01',
  nextDue: '2026-12-01',
  archived: false,
  amountVaries: false,
  askFirst: false,
};

/** One bank account, three entries this month and the rent scheduled */
function withEntries(): FakeServer {
  const server = fakeServer();
  server.accounts.push({
    id: BANK,
    name: 'Bank',
    kind: 'bank',
    currency: 'MYR',
    openingCents: 500_000,
    position: 0,
    archived: false,
  });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  server.transactions.push(entry(1), entry(2), entry(3));
  server.recurring.push(rent);
  return server;
}

/** A page's placeholders, by what they're read out as; null when there are none */
const placeholders = (label: string) => {
  const said = screen.queryByText(label);
  return said?.closest('[aria-busy="true"]') ?? null;
};

/** Long enough for anything not held back to have loaded */
const pause = (ms = 100) => act(() => new Promise((r) => setTimeout(r, ms)));

/**
 * Each page: its address, the answer it waits on, the placeholders it shows meanwhile, and
 * something it draws once that answer is in
 */
const PAGES = [
  {
    page: 'Home',
    path: '/',
    waitsOn: '/api/accounts',
    loading: 'Loading Home',
    loaded: () => screen.findAllByText(/Bank/),
  },
  {
    page: 'Activity',
    path: '/?activity',
    waitsOn: '/api/search',
    loading: 'Loading Activity',
    loaded: () => screen.findAllByText('Stall 3'),
  },
  {
    page: 'Accounts',
    path: '/?accounts',
    waitsOn: '/api/accounts',
    loading: 'Loading your accounts',
    loaded: () => screen.findAllByText('Bank'),
  },
  {
    page: 'an account',
    path: `/?account=${BANK}`,
    waitsOn: '/api/transactions',
    loading: 'Loading the transactions',
    loaded: () => screen.findAllByText('Stall 2'),
  },
  {
    page: 'Plan',
    path: '/?plan',
    waitsOn: '/api/summary',
    loading: 'Loading this month',
    loaded: () => screen.findAllByText(/Food/),
  },
  {
    page: 'Scheduled',
    path: '/?plan=scheduled',
    waitsOn: '/api/accounts',
    loading: 'Loading Scheduled',
    loaded: () => screen.findAllByText('Rent'),
  },
  {
    page: 'Categories',
    path: '/?settings=categories',
    waitsOn: '/api/accounts',
    loading: 'Loading your categories',
    loaded: () => screen.findAllByText('Groceries'),
  },
  {
    page: 'Settings › Money',
    path: '/?settings=money',
    waitsOn: '/api/me',
    loading: 'Loading your settings',
    loaded: () => screen.findByText('Main currency'),
  },
  {
    page: 'Settings › Adding entries',
    path: '/?settings=adding',
    waitsOn: '/api/me',
    loading: 'Loading your settings',
    loaded: () => screen.findByText('Start with'),
  },
  {
    page: 'Import',
    path: '/?import',
    waitsOn: '/api/accounts',
    loading: 'Loading the accounts to import into',
    loaded: () => screen.findByLabelText('Account'),
  },
] as const;

describe.each(SIZES)('loading placeholders (%s)', (size) => {
  test.each(PAGES)(
    '$page shows placeholders while it waits, and its own once they land',
    async ({ path, waitsOn, loading, loaded }) => {
      tenthOfNovember();
      const server = withEntries();
      const held = holdNext(server, 'GET', waitsOn);
      renderApp(server, path, { size });
      expect(await screen.findByText(loading)).toBeTruthy();
      await pause();
      // Marked busy, said once, and nothing in it read out but that
      const region = placeholders(loading)!;
      expect(region).toBeTruthy();
      expect(region.textContent).toBe(loading);
      const blocks = [...region.querySelectorAll('span:empty')];
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) expect(block.getAttribute('aria-hidden')).toBe('true');
      // Never an empty page meanwhile
      expect(screen.queryByText('No accounts yet')).toBeNull();
      expect(screen.queryByText('Add your first account')).toBeNull();

      held.release();
      await loaded();
      expect(placeholders(loading)).toBeNull();
    },
  );
});

describe.each(SIZES)('a copy on hand draws at once (%s)', (size) => {
  test.each([
    { place: 'Activity', loading: 'Loading Activity', shows: 'Stall 3', waitsOn: '/api/search' },
    {
      place: 'Accounts',
      loading: 'Loading your accounts',
      shows: 'Bank',
      waitsOn: '/api/accounts',
    },
    { place: 'Plan', loading: 'Loading this month', shows: /Food/, waitsOn: '/api/summary' },
  ] as const)(
    '$place, opened again, shows what it had with no placeholders',
    async ({ place, loading, shows, waitsOn }) => {
      tenthOfNovember();
      const server = withEntries();
      renderApp(server, '/', { size });
      await screen.findByRole('heading', { name: /November/ });
      await goToPlace(place);
      expect((await screen.findAllByText(shows)).length).toBeGreaterThan(0);
      await goToPlace('Home');
      await screen.findByRole('heading', { name: /November/ });

      // Asked again, and the answer held back: what was shown before draws meanwhile
      const held = holdNext(server, 'GET', waitsOn);
      await goToPlace(place);
      expect(screen.getAllByText(shows).length).toBeGreaterThan(0);
      expect(placeholders(loading)).toBeNull();
      held.release();
    },
  );

  test("the month's totals kept on the device draw at once on the next start", async () => {
    tenthOfNovember();
    const server = withEntries();
    renderApp(server, '/?plan', { size });
    expect((await screen.findAllByText(/Food/)).length).toBeGreaterThan(0);
    await pause(300);

    // An entry added elsewhere meanwhile. The next start: the server's totals held back, the
    // device's copy (without it) shown meanwhile, then the server's with it
    server.transactions.push(entry(4, { categoryId: BILLS, payee: 'Power' }));
    const held = holdNext(server, 'GET', '/api/summary');
    const balances = holdNext(server, 'GET', '/api/accounts');
    await reloadApp(server, '/?plan', { size });
    expect((await screen.findAllByText(/Food/)).length).toBeGreaterThan(0);
    expect(placeholders('Loading this month')).toBeNull();
    // RM 75.00 spent on the device's copy; RM 125.00 on the server's
    expect(screen.queryAllByText(/125\.00/)).toHaveLength(0);
    held.release();
    balances.release();
    expect((await screen.findAllByText(/125\.00/)).length).toBeGreaterThan(0);
  });

  test('the accounts kept on the device draw at once on the next start', async () => {
    tenthOfNovember();
    const server = withEntries();
    renderApp(server, '/?accounts', { size });
    expect((await screen.findAllByText('Bank')).length).toBeGreaterThan(0);
    await pause(300);

    // The next start: the server's answer held back, the device's copy shown meanwhile
    const held = holdNext(server, 'GET', '/api/accounts');
    await reloadApp(server, '/?accounts', { size });
    const list = await screen.findByRole('list', { name: /accounts/i }).catch(() => null);
    expect((await (list ? within(list) : screen).findAllByText('Bank')).length).toBeGreaterThan(0);
    expect(placeholders('Loading your accounts')).toBeNull();
    held.release();
  });
});

test('offline with nothing kept says so, rather than loading for ever', async () => {
  tenthOfNovember();
  const server = withEntries();
  server.health = 'unreachable';
  renderApp(server, '/?accounts', { size: 'phone' });
  await pause(500);
  expect(placeholders('Loading your accounts')).toBeNull();
});
