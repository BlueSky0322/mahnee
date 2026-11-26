// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';
import { navigate } from '../../hooks/useRoute';

// Back after Activity's filters (R-Activity, R-Activity-Select). A filter's list opens over
// the page, a sheet on phones holding a step of its own in the history; picking from it
// closes it and changes the filter in Activity's own place in the history, as a computer
// does. So Back after picking leaves Activity, to the page opened before it, and never
// brings back a filter that was there before. Every figure and name here is this file's own.

setupAppTests();

beforeEach(() => {
  // Tuesday 10 November 2026, in the device's own time
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 10, 0, 0));
  return () => vi.useRealTimers();
});

const WALLET = 'a'.repeat(16);
const BANK = 'b'.repeat(16);
const FOOD = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;

let seeded = 0;
function seed(server: FakeServer, t: Partial<Transaction>) {
  seeded++;
  server.transactions.push({
    id: seeded.toString(16).padStart(16, '0'),
    kind: 'expense',
    accountId: WALLET,
    toAccountId: null,
    amountCents: 100,
    categoryId: FOOD,
    payee: null,
    note: null,
    date: '2026-11-01',
    createdAt: seeded,
    ...t,
  });
}

/** A Wallet with "coffee" on Nov 9, and a Bank with "rent" on Nov 2 */
function withTwo() {
  const server = fakeServer();
  for (const [id, name, position] of [
    [WALLET, 'Wallet', 0],
    [BANK, 'Bank', 1],
  ] as const) {
    server.accounts.push({
      id,
      name,
      kind: 'cash',
      currency: 'MYR',
      openingCents: 10_000,
      position,
      archived: false,
    });
  }
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  seed(server, { date: '2026-11-09', amountCents: 400, note: 'coffee' });
  seed(server, { date: '2026-11-02', amountCents: 9_000, accountId: BANK, note: 'rent' });
  return server;
}

type Size = 'phone' | 'tablet' | 'desktop';

/** Home first, then Activity at `activity` opened from it, a step of its own */
async function fromHome(size: Size, activity = '?activity') {
  renderApp(withTwo(), '/', { size });
  await screen.findByRole('heading', { name: /^November/, level: 1 });
  act(() => navigate(activity));
  await screen.findByRole('heading', { name: /^(Activity|\d+ selected)$/, level: 1 });
  await screen.findByRole('region', { name: 'Results' });
  // The accounts are known, so the chips name them
  if (size === 'desktop') await screen.findByRole('table', { name: 'Transactions' });
  else await waitFor(() => expect(notes().length).toBeGreaterThan(0));
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

const chip = (name: string) =>
  within(screen.getByRole('group', { name: 'Filters' })).getByRole('button', { name });

/** The rows listed, each by its note */
const notes = () =>
  within(screen.getByRole('region', { name: 'Results' }))
    .queryAllByRole(screen.queryByRole('heading', { name: /selected$/ }) ? 'checkbox' : 'button')
    .map((b) => (b.getAttribute('aria-label') ?? '').split(', ')[0])
    .filter((note) => note === 'coffee' || note === 'rent');

async function pick(user: ReturnType<typeof userEvent.setup>, chipName: string, option: string) {
  await user.click(chip(chipName));
  const list = within(await screen.findByRole('dialog'));
  await user.click(list.getByRole('radio', { name: option }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

/** The browser's Back, once it has landed and the page has drawn what it leads to */
async function back() {
  const was = window.location.href;
  const landed = new Promise((resolve) =>
    window.addEventListener('popstate', resolve, { once: true }),
  );
  await act(async () => {
    window.history.back();
    await landed;
  });
  // Whatever the app does on landing (another step back over a closed layer) settles
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  return was;
}

/** Back leaves Activity for Home, the page it was opened from */
async function backToHome() {
  await back();
  await waitFor(() => expect(window.location.search).toBe(''));
  expect(await screen.findByRole('heading', { name: /^November/, level: 1 })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Activity', level: 1 })).toBeNull();
}

describe.each(['phone', 'tablet'] as const)('on a %s', (size) => {
  test('opening a filter, then Back: it closes, and the filter and the page stay', async () => {
    const user = await fromHome(size, `?activity&account=${WALLET}`);
    await user.click(chip('Wallet'));
    await screen.findByRole('dialog', { name: 'Account' });
    if (size === 'phone') await back();
    else await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.search).toBe(`?activity&account=${WALLET}`);
    expect(screen.getByRole('heading', { name: 'Activity', level: 1 })).toBeTruthy();
    expect(chip('Wallet').getAttribute('aria-pressed')).toBe('true');
    expect(notes()).toEqual(['coffee']);
    await backToHome();
  });

  test('picking a filter, then Back: Activity is left, never the filter before', async () => {
    const user = await fromHome(size);
    await pick(user, 'All accounts', 'Bank');
    expect(window.location.search).toBe(`?activity&account=${BANK}`);
    expect(chip('Bank').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(notes()).toEqual(['rent']));
    await backToHome();
  });

  test('picking twice in a row, then Back: Activity is left, with neither pick on the way', async () => {
    const user = await fromHome(size);
    await pick(user, 'All accounts', 'Bank');
    await pick(user, 'Bank', 'Wallet');
    expect(window.location.search).toBe(`?activity&account=${WALLET}`);
    await waitFor(() => expect(notes()).toEqual(['coffee']));
    await backToHome();
  });

  test('selecting, a filter changed, then Done: selecting ends and leaves no step', async () => {
    const user = await fromHome(size, `?activity&account=${WALLET}`);
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await screen.findByRole('heading', { name: '0 selected' });
    await pick(user, 'Wallet', 'Bank');
    await waitFor(() => expect(notes()).toEqual(['rent']));
    expect(screen.getByRole('heading', { name: '0 selected' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByRole('button', { name: 'Select' });
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(window.location.search).toBe(`?activity&account=${BANK}`);
    expect(chip('Bank').getAttribute('aria-pressed')).toBe('true');
    expect(notes()).toEqual(['rent']);
    await backToHome();
  });

  test('selecting, a filter changed, then Back: selecting ends, the new filter stays', async () => {
    const user = await fromHome(size, `?activity&account=${WALLET}`);
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await screen.findByRole('heading', { name: '0 selected' });
    await pick(user, 'Wallet', 'Bank');
    await waitFor(() => expect(notes()).toEqual(['rent']));
    await back();
    expect(await screen.findByRole('button', { name: 'Select' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /selected$/ })).toBeNull();
    expect(window.location.search).toBe(`?activity&account=${BANK}`);
    expect(chip('Bank').getAttribute('aria-pressed')).toBe('true');
    expect(notes()).toEqual(['rent']);
    await backToHome();
  });
});

describe('on a computer', () => {
  test('picking a filter, then Back: Activity is left, as before', async () => {
    const user = await fromHome('desktop');
    await pick(user, 'All accounts', 'Bank');
    await pick(user, 'Bank', 'Wallet');
    expect(window.location.search).toBe(`?activity&account=${WALLET}`);
    await backToHome();
  });
});
