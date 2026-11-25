// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';

// Selecting many of Activity's rows by gesture, and what the selection adds up to
// (R-Activity-Select, R-Desk-Bulk). On a computer a mouse drags over rows to tick a range,
// Shift-click extends it, Ctrl- or Cmd-click ticks one, Shift with the arrows extends it from
// the focused row, and Esc lets it all go. On a phone a long press starts selecting, taps
// then tick, and Back stops. Wherever the count shows, so do the expenses, the income and
// the net of what's ticked, transfers left out and said so. Every figure and name here is
// this file's own.

setupAppTests();

beforeEach(() => {
  // Tuesday 10 November 2026, in the device's own time
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 10, 0, 0));
  return () => vi.useRealTimers();
});

const WALLET = 'a'.repeat(16);
const BANK = 'b'.repeat(16);
const categoryId = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [FOOD, TRANSPORT, SALARY] = ['Food', 'Transport', 'Salary'].map(categoryId);

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

/**
 * A Wallet and a Bank, and this month, newest first:
 *   Nov 9 "coffee" RM 4.00 Food; Nov 8 "bus" RM 2.50 Transport; Nov 7 "pay" +RM 50.00 Salary;
 *   Nov 6 "top up" RM 20.00 Wallet to Bank; Nov 5 "thai" THB 120.00, RM 15.30 Food;
 *   Nov 4 "snack" RM 1.00 Food
 */
function withSix() {
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
      openingCents: 100_000,
      position,
      archived: false,
    });
  }
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  seed(server, { date: '2026-11-04', amountCents: 100, note: 'snack' });
  seed(server, {
    date: '2026-11-05',
    amountCents: 1_530,
    note: 'thai',
    original: { currency: 'THB', cents: 12_000, rate: 0.1275, source: 'wise', at: 1 },
  });
  seed(server, {
    date: '2026-11-06',
    kind: 'transfer',
    toAccountId: BANK,
    categoryId: null,
    amountCents: 2_000,
    note: 'top up',
  });
  seed(server, {
    date: '2026-11-07',
    kind: 'income',
    categoryId: SALARY,
    amountCents: 5_000,
    note: 'pay',
  });
  seed(server, { date: '2026-11-08', amountCents: 250, categoryId: TRANSPORT, note: 'bus' });
  seed(server, { date: '2026-11-09', amountCents: 400, note: 'coffee' });
  return server;
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

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

// ---------- A computer ----------

