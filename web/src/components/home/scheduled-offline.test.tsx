// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { ChangesBody, Recurring } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, reloadApp, renderApp, settle, setupAppTests } from '../../testing/app';

// A scheduled item due while the device is offline: the server adds it on its day, but this
// device can't hear of it until it's back. Meanwhile Home shows the occurrence as
// projected, "Scheduled, adds when back online", never as a change of its own; once back,
// the server's one entry takes its place, and nothing is added twice. Figures are made up.

const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'Asia/Kuala_Lumpur';
afterAll(() => {
  process.env.TZ = TZ_BEFORE;
});

setupAppTests();

const SIZES = ['phone', 'desktop'] as const;
const BANK = 'b'.repeat(16);
const BILLS = DEFAULT_CATEGORIES.find((c) => c.name === 'Bills')!.id;

const RENT: Recurring = {
  id: '9'.repeat(16),
  kind: 'expense',
  accountId: BANK,
  toAccountId: null,
  amountCents: 135_000,
  categoryId: BILLS,
  payee: 'Rent',
  schedule: 'monthly',
  day: 20,
  startDate: '2026-10-20',
  nextDue: '2026-11-20',
  archived: false,
  amountVaries: false,
  askFirst: false,
};

function withRent(): FakeServer {
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
  server.recurring = [{ ...RENT }];
  return server;
}

/** The server's run on the 20th: Rent added from Scheduled, and its next date moved on */
function serverAddsRent(server: FakeServer) {
  server.transactions.push({
    id: '1'.repeat(16),
    kind: 'expense',
    accountId: BANK,
    toAccountId: null,
    amountCents: 135_000,
    categoryId: BILLS,
    payee: 'Rent',
    note: null,
    date: '2026-11-20',
    createdAt: Date.now(),
    scheduled: { recurringId: RENT.id, due: '2026-11-20', toCheck: false },
  });
  server.recurring[0].nextDue = '2026-12-20';
}

function goOffline(server: FakeServer) {
  server.health = 'unreachable';
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  onTestFinished(() => onLine.mockRestore());
  act(() => void window.dispatchEvent(new Event('offline')));
  return () => {
    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
  };
}

const sentChanges = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => url === '/api/changes' && init?.method === 'POST')
    .flatMap(([, init]) => (JSON.parse(init?.body as string) as ChangesBody).changes);

describe.each(SIZES)('a scheduled item due while offline (%s)', (size) => {
  test('shows as projected, then becomes the one entry the server added', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    onTestFinished(() => void vi.useRealTimers());
    vi.setSystemTime(new Date(2026, 10, 19, 22, 0, 0));
    const server = withRent();
    renderApp(server, '/', { size });
    expect(
      await screen.findByRole('region', { name: 'Day by day' }, { timeout: 3000 }),
    ).toBeTruthy();
    await settle();
    // Not due yet: nothing projected
    expect(screen.queryByText(/adds when back online/)).toBeNull();
    const back = goOffline(server);

    // Past midnight, the app opened again offline
    vi.setSystemTime(new Date(2026, 10, 20, 9, 0, 0));
    await reloadApp(server, '/', { size });
    const due = await screen.findByRole('region', { name: 'Due now' }, { timeout: 3000 });
    const row = within(due).getByRole('group', { name: 'Due: Rent RM 1,350.00 from Maybank' });
    expect(within(row).getByText('Scheduled, adds when back online')).toBeTruthy();
    // Projected, not recorded: nothing to log or skip
    expect(within(row).queryByRole('button')).toBeNull();

    serverAddsRent(server);
    back();
    await waitFor(() => expect(screen.queryByText('Scheduled, adds when back online')).toBeNull(), {
      timeout: 5000,
    });
    expect(screen.queryByRole('region', { name: 'Due now' })).toBeNull();
    // The server's entry alone: the device sent nothing for it
    expect(server.transactions.filter((t) => t.payee === 'Rent')).toHaveLength(1);
    expect(sentChanges()).toEqual([]);
  });
});

