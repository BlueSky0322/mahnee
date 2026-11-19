// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Recurring } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, renderApp, settle, setupAppTests } from '../../testing/app';

// Settings › Money (R-Set-Money, R-Desk-Prefs; design digest 3.12, owner decision D7):
// when the month starts and the week starts, saved through the profile (at once, undone
// with a message when the save fails). "Month starts on" opens a sheet on phones (Done
// keeps the choice; Back keeps nothing) and a panel beside its row on computers (Cancel,
// Done): "A date" (1 to 28, or "Last day of the month") or "Payday" (the scheduled pay's
// day), with a preview of this month's days. The row reads "The 1st", "The 25th", "Last
// day" or "Payday". Main currency is in HomeCurrency.test.tsx; "Other
// currencies" is hidden (D4).

const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'Asia/Kuala_Lumpur';
afterAll(() => {
  process.env.TZ = TZ_BEFORE;
});

setupAppTests();

const SIZES = ['phone', 'desktop'] as const;
const WALLET = 'a'.repeat(16);
const SALARY = DEFAULT_CATEGORIES.find((c) => c.name === 'Salary')!.id;
const FREELANCE = DEFAULT_CATEGORIES.find((c) => c.kind === 'income' && c.name !== 'Salary')!;
const BILLS = DEFAULT_CATEGORIES.find((c) => c.name === 'Bills')!.id;

/** The clock reads noon on 10 November 2026 where the person is, and still ticks */
function onNovember(day = 10) {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, day, 12, 0, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

const scheduled = (id: string, more: Partial<Recurring>): Recurring => ({
  id,
  kind: 'income',
  accountId: WALLET,
  toAccountId: null,
  amountCents: 680_000,
  categoryId: SALARY,
  payee: 'Acme Sdn Bhd',
  schedule: 'monthly',
  day: 25,
  startDate: '2026-01-25',
  nextDue: '2026-11-25',
  archived: false,
  ...more,
});

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
  return server;
}

/** Wallet, with the pay on the 25th and a side job on the 3rd; a weekly pay, a stopped one and a bill, none of which can start a month */
function withPays(): FakeServer {
  const server = withWallet();
  server.recurring.push(
    scheduled('1'.repeat(16), {}),
    scheduled('2'.repeat(16), {
      categoryId: FREELANCE.id,
      payee: null,
      day: 3,
      nextDue: '2026-12-03',
    }),
    scheduled('3'.repeat(16), { schedule: 'weekly', day: 5, nextDue: '2026-11-13' }),
    scheduled('4'.repeat(16), { payee: 'Old Job', archived: true }),
    scheduled('5'.repeat(16), { kind: 'expense', categoryId: BILLS, payee: 'TNB', day: 20 }),
  );
  return server;
}

/** The Money card, once its rows show */
const moneyCard = () => screen.findByRole('region', { name: 'Money' });

/** The row's button that opens when the month starts, reading its value */
const monthButton = async () =>
  within(await moneyCard()).findByRole('button', { name: /^Month starts on/ });

/** Opens "Month starts on": a sheet on a phone, a panel on a computer */
async function openMonth() {
  const user = userEvent.setup();
  await user.click(await monthButton());
  const dialog = await screen.findByRole('dialog', { name: 'Month starts on' });
  return { user, dialog: within(dialog), element: dialog };
}

const checked = (group: HTMLElement) =>
  within(group)
    .getAllByRole('radio')
    .filter((r) => r.getAttribute('aria-checked') === 'true')
    .map((r) => r.textContent);

/** "This month" and its days, as the preview reads */
const preview = (dialog: ReturnType<typeof within>) =>
  dialog.getByText('This month').parentElement!.textContent!.replace(/\s+/g, ' ').trim();

