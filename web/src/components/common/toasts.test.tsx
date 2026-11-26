// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { navigate } from '../../hooks/useRoute';
import { fakeServer, goToPlace, renderApp, settle, setupAppTests } from '../../testing/app';

// The app's messages (toasts): "Deleted 1 entry" with Undo, a refusal, a note that
// something was done. Each can be put away before it goes by itself: its Dismiss button,
// a swipe sideways or down, or Esc. Putting away an Undo leaves the change made, as
// letting it go does. The same message again adds up in the one already showing, never
// two copies, and at most two show at once. They sit above whatever is fixed at the foot
// of the screen (the tab bar, a phone's selection bar). Every figure and name here is
// this file's own.

setupAppTests();

const WALLET = 'a'.repeat(16);
const categoryId = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [OTHER, FOOD] = ['Other', 'Food'].map(categoryId);

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

/** A Wallet with three made-up expenses this month: "kiosk", "tram" and "bakery" */
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
  seed(server, { date: '2026-11-03', amountCents: 300, note: 'kiosk' });
  seed(server, { date: '2026-11-04', amountCents: 450, note: 'tram' });
  seed(server, { date: '2026-11-05', amountCents: 725, categoryId: FOOD, note: 'bakery' });
  return server;
}

/** Adds a made-up income this month, "refund" */
function withRefund(server: FakeServer) {
  seed(server, {
    kind: 'income',
    amountCents: 5_000,
    categoryId: DEFAULT_CATEGORIES.find((c) => c.kind === 'income')!.id,
    note: 'refund',
    date: '2026-11-06',
  });
}

type Size = 'phone' | 'desktop';
type User = ReturnType<typeof userEvent.setup>;

/** Opens Activity; a phone starts selecting */
async function openActivity(server: FakeServer, size: Size) {
  renderApp(server, '/?activity&dates=all', { size });
  await screen.findByRole('heading', { name: 'Activity', level: 1 });
  await screen.findAllByText(/bakery/);
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  if (size === 'phone') await user.click(screen.getByRole('button', { name: 'Select' }));
  return user;
}

/** A row's tick box: its line in the register, or its name on a phone */
function tick(note: string) {
  const box = screen
    .queryAllByRole('checkbox')
    .find((b) =>
      b.closest('tr') != null
        ? (b.closest('tr')?.textContent ?? '').includes(note)
        : (b.getAttribute('aria-label') ?? '').startsWith(`${note}, `),
    );
  if (box == null) throw new Error(`No tick box for ${note}`);
  return box;
}

/** Ticks `note` and deletes what's ticked */
async function deleteOne(user: User, note: string) {
  await user.click(tick(note));
  await user.click(screen.getByRole('button', { name: 'Delete 1' }));
}

const toasts = () => screen.queryAllByRole('alert');
const toastWith = (text: string) => {
  const found = toasts().find((t) => t.textContent?.includes(text));
  if (found == null) throw new Error(`No toast saying ${text}`);
  return found;
};

const finger = { pointerType: 'touch', pointerId: 3, isPrimary: true };
function swipe(el: HTMLElement, dx: number, dy = 0) {
  fireEvent.pointerDown(el, { ...finger, clientX: 100, clientY: 700 });
  fireEvent.pointerMove(el, { ...finger, clientX: 100 + dx / 2, clientY: 700 + dy / 2 });
  fireEvent.pointerMove(el, { ...finger, clientX: 100 + dx, clientY: 700 + dy });
}
const release = (el: HTMLElement, dx: number, dy = 0) =>
  fireEvent.pointerUp(el, { ...finger, clientX: 100 + dx, clientY: 700 + dy });

/** Seconds of the message's clock, skipped */
function skippableClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  onTestFinished(() => void vi.useRealTimers());
}