describe('projected by the person’s own day, as the server adds them', () => {
  test('a person saved in Kathmandu, offline in Kuala Lumpur: Rent shows only once it is the 20th in Kathmandu', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
      process.env.TZ = 'Asia/Kuala_Lumpur';
    });
    // At home in Kathmandu (UTC+5:45): the app saves that zone for the server
    process.env.TZ = 'Asia/Kathmandu';
    vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
    const server = withRent();
    renderApp(server, '/', { size: 'phone' });
    await screen.findByRole('region', { name: 'Day by day' }, { timeout: 3000 });
    await waitFor(() => expect(server.me.settings.timeZone).toMatch(/^Asia\/Kath?mandu$/));
    await settle();
    goOffline(server);

    // Travelled to Kuala Lumpur (UTC+8), offline: 00:30 on the 20th here is still 22:15 on
    // the 19th in Kathmandu, so the server hasn't added Rent
    process.env.TZ = 'Asia/Kuala_Lumpur';
    vi.setSystemTime(new Date('2026-11-19T16:30:00Z'));
    await reloadApp(server, '/', { size: 'phone' });
    await screen.findByRole('region', { name: 'Day by day' }, { timeout: 3000 });
    await settle();
    expect(screen.queryByText('Scheduled, adds when back online')).toBeNull();

    // 02:30 here, 00:15 on the 20th in Kathmandu: the server's run adds it now
    vi.setSystemTime(new Date('2026-11-19T18:30:00Z'));
    await reloadApp(server, '/', { size: 'phone' });
    const due = await screen.findByRole('region', { name: 'Due now' }, { timeout: 3000 });
    const row = within(due).getByRole('group', { name: 'Due: Rent RM 1,350.00 from Maybank' });
    expect(within(row).getByText('Due today')).toBeTruthy();
    expect(within(row).getByText('Scheduled, adds when back online')).toBeTruthy();
  });

  test('two missed weeks show twice; an item whose category is archived not at all', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    onTestFinished(() => void vi.useRealTimers());
    vi.setSystemTime(new Date(2026, 10, 12, 22, 0, 0));
    const server = withRent();
    const fun = DEFAULT_CATEGORIES.find((c) => c.name === 'Fun')!.id;
    server.recurring.push(
      {
        ...RENT,
        id: '8'.repeat(16),
        payee: 'Badminton',
        amountCents: 2_000,
        schedule: 'weekly',
        // Fridays: the 13th and the 20th
        day: 5,
        startDate: '2026-11-06',
        nextDue: '2026-11-13',
      },
      {
        ...RENT,
        id: '7'.repeat(16),
        payee: 'Concert',
        amountCents: 9_000,
        categoryId: fun,
        nextDue: '2026-11-15',
        day: 15,
      },
    );
    server.categories = server.categories.map((c) => (c.id === fun ? { ...c, archived: true } : c));
    renderApp(server, '/', { size: 'desktop' });
    await screen.findByRole('region', { name: 'Day by day' }, { timeout: 3000 });
    await settle();
    goOffline(server);

    vi.setSystemTime(new Date(2026, 10, 20, 9, 0, 0));
    await reloadApp(server, '/', { size: 'desktop' });
    const due = await screen.findByRole('region', { name: 'Due now' }, { timeout: 3000 });
    const rows = within(due)
      .getAllByRole('group')
      .map((g) => g.textContent);
    // Oldest first, then in the order they were scheduled
    expect(rows).toEqual([
      'Due: Badminton RM 20.00 from MaybankWas due Nov 13Scheduled, adds when back online',
      'Due: Rent RM 1,350.00 from MaybankDue todayScheduled, adds when back online',
      'Due: Badminton RM 20.00 from MaybankDue todayScheduled, adds when back online',
    ]);
  });
});