describe('Settings › Money', () => {
  test.each(SIZES)(
    'lists when the month and the week start, as the person has them (%s)',
    async (size) => {
      const server = withWallet();
      server.me.settings = { ...server.me.settings, monthStartDay: 25, weekStart: 'sunday' };
      renderApp(server, '/?settings=money', { size });
      expect(await screen.findByRole('heading', { level: 1, name: 'Money' })).toBeTruthy();
      const card = await moneyCard();
      expect(within(card).getByText('When budgets reset')).toBeTruthy();
      expect(within(card).getByText('For the calendar on Home')).toBeTruthy();
      expect((await monthButton()).textContent).toContain('The 25th');
      const week = within(card).getByRole('radiogroup', { name: 'Week starts on' });
      expect(
        within(week)
          .getAllByRole('radio')
          .map((r) => r.textContent),
      ).toEqual(['Monday', 'Sunday']);
      expect(checked(week)).toEqual(['Sunday']);
      // Other currencies, under the main one (other-currencies.test.tsx)
      expect(within(card).getByText('Other currencies')).toBeTruthy();
      // Still found by a search, with the row in view
      expect(card.querySelector('[data-setting="monthStart"]')).not.toBeNull();
      expect(card.querySelector('[data-setting="weekStart"]')).not.toBeNull();
    },
  );

  test.each(SIZES)(
    'picks a day of the month, previewing this month, and keeps it with Done (%s)',
    async (size) => {
      onNovember(10);
      const server = withWallet();
      renderApp(server, '/?settings=money', { size });
      expect((await monthButton()).textContent).toContain('The 1st');
      const { user, dialog } = await openMonth();
      const how = dialog.getByRole('radiogroup', { name: 'How the month starts' });
      expect(
        within(how)
          .getAllByRole('radio')
          .map((r) => r.textContent),
      ).toEqual(['A date', 'Payday']);
      expect(checked(how)).toEqual(['A date']);
      const days = dialog.getByRole('radiogroup', { name: 'Day of the month' });
      const names = within(days)
        .getAllByRole('radio')
        .map((r) => r.textContent);
      expect(names).toEqual([
        ...Array.from({ length: 28 }, (_, i) => String(i + 1)),
        'Last day of the month',
      ]);
      expect(checked(days)).toEqual(['1']);
      expect(preview(dialog)).toBe('This month Nov 1 to Nov 30');

      await user.click(within(days).getByRole('radio', { name: '25' }));
      expect(checked(days)).toEqual(['25']);
      expect(preview(dialog)).toBe('This month Oct 25 to Nov 24');
      // Nothing saved until Done
      expect(server.me.settings.monthStartDay).toBe(1);

      await user.click(dialog.getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect((await monthButton()).textContent).toContain('The 25th');
      await waitFor(() =>
        expect(server.me.settings).toMatchObject({ monthStartMode: 'date', monthStartDay: 25 }),
      );
    },
  );

  test.each(SIZES)("starts each month on its last day, read as 'Last day' (%s)", async (size) => {
    onNovember(10);
    const server = withWallet();
    renderApp(server, '/?settings=money', { size });
    const { user, dialog } = await openMonth();
    await user.click(dialog.getByRole('radio', { name: 'Last day of the month' }));
    expect(preview(dialog)).toBe('This month Oct 31 to Nov 29');
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    expect((await monthButton()).textContent).toContain('Last day');
    await waitFor(() => expect(server.me.settings.monthStartDay).toBe(31));
  });

  test('reads each day as written: the 2nd, 11th, 22nd and 23rd', async () => {
    onNovember(10);
    const server = withWallet();
    renderApp(server, '/?settings=money', { size: 'phone' });
    for (const [day, value] of [
      ['2', 'The 2nd'],
      ['11', 'The 11th'],
      ['22', 'The 22nd'],
      ['23', 'The 23rd'],
    ]) {
      const { user, dialog } = await openMonth();
      await user.click(dialog.getByRole('radio', { name: day }));
      await user.click(dialog.getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect((await monthButton()).textContent).toContain(value);
      await waitFor(() => expect(server.me.settings.monthStartDay).toBe(Number(day)));
    }
  });

  test('on a computer, Esc closes the panel and keeps the month as it was', async () => {
    onNovember(10);
    const server = withWallet();
    renderApp(server, '/?settings=money', { size: 'desktop' });
    const { user, dialog } = await openMonth();
    await user.click(dialog.getByRole('radio', { name: '15' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Settings stays open: Esc was the panel's
    expect(screen.getByRole('heading', { level: 1, name: 'Money' })).toBeTruthy();
    expect((await monthButton()).textContent).toContain('The 1st');
    await settle();
    expect(server.me.settings.monthStartDay).toBe(1);
  });

  test("a pay on the 31st starts each month on its last day (the pay's own words are the builder's, for review)", async () => {
    onNovember(10);
    const server = withWallet();
    server.recurring.push(scheduled('6'.repeat(16), { day: 31, nextDue: '2026-11-30' }));
    renderApp(server, '/?settings=money', { size: 'phone' });
    const { user, dialog } = await openMonth();
    await user.click(dialog.getByRole('radio', { name: 'Payday' }));
    expect(dialog.getByRole('button', { name: /^Salary · Acme Sdn Bhd · the 31st/ })).toBeTruthy();
    expect(preview(dialog)).toBe('This month Oct 31 to Nov 29');
  });

  test('on a computer, a click outside the panel closes it and keeps the month as it was', async () => {
    onNovember(10);
    const server = withWallet();
    renderApp(server, '/?settings=money');
    const { user, dialog, element } = await openMonth();
    await user.click(dialog.getByRole('radio', { name: '25' }));
    await user.click(screen.getByRole('heading', { level: 1, name: 'Money' }));
    await waitFor(() => expect(element.isConnected).toBe(false));
    expect(screen.queryByRole('dialog', { name: 'Month starts on' })).toBeNull();
    expect((await monthButton()).textContent).toContain('The 1st');
    await settle();
    expect(server.me.settings.monthStartDay).toBe(1);
  });

  test('on a computer, Cancel keeps the month as it was', async () => {
    onNovember(10);
    const server = withWallet();
    renderApp(server, '/?settings=money', { size: 'desktop' });
    const button = await monthButton();
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const { user, dialog } = await openMonth();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await user.click(dialog.getByRole('radio', { name: '15' }));
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(button.textContent).toContain('The 1st');
    await settle();
    expect(server.me.settings.monthStartDay).toBe(1);
  });

  test('on a phone, Back closes the sheet and keeps the month as it was', async () => {
    onNovember(10);
    const server = withWallet();
    renderApp(server, '/?settings=money', { size: 'phone' });
    const { user, dialog } = await openMonth();
    await user.click(dialog.getByRole('radio', { name: '15' }));
    window.history.back();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.search).toBe('?settings=money');
    expect((await monthButton()).textContent).toContain('The 1st');
    await settle();
    expect(server.me.settings.monthStartDay).toBe(1);
  });

  test.each(SIZES)(
    "starts the month on payday, from the pay's day in Scheduled (%s)",
    async (size) => {
      onNovember(10);
      const server = withPays();
      renderApp(server, '/?settings=money', { size });
      const { user, dialog } = await openMonth();
      await user.click(dialog.getByRole('radio', { name: 'Payday' }));
      expect(dialog.queryByRole('radiogroup', { name: 'Day of the month' })).toBeNull();
      expect(dialog.getByText('Starts when your pay lands')).toBeTruthy();
      expect(dialog.getByText('Your pay')).toBeTruthy();
      // The first running monthly pay, until another is picked
      const yourPay = dialog.getByRole('button', { name: /^Salary · Acme Sdn Bhd · the 25th/ });
      const scheduledLink = dialog.getByRole('link', { name: 'Plan › Scheduled' });
      expect(scheduledLink.getAttribute('href')).toBe('?plan=scheduled');
      expect(scheduledLink.parentElement!.textContent).toBe('From Salary in Plan › Scheduled');
      expect(preview(dialog)).toBe('This month Oct 25 to Nov 24');

      // Only running monthly income can start a month
      await user.click(yourPay);
      const offered = await screen.findAllByRole('menuitem');
      expect(offered.map((o) => o.textContent)).toEqual([
        'Salary · Acme Sdn Bhd · the 25th',
        `${FREELANCE.name} · the 3rd`,
      ]);
      await user.click(offered[1]);
      expect(dialog.getByRole('button', { name: `${FREELANCE.name} · the 3rd` })).toBeTruthy();
      expect(preview(dialog)).toBe('This month Nov 3 to Dec 2');

      await user.click(dialog.getByRole('button', { name: 'Done' }));
      expect((await monthButton()).textContent).toContain('Payday');
      await waitFor(() =>
        expect(server.me.settings).toMatchObject({
          monthStartMode: 'payday',
          monthStartPayId: '2'.repeat(16),
          monthStartDay: 1,
        }),
      );
    },
  );

  // "No pay is scheduled yet." and a pay with no payee read "Other income · the 3rd" are
  // copy the boards don't draw, for the owner's review
  test('with no pay scheduled, Payday says where to add one and Done keeps the date', async () => {
    onNovember(10);
    const server = withWallet();
    server.me.settings = { ...server.me.settings, monthStartDay: 5 };
    renderApp(server, '/?settings=money', { size: 'phone' });
    const { user, dialog } = await openMonth();
    await user.click(dialog.getByRole('radio', { name: 'Payday' }));
    expect(dialog.getByText('No pay is scheduled yet.')).toBeTruthy();
    expect(dialog.getByRole('link', { name: 'Plan › Scheduled' }).getAttribute('href')).toBe(
      '?plan=scheduled',
    );
    expect(dialog.queryByText('This month')).toBeNull();
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await monthButton()).textContent).toContain('The 5th');
    await settle();
    expect(server.me.settings).toMatchObject({ monthStartMode: 'date', monthStartDay: 5 });
  });

  test('opens on the choice saved: payday with its pay', async () => {
    onNovember(10);
    const server = withPays();
    server.me.settings = {
      ...server.me.settings,
      monthStartMode: 'payday',
      monthStartPayId: '2'.repeat(16),
    };
    renderApp(server, '/?settings=money', { size: 'phone' });
    expect((await monthButton()).textContent).toContain('Payday');
    const { dialog } = await openMonth();
    expect(checked(dialog.getByRole('radiogroup', { name: 'How the month starts' }))).toEqual([
      'Payday',
    ]);
    expect(dialog.getByRole('button', { name: `${FREELANCE.name} · the 3rd` })).toBeTruthy();
  });

  test('a save that fails is undone, and says so', async () => {
    onNovember(10);
    const server = withWallet();
    renderApp(server, '/?settings=money', { size: 'phone' });
    const { user, dialog } = await openMonth();
    await user.click(dialog.getByRole('radio', { name: '25' }));
    server.failNext.profile = 500;
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    // The server's own words for a failure it can't explain further
    expect(await screen.findByText('Something went wrong. Try again in a moment.')).toBeTruthy();
    await waitFor(async () => expect((await monthButton()).textContent).toContain('The 1st'));
    expect(server.me.settings.monthStartDay).toBe(1);
  });

  test.each(SIZES)(
    "the week's start is saved at once, and Home's calendar follows it (%s)",
    async (size) => {
      onNovember(10);
      const server = withWallet();
      // Something spent, so the calendar is drawn (with nothing yet it says it fills in)
      server.transactions.push({
        id: '7'.repeat(16),
        kind: 'expense',
        accountId: WALLET,
        toAccountId: null,
        amountCents: 500,
        categoryId: BILLS,
        payee: null,
        note: null,
        date: '2026-11-05',
        createdAt: 1,
      });
      renderApp(server, '/?settings=money', { size });
      const user = userEvent.setup();
      const week = within(await moneyCard()).getByRole('radiogroup', { name: 'Week starts on' });
      await user.click(within(week).getByRole('radio', { name: 'Sunday' }));
      expect(checked(week)).toEqual(['Sunday']);
      await waitFor(() => expect(server.me.settings.weekStart).toBe('sunday'));

      window.history.pushState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
      const days = await screen.findByRole('region', { name: 'Day by day' });
      expect((await within(days).findAllByRole('columnheader')).map((h) => h.textContent)).toEqual([
        'S',
        'M',
        'T',
        'W',
        'T',
        'F',
        'S',
      ]);
    },
  );
});