describe('putting a message away', () => {
  test.each(['phone', 'desktop'] as const)(
    'Dismiss hides Undo and the delete stands, as when it times out (%s)',
    async (size) => {
      skippableClock();
      const server = withSpending();
      const user = await openActivity(server, size);
      await deleteOne(user, 'tram');
      const toast = await screen.findByRole('alert');
      expect(toast.textContent).toContain('Deleted 1 entry');
      await waitFor(() => expect(server.transactions).toHaveLength(2));
      const dismiss = within(toast).getByRole('button', { name: 'Dismiss' });
      await user.click(dismiss);
      await waitFor(() => expect(toasts()).toEqual([]));
      // Long past when Undo would have gone: nothing came back, nothing was undone
      await act(() => vi.advanceTimersByTimeAsync(7_000));
      await settle();
      expect(server.transactions.map((t) => t.note).sort()).toEqual(['bakery', 'kiosk']);
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    },
  );

  test('a refusal has Dismiss too, and only that', async () => {
    const server = withSpending();
    withRefund(server);
    const user = await openActivity(server, 'desktop');
    await user.click(tick('refund'));
    await user.click(tick('tram'));
    await user.click(screen.getByRole('button', { name: 'Change category' }));
    const toast = toastWith('Pick only spending, or only income');
    expect(
      within(toast)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Dismiss']);
    await user.click(within(toast).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(toasts()).toEqual([]));
  });

  test('a swipe past the threshold flies it out; short of it, it snaps back', async () => {
    skippableClock();
    const server = withSpending();
    const user = await openActivity(server, 'phone');
    await deleteOne(user, 'tram');
    const toast = await screen.findByRole('alert');

    // Following the finger, then back where it was when let go early
    swipe(toast, 24);
    expect(toast.style.transform).toMatch(/translate(3d|X)?\(24px/);
    // Held a moment, so it's no flick
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    release(toast, 24);
    expect(toast.style.transform).toMatch(/^(translate(3d|X)?\(0(px)?[,)].*|)$/);
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(toasts()).toHaveLength(1);
    // Moving up isn't a swipe away
    swipe(toast, 0, -120);
    release(toast, 0, -120);
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(toasts()).toHaveLength(1);

    // Far enough to the left: off it goes, and the delete stands
    swipe(toast, -160);
    release(toast, -160);
    await act(() => vi.advanceTimersByTimeAsync(400));
    await waitFor(() => expect(toasts()).toEqual([]));
    await settle();
    expect(server.transactions.map((t) => t.note).sort()).toEqual(['bakery', 'kiosk']);
  });

  test('a swipe down puts it away too', async () => {
    skippableClock();
    const server = withSpending();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await goToPlace('Activity');
    await screen.findAllByText(/bakery/);
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await deleteOne(user, 'kiosk');
    const toast = await screen.findByRole('alert');
    swipe(toast, 0, 90);
    release(toast, 0, 90);
    await act(() => vi.advanceTimersByTimeAsync(400));
    await waitFor(() => expect(toasts()).toEqual([]));
  });

  test('Esc puts away the newest message first, then lets go of what is ticked', async () => {
    const server = withSpending();
    const user = await openActivity(server, 'desktop');
    await deleteOne(user, 'tram');
    await screen.findByRole('alert');
    // In the search box, Esc is the field's own
    const search = screen.getByRole('searchbox', { name: 'Search' });
    search.focus();
    await user.keyboard('{Escape}');
    expect(toasts()).toHaveLength(1);
    search.blur();
    await user.click(tick('kiosk'));
    expect(screen.getByText('1 selected')).toBeTruthy();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(toasts()).toEqual([]));
    expect(screen.getByText('1 selected')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull());
    expect(tick('kiosk')).toHaveProperty('checked', false);
    await settle();
    expect(server.transactions).toHaveLength(2);
  });
});

describe('the same message again', () => {
  test('two deletes in a row show one "Deleted 2 entries", and Undo brings back both', async () => {
    const server = withSpending();
    const user = await openActivity(server, 'desktop');
    await deleteOne(user, 'tram');
    await screen.findByText('Deleted 1 entry');
    await deleteOne(user, 'kiosk');
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    expect(await screen.findByText('Deleted 2 entries')).toBeTruthy();
    expect(toasts()).toHaveLength(1);
    expect(screen.queryByText('Deleted 1 entry')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(server.transactions.map((t) => t.note).sort()).toEqual(['bakery', 'kiosk', 'tram']),
    );
    await waitFor(() => expect(toasts()).toEqual([]));
  });

  test('at most two show; an older one waits, and shows again once a newer is put away', async () => {
    const server = withSpending();
    withRefund(server);
    const user = await openActivity(server, 'desktop');
    await deleteOne(user, 'tram');
    await screen.findByText('Deleted 1 entry');
    await user.click(tick('bakery'));
    await user.click(screen.getByRole('button', { name: 'Change category' }));
    const sheet = within(await screen.findByRole('dialog'));
    await user.click(
      within(sheet.getByRole('radiogroup', { name: 'Move to' })).getByRole('radio', {
        name: 'Transport',
      }),
    );
    await user.click(sheet.getByRole('button', { name: 'Move 1 to Transport' }));
    await screen.findByText('Moved 1 to Transport');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // A third: spending with income can't move together
    await user.click(tick('refund'));
    await user.click(tick('kiosk'));
    await user.click(screen.getByRole('button', { name: 'Change category' }));
    await screen.findByText(/Pick only spending, or only income/);
    expect(toasts()).toHaveLength(2);
    expect(screen.queryByText('Deleted 1 entry')).toBeNull();

    // Put away, the refusal makes room: the Undo waiting comes back, and still works
    await user.click(
      within(toastWith('Pick only spending')).getByRole('button', { name: 'Dismiss' }),
    );
    expect(await screen.findByText('Deleted 1 entry')).toBeTruthy();
    expect(toasts()).toHaveLength(2);
    await user.click(within(toastWith('Deleted 1 entry')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(server.transactions.some((t) => t.note === 'tram')).toBe(true));
  });
});

/** Says where elements are drawn, as a browser would: each `height` px tall at the foot */
function atFoot(...bars: [match: (el: Element) => boolean, height: number][]) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its element below
  const real = Element.prototype.getBoundingClientRect;
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    const bar = bars.find(([match]) => match(this));
    if (bar == null) return real.call(this);
    const height = bar[1];
    const top = window.innerHeight - height;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height,
      toJSON: () => ({}),
    };
  });
  onTestFinished(() => spy.mockRestore());
}

