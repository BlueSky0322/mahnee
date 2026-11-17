// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  addButton,
  addForm,
  addSaveButton,
  fakeServer,
  renderApp,
  settle,
  setupAppTests,
  typeAmount,
} from '../../testing/app';

// "Ask for a time" (R-Set-Adding; owner decisions D14, D20): "Add shows the time (now,
// changeable); entries show it ('Today, 8:12 PM') and sort by it within a day ... Off:
// entries have no time, as today." Names and figures are made up.

vi.hoisted(() => {
  process.env.TZ = 'Asia/Kuala_Lumpur';
});

setupAppTests();

// 8:12 PM on 10 November 2026 where the person is (12:12 UTC)
const NOW = new Date(2026, 10, 10, 20, 12);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const SIZES = ['phone', 'desktop'] as const;
const WALLET = 'a'.repeat(16);
const FOOD = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;

function withWallet(askForTime: boolean): FakeServer {
  const server = fakeServer();
  server.me.settings.askForTime = askForTime;
  server.accounts.push({
    id: WALLET,
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 50_000,
    position: 0,
    archived: false,
  });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  return server;
}

let seeded = 0;
function seed(
  server: FakeServer,
  payee: string,
  time: string | null,
  more: Partial<Transaction> = {},
) {
  seeded++;
  server.transactions.push({
    id: seeded.toString(16).padStart(16, '0'),
    kind: 'expense',
    accountId: WALLET,
    toAccountId: null,
    amountCents: 725,
    categoryId: FOOD,
    payee,
    note: null,
    date: '2026-11-10',
    createdAt: seeded,
    ...(time == null ? {} : { time }),
    ...more,
  });
}