async function openRegister(server = withSix(), path = '/?activity&kind=all') {
  renderApp(server, path, { size: 'desktop' });
  await within(await screen.findByRole('table', { name: 'Transactions' })).findByText('coffee');
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

const table = () => within(screen.getByRole('table', { name: 'Transactions' }));

/** A register row's date cell: on the row, but not on its payee button or tick box */
const cell = (note: string) => {
  const row = table().getByText(note).closest('tr');
  if (row == null) throw new Error(`No row for ${note}`);
  return row.querySelectorAll('td')[1];
};
const box = (note: string) =>
  table().getByText(note).closest('tr')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const tickedNotes = () =>
  ['coffee', 'bus', 'pay', 'top up', 'thai', 'snack'].filter((note) => box(note).checked);
/** The entry open beside the register, by its name ("coffee, Nov 9") */
const openPane = () =>
  screen
    .getAllByRole('complementary')
    .map((pane) => pane.getAttribute('aria-label') ?? '')
    .find((name) => /, Nov \d+$/.test(name)) ?? '';

const mouse = { pointerType: 'mouse', pointerId: 1, button: 0 };
const press = (note: string, y = 300) =>
  fireEvent.pointerDown(cell(note), { ...mouse, clientX: 200, clientY: y });
const moveTo = (note: string, y = 300) =>
  fireEvent.pointerMove(cell(note), { ...mouse, clientX: 200, clientY: y });
const release = (target: Element, y = 300) =>
  fireEvent.pointerUp(target, { ...mouse, clientX: 200, clientY: y });

/** The bar above the register, where the count, the totals and the actions are */
const bar = () => within(screen.getByRole('region', { name: 'Selected' }));

describe('a computer: drag to select', () => {
  test('a drag ticks the rows under it, grows and shrinks, and the release opens nothing', async () => {
    const user = await openRegister();
    expect(openPane()).toMatch(/^coffee,/);
    press('bus', 300);
    moveTo('bus', 302);
    // A couple of pixels is still a click
    expect(tickedNotes()).toEqual([]);
    moveTo('pay', 340);
    expect(tickedNotes()).toEqual(['bus', 'pay']);
    moveTo('thai', 420);
    expect(tickedNotes()).toEqual(['bus', 'pay', 'top up', 'thai']);
    expect(bar().getByText('4 selected')).toBeTruthy();
    // Dragging back shrinks it, past the start too
    moveTo('pay', 340);
    expect(tickedNotes()).toEqual(['bus', 'pay']);
    moveTo('coffee', 260);
    expect(tickedNotes()).toEqual(['coffee', 'bus']);
    release(cell('coffee'), 260);
    fireEvent.click(cell('coffee'));
    expect(tickedNotes()).toEqual(['coffee', 'bus']);
    expect(openPane()).toMatch(/^coffee,/);
    // The bulk actions act on what was dragged over
    await user.click(bar().getByRole('button', { name: 'Delete 2' }));
    expect(await screen.findByText('Deleted 2 entries')).toBeTruthy();
    await waitFor(() => expect(table().queryByText('bus')).toBeNull());
  });

  test('a plain click, with no movement, opens the row as before and ticks nothing', async () => {
    await openRegister();
    press('bus');
    release(cell('bus'));
    fireEvent.click(cell('bus'));
    expect(openPane()).toMatch(/^bus,/);
    expect(tickedNotes()).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Selected' })).toBeNull();
  });

  test('a drag from a row already ticked keeps what was ticked and adds the range', async () => {
    const user = await openRegister();
    await user.click(box('snack'));
    await user.click(box('bus'));
    press('bus');
    moveTo('pay', 340);
    moveTo('top up', 380);
    expect(tickedNotes()).toEqual(['bus', 'pay', 'top up', 'snack']);
    // Shrinking back over where it started never takes off what was ticked before
    moveTo('coffee', 260);
    expect(tickedNotes()).toEqual(['coffee', 'bus', 'snack']);
    release(cell('coffee'), 260);
    expect(tickedNotes()).toEqual(['coffee', 'bus', 'snack']);
  });

  test('a drag starts on the row, not on its payee, category or tick box', async () => {
    await openRegister();
    const payee = table().getByRole('button', { name: 'bus' });
    fireEvent.pointerDown(payee, { ...mouse, clientX: 200, clientY: 300 });
    moveTo('pay', 340);
    release(cell('pay'), 340);
    fireEvent.pointerDown(box('bus'), { ...mouse, clientX: 20, clientY: 300 });
    moveTo('pay', 340);
    release(cell('pay'), 340);
    expect(tickedNotes()).toEqual([]);
  });

  test('released outside the list, the drag ends there; no text is selected while dragging', async () => {
    await openRegister();
    const selectStart = () => {
      const e = new Event('selectstart', { bubbles: true, cancelable: true });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    };
    press('coffee', 260);
    moveTo('bus', 300);
    expect(selectStart()).toBe(true);
    release(document.body, 900);
    expect(selectStart()).toBe(false);
    moveTo('thai', 420);
    expect(tickedNotes()).toEqual(['coffee', 'bus']);
  });

  test('near the bottom or top edge the page scrolls by itself, and stops on release', async () => {
    await openRegister();
    const scrolled: number[] = [];
    const scrollBy = vi
      .spyOn(window, 'scrollBy')
      .mockImplementation((_x: number, y: number) => void scrolled.push(y));
    onTestFinished(() => scrollBy.mockRestore());
    press('coffee', 400);
    moveTo('bus', 795);
    await wait(100);
    expect(scrolled.length).toBeGreaterThan(1);
    expect(scrolled.every((y) => y > 0)).toBe(true);
    scrolled.length = 0;
    moveTo('coffee', 4);
    await wait(100);
    expect(scrolled.length).toBeGreaterThan(1);
    expect(scrolled.every((y) => y < 0)).toBe(true);
    moveTo('bus', 400);
    await wait(50);
    scrolled.length = 0;
    await wait(100);
    expect(scrolled).toEqual([]);
    moveTo('thai', 795);
    release(cell('thai'), 795);
    scrolled.length = 0;
    await wait(100);
    expect(scrolled).toEqual([]);
  });
});

describe('a computer: clicks and keys', () => {
  test('Shift-click ticks from the last row picked; Ctrl- or Cmd-click ticks or unticks one', async () => {
    const user = await openRegister();
    await user.click(cell('coffee'));
    expect(openPane()).toMatch(/^coffee,/);
    await user.keyboard('{Shift>}');
    await user.click(cell('pay'));
    expect(tickedNotes()).toEqual(['coffee', 'bus', 'pay']);
    // From the same row again, it shrinks
    await user.click(cell('bus'));
    await user.keyboard('{/Shift}');
    expect(tickedNotes()).toEqual(['coffee', 'bus']);
    await user.keyboard('{Control>}');
    await user.click(cell('snack'));
    await user.click(cell('bus'));
    await user.keyboard('{/Control}');
    expect(tickedNotes()).toEqual(['coffee', 'snack']);
    await user.keyboard('{Meta>}');
    await user.click(cell('thai'));
    await user.keyboard('{/Meta}');
    expect(tickedNotes()).toEqual(['coffee', 'thai', 'snack']);
    // None of them opened another row
    expect(openPane()).toMatch(/^coffee,/);
    // Shift-click carries on from the last one Ctrl-clicked
    await user.keyboard('{Shift>}');
    await user.click(cell('top up'));
    await user.keyboard('{/Shift}');
    expect(tickedNotes()).toEqual(['coffee', 'top up', 'thai', 'snack']);
  });

  test('Shift with the arrows extends from the focused row; Esc lets the selection go', async () => {
    const user = await openRegister();
    table().getByRole('button', { name: 'bus' }).focus();
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(tickedNotes()).toEqual(['bus', 'pay']);
    expect(document.activeElement).toBe(table().getByRole('button', { name: 'pay' }));
    await user.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}');
    expect(tickedNotes()).toEqual(['bus', 'pay', 'top up', 'thai']);
    await user.keyboard('{Shift>}{ArrowUp}{/Shift}');
    expect(tickedNotes()).toEqual(['bus', 'pay', 'top up']);
    await user.keyboard('{Escape}');
    expect(tickedNotes()).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Selected' })).toBeNull();
  });
});