/** How high above the foot of the screen the messages start, as drawn */
const toastsBottom = () => {
  const stack = toasts()[0].parentElement!;
  return parseFloat(stack.style.bottom);
};

describe('never over the controls', () => {
  test("a phone's toast sits above the selection bar, and above the tab bar once it is back", async () => {
    atFoot(
      [(el) => el.getAttribute('aria-label') === 'Selected', 150],
      [(el) => el.tagName === 'NAV' && el.getAttribute('aria-label') === 'Main', 84],
    );
    const server = withSpending();
    const user = await openActivity(server, 'phone');
    // A move leaves the phone selecting, with its bar at the foot
    await user.click(tick('kiosk'));
    await user.click(screen.getByRole('button', { name: 'Change category' }));
    const sheet = within(await screen.findByRole('dialog'));
    await user.click(
      within(sheet.getByRole('radiogroup', { name: 'Move to' })).getByRole('radio', {
        name: 'Food',
      }),
    );
    await user.click(sheet.getByRole('button', { name: 'Move 1 to Food' }));
    await screen.findByText('Moved 1 to Food');
    expect(screen.getByRole('region', { name: 'Selected' })).toBeTruthy();
    await waitFor(() => expect(toastsBottom()).toBeGreaterThanOrEqual(150 + 8));

    // Deleting ends selecting: the tab bar is back, and the toasts come down to sit on it
    await deleteOne(user, 'tram');
    await screen.findByText('Deleted 1 entry');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selected' })).toBeNull());
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    await waitFor(() => expect(toastsBottom()).toBeLessThan(150));
    expect(toastsBottom()).toBeGreaterThanOrEqual(84 + 8);
  });
});

describe('deleting what was ticked, selecting on a phone', () => {
  test('leaves selecting, through Back, so no step is left behind', async () => {
    const server = withSpending();
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await screen.findByRole('heading', { name: 'Accounts', level: 1 });
    // Opened from Accounts with a step of its own, as a link opens it
    act(() => navigate('?activity&dates=all'));
    await screen.findAllByText(/bakery/);
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await screen.findByRole('heading', { name: '0 selected' });
    await user.click(tick('kiosk'));
    await user.click(tick('tram'));
    await user.click(tick('bakery'));
    await user.click(screen.getByRole('button', { name: 'Delete 3' }));
    expect(await screen.findByText('Deleted 3 entries')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Select' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /selected$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete / })).toBeNull();
    expect(window.location.search).not.toMatch(/select/);
    // One Back leaves Activity: selecting kept no step of its own
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe('?accounts'));
    await settle();
    expect(server.transactions).toEqual([]);
  });
});