describe.each(SIZES)('Add (%s)', (size) => {
  test('off: no time is asked for, and the entry has none', async () => {
    const server = withWallet(false);
    renderApp(server, '/', { size });
    const user = userEvent.setup();
    await user.click(await addButton());
    const form = await addForm();
    expect(form.getByRole('button', { name: 'Today' })).toBeTruthy();
    await user.click(form.getByRole('button', { name: 'Today' }));
    expect(form.queryByLabelText('Time')).toBeNull();
    await typeAmount(form, '4');
    await user.click(addSaveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    expect(server.transactions[0].time ?? null).toBeNull();
  });

  test('on: the day says the time now, and the entry is saved with it', async () => {
    const server = withWallet(true);
    renderApp(server, '/', { size });
    const user = userEvent.setup();
    await user.click(await addButton());
    const form = await addForm();
    expect(form.getByRole('button', { name: 'Today, 8:12 PM' })).toBeTruthy();
    await typeAmount(form, '4');
    // Three minutes pass before Save: what the day said is what's saved
    vi.setSystemTime(new Date(2026, 10, 10, 20, 15));
    await user.click(addSaveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    expect(server.transactions[0]).toMatchObject({ date: '2026-11-10', time: '20:12' });
  });

  test('on: another day keeps the time of day shown', async () => {
    const server = withWallet(true);
    renderApp(server, '/', { size });
    const user = userEvent.setup();
    await user.click(await addButton());
    const form = await addForm();
    await user.click(form.getByRole('button', { name: 'Today, 8:12 PM' }));
    const date = form.getByLabelText<HTMLInputElement>('Date');
    await user.clear(date);
    await user.type(date, '2026-11-09');
    expect(form.getByRole('button', { name: 'Yesterday, 8:12 PM' })).toBeTruthy();
    await typeAmount(form, '4');
    await user.click(addSaveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    expect(server.transactions[0]).toMatchObject({ date: '2026-11-09', time: '20:12' });
  });

  test('on: the time can be changed, and is saved as changed', async () => {
    const server = withWallet(true);
    renderApp(server, '/', { size });
    const user = userEvent.setup();
    await user.click(await addButton());
    const form = await addForm();
    await user.click(form.getByRole('button', { name: 'Today, 8:12 PM' }));
    const time = form.getByLabelText<HTMLInputElement>('Time');
    expect(time.value).toBe('20:12');
    await user.clear(time);
    await user.type(time, '07:05');
    expect(form.getByRole('button', { name: 'Today, 7:05 AM' })).toBeTruthy();
    await typeAmount(form, '4');
    await user.click(addSaveButton(form));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    expect(server.transactions[0]).toMatchObject({ time: '07:05' });
  });
});

/** Offline, as the browser says; answers how to be back */
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

describe('offline', () => {
  test('an entry added with a time shows it at once, and is saved with it once back', async () => {
    const server = withWallet(true);
    renderApp(server, `/?account=${WALLET}`, { size: 'phone' });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Wallet' });
    const back = goOffline(server);
    await user.click(await addButton());
    const form = await addForm();
    await user.click(form.getByRole('button', { name: 'Today, 8:12 PM' }));
    const time = form.getByLabelText<HTMLInputElement>('Time');
    await user.clear(time);
    await user.type(time, '07:05');
    await typeAmount(form, '4');
    await user.click(addSaveButton(form));
    expect(
      await screen.findByRole('button', { name: /^Food, Food · 7:05 AM, −4\.00$/ }),
    ).toBeTruthy();
    expect(server.transactions).toHaveLength(0);

    back();
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    expect(server.transactions[0]).toMatchObject({ amountCents: 400, time: '07:05' });
    // Sent once, whatever the retries
    await settle();
    expect(server.transactions).toHaveLength(1);
  });
});

describe('entries with a time', () => {
  test('show it on Activity, and sort by it within the day (phone)', async () => {
    const server = withWallet(true);
    // Saved in this order; the times say otherwise
    seed(server, 'Breakfast', '07:05');
    seed(server, 'Dinner', '20:12');
    seed(server, 'Lunch', '12:30');
    seed(server, 'Untimed', null);
    renderApp(server, '/?activity', { size: 'phone' });
    const day = within(await screen.findByRole('list', { name: 'Today' }));
    await waitFor(() =>
      expect(day.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
        'Dinner, Food · Wallet · 8:12 PM, −7.25',
        'Lunch, Food · Wallet · 12:30 PM, −7.25',
        'Breakfast, Food · Wallet · 7:05 AM, −7.25',
        // No time: after the ones with a time, as it was saved
        'Untimed, Food · Wallet, −7.25',
      ]),
    );
  });

  test('show it on a computer, and it can be changed there', async () => {
    const server = withWallet(true);
    seed(server, 'Dinner', '20:12');
    renderApp(server, '/?activity', { size: 'desktop' });
    const pane = within(
      await screen.findByRole('complementary', { name: 'Dinner, Nov 10, 8:12 PM' }),
    );
    expect(pane.getByText('Tue, Nov 10, 8:12 PM')).toBeTruthy();
    const time = pane.getByLabelText<HTMLInputElement>('Time');
    expect(time.value).toBe('20:12');
    const user = userEvent.setup();
    await user.clear(time);
    await user.type(time, '21:40');
    await user.click(pane.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.transactions[0]).toMatchObject({ time: '21:40' }));
  });

  test('keep their time when the setting is off, and an entry without one shows none', async () => {
    const server = withWallet(false);
    seed(server, 'Dinner', '20:12');
    seed(server, 'Untimed', null);
    renderApp(server, '/?activity', { size: 'phone' });
    const day = within(await screen.findByRole('list', { name: 'Today' }));
    await waitFor(() =>
      expect(day.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
        'Dinner, Food · Wallet · 8:12 PM, −7.25',
        'Untimed, Food · Wallet, −7.25',
      ]),
    );
  });

  test("can be changed on a phone too, in the entry's sheet", async () => {
    const server = withWallet(true);
    seed(server, 'Dinner', '20:12');
    renderApp(server, '/?activity', { size: 'phone' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Dinner, / }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Dinner' }));
    const time = sheet.getByLabelText<HTMLInputElement>('Time');
    expect(time.value).toBe('20:12');
    await user.clear(time);
    await user.type(time, '21:40');
    await user.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.transactions[0]).toMatchObject({ time: '21:40' }));
  });

  test('the editor asks for a time only when the setting is on or the entry has one', async () => {
    const server = withWallet(false);
    seed(server, 'Untimed', null);
    seed(server, 'Dinner', '20:12');
    renderApp(server, '/?activity', { size: 'phone' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Untimed, / }));
    let sheet = within(await screen.findByRole('dialog', { name: 'Untimed' }));
    expect(sheet.getByLabelText('Date')).toBeTruthy();
    expect(sheet.queryByLabelText('Time')).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(await screen.findByRole('button', { name: /^Dinner, / }));
    sheet = within(await screen.findByRole('dialog', { name: 'Dinner' }));
    expect(sheet.getByLabelText<HTMLInputElement>('Time').value).toBe('20:12');
  });

  test("show it on the account's own page (phone)", async () => {
    const server = withWallet(true);
    seed(server, 'Dinner', '20:12');
    renderApp(server, `/?account=${WALLET}`, { size: 'phone' });
    expect(await screen.findByRole('button', { name: /^Dinner, Food · 8:12 PM, / })).toBeTruthy();
  });
});