describe('what the selection adds up to', () => {
  test('a computer: expenses, income and net in their colours, transfers left out and said so, live as a drag grows', async () => {
    await openRegister();
    press('coffee', 260);
    moveTo('bus', 300);
    expect(bar().getByText('2 selected')).toBeTruthy();
    hasLine('Expenses RM 6.50');
    hasLine('Net −RM 6.50');
    moveTo('thai', 420);
    // Expense 1 with expense 2 and income 1 (and a transfer, and one typed in baht)
    expect(bar().getByText('5 selected')).toBeTruthy();
    hasLine('Expenses RM 21.80');
    hasLine('Income RM 50.00');
    hasLine('Net +RM 28.20');
    hasLine('1 transfer not counted');
    expect(lines('RM 21.80')[0].getAttribute('data-kind')).toBe('expense');
    expect(lines('RM 50.00')[0].getAttribute('data-kind')).toBe('income');
    release(cell('thai'), 420);
  });

  test('the count and net are announced once the selection settles, not row by row', async () => {
    await openRegister();
    const said = () => document.querySelector('[aria-live="polite"][data-selection]')?.textContent;
    press('coffee', 260);
    moveTo('bus', 300);
    moveTo('pay', 340);
    await wait(800);
    expect(said()).toBe('');
    release(cell('pay'), 340);
    await waitFor(() => expect(said()).toBe('3 selected. Net +RM 43.50'));
  });

  test('Select all across pages counts every one found, loaded or not', async () => {
    const server = withSix();
    for (let i = 0; i < 230; i++) {
      seed(server, { date: '2026-10-01', amountCents: 100, note: `older ${i}` });
    }
    const user = await openRegister(server, '/?activity&kind=all&dates=all');
    await user.click(screen.getByRole('button', { name: 'Select all 236' }));
    expect(await screen.findByText('236 selected', undefined, { timeout: 10_000 })).toBeTruthy();
    hasLine('Expenses RM 252.80');
    hasLine('Income RM 50.00');
    hasLine('Net −RM 202.80');
    hasLine('1 transfer not counted');
  });
});

// ---------- A phone ----------

async function openList(server = withSix()) {
  renderApp(server, '/?activity&kind=all', { size: 'phone' });
  await screen.findByRole('heading', { name: 'Activity', level: 1 });
  await screen.findByRole('button', { name: /^coffee, / });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

const finger = { pointerType: 'touch', pointerId: 7, clientX: 100, clientY: 300 };
const row = (note: string) =>
  screen.getByRole(screen.queryByRole('heading', { name: /selected$/ }) ? 'checkbox' : 'button', {
    name: new RegExp(`^${note}, `),
  });

/**
 * Done, waiting for Back to take selecting's step off the history, so the next test opens
 * where it asks
 */
async function done(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Done' }));
  await screen.findByRole('button', { name: 'Select' });
}

describe('a phone: hold to select', () => {
  test('a long press ticks the row with a light buzz; its release is not a tap', async () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    onTestFinished(() => void Reflect.deleteProperty(navigator, 'vibrate'));
    await openList();
    const bus = row('bus');
    fireEvent.pointerDown(bus, finger);
    await wait(300);
    expect(screen.queryByRole('heading', { name: /selected$/ })).toBeNull();
    await wait(250);
    fireEvent.pointerUp(bus, finger);
    expect(await screen.findByRole('heading', { name: '1 selected' })).toBeTruthy();
    expect(vibrate).toHaveBeenCalledWith(10);
    expect(row('bus')).toHaveProperty('checked', true);
    expect(screen.queryByRole('dialog')).toBeNull();
    await done(userEvent.setup({ advanceTimers: vi.advanceTimersByTime }));
  });

  test('a short tap opens the entry; moving like a scroll never selects', async () => {
    const user = await openList();
    fireEvent.pointerDown(row('bus'), finger);
    fireEvent.pointerMove(row('bus'), { ...finger, clientY: 315 });
    await wait(600);
    fireEvent.pointerUp(row('bus'), { ...finger, clientY: 315 });
    expect(screen.queryByRole('heading', { name: /selected$/ })).toBeNull();
    // A finger dragged over rows doesn't tick them either (a touch stays with the row it
    // started on)
    fireEvent.pointerDown(row('coffee'), finger);
    fireEvent.pointerMove(row('coffee'), { ...finger, clientY: 400 });
    await wait(600);
    fireEvent.pointerUp(row('coffee'), { ...finger, clientY: 400 });
    expect(screen.queryByRole('heading', { name: /selected$/ })).toBeNull();

    await user.click(row('bus'));
    expect(await screen.findByRole('dialog', { name: 'bus' })).toBeTruthy();
  });

  test('selecting, taps tick and untick; the bar sums them and opens to the breakdown', async () => {
    const user = await openList();
    fireEvent.pointerDown(row('coffee'), finger);
    await wait(550);
    fireEvent.pointerUp(row('coffee'), finger);
    await screen.findByRole('heading', { name: '1 selected' });
    await user.click(row('bus'));
    await user.click(row('pay'));
    await user.click(row('top up'));
    await user.click(row('pay'));
    expect(screen.getByRole('heading', { name: '3 selected' })).toBeTruthy();
    const summary = within(screen.getByRole('region', { name: 'Selected' })).getByRole('button', {
      name: '3 selected · Net −RM 6.50 · 1 transfer not counted',
    });
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(lines('Expenses RM 6.50')).toEqual([]);
    await user.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    hasLine('Expenses RM 6.50');
    hasLine('Income RM 0.00');
    hasLine('Net −RM 6.50');
    // The actions are still there, and act on what's ticked
    await user.click(screen.getByRole('button', { name: 'Delete 3' }));
    expect(await screen.findByText('Deleted 3 entries')).toBeTruthy();
    await done(user);
  });

  test('Back stops selecting first, and Done leaves no step behind for Back', async () => {
    const user = await openList();
    fireEvent.pointerDown(row('coffee'), finger);
    await wait(550);
    fireEvent.pointerUp(row('coffee'), finger);
    await screen.findByRole('heading', { name: '1 selected' });
    act(() => window.history.back());
    expect(await screen.findByRole('button', { name: 'Select' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /selected$/ })).toBeNull();
    expect(window.location.search).not.toMatch(/select/);
    expect(screen.getByRole('heading', { name: 'Activity', level: 1 })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Select' }));
    await screen.findByRole('heading', { name: '0 selected' });
    await done(user);
    await wait(50);
    expect(screen.queryByRole('heading', { name: /selected$/ })).toBeNull();
    expect(window.location.search).not.toMatch(/select/);
  });
});
