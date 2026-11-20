// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  addEntry,
  fakeServer,
  finishConversion,
  goToPlace,
  renderApp,
  setupAppTests,
} from '../../testing/app';

// Settings › Money › Main currency (R-Set-Money-Cur, R-Desk-Set-Money-Cur; owner decisions
// D2 to D5). The row reads the currency and its symbol ("MYR, RM") and opens a picker: a
// sheet on phones, a panel on computers, with a search ("Search currencies", "Search by
// name or code") and the groups "You use" and "All currencies". Picking one closes it and
// saves it at once; the amounts are then converted on the server, and until that's done
// the row and Home say "Converting to USD…", amounts are shown as they still are, and
// changes made meanwhile wait on the device. They're sent once it's done, saying the
// currency they were typed in, so the server converts them too. A change refused for an
// amount past its limit is said under the row, naming the limit. Changing it needs a
// connection. Other currencies sit under it (other-currencies.test.tsx).

setupAppTests();

const SIZES = ['phone', 'desktop'] as const;
const WALLET = 'a'.repeat(16);
const FOOD = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;

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

const moneyCard = () => screen.findByRole('region', { name: 'Money' });

const currencyButton = async () =>
  within(await moneyCard()).findByRole('button', { name: /^Main currency/ });

async function openPicker() {
  const user = userEvent.setup();
  await user.click(await currencyButton());
  const dialog = await screen.findByRole('dialog', { name: 'Main currency' });
  return { user, dialog: within(dialog) };
}

const optionNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole('option')
    .map((o) => o.textContent);

function goOffline(server: FakeServer) {
  server.health = 'unreachable';
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  onTestFinished(() => onLine.mockRestore());
  act(() => void window.dispatchEvent(new Event('offline')));
}

describe('Main currency', () => {
  test.each(SIZES)('reads the currency and its symbol, and picks another (%s)', async (size) => {
    const server = withWallet();
    renderApp(server, '/?settings=money', { size });
    const card = await moneyCard();
    expect(within(card).getByText('For totals and budgets')).toBeTruthy();
    expect((await currencyButton()).textContent).toContain('MYR, RM');
    // Other currencies come next, with their own tests
    expect(within(card).getByText('Other currencies')).toBeTruthy();

    const { user, dialog } = await openPicker();
    const search = dialog.getByRole('searchbox', { name: 'Search currencies' });
    expect(search.getAttribute('placeholder')).toBe('Search by name or code');
    const yours = dialog.getByRole('listbox', { name: 'You use' });
    expect(optionNames(yours)).toEqual(['MYRMalaysian ringgitRM']);
    expect(within(yours).getByRole('option').getAttribute('aria-selected')).toBe('true');
    const all = dialog.getByRole('listbox', { name: 'All currencies' });
    expect(optionNames(all)).toEqual(
      expect.arrayContaining(['USDUS dollar$', 'SGDSingapore dollarS$', 'IDRIndonesian rupiahRp']),
    );

    await user.type(search, 'rupiah');
    expect(dialog.queryByRole('listbox', { name: 'You use' })).toBeNull();
    expect(optionNames(dialog.getByRole('listbox', { name: 'All currencies' }))).toEqual([
      'IDRIndonesian rupiahRp',
    ]);
    await user.clear(search);
    await user.type(search, 'usd');
    await user.click(dialog.getByRole('option', { name: /^USD/ }));

    // Closed and saved at once; converting until the server is done
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Main currency' })).toBeNull());
    await waitFor(() => expect(server.me.settings.currency).toBe('USD'));
    expect((await currencyButton()).textContent).toContain('USD, $');
    expect(await within(card).findByText('Converting to USD…')).toBeTruthy();
  });

  test('picking the one it is changes nothing', async () => {
    const server = withWallet();
    renderApp(server, '/?settings=money');
    const { user, dialog } = await openPicker();
    await user.click(dialog.getByRole('option', { name: /^MYR/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Main currency' })).toBeNull());
    expect(server.me.conversion).toBeNull();
    expect(screen.queryByText(/^Converting/)).toBeNull();
  });

  test('says on Home it is converting, holds changes till done, then sends them as typed', async () => {
    const server = withWallet();
    server.rates.set('MYRUSD', 0.25);
    // On a computer, where Settings closes back to Home
    renderApp(server, '/?settings=money');
    const { user, dialog } = await openPicker();
    await user.click(dialog.getByRole('option', { name: /^USD/ }));
    await waitFor(() => expect(server.me.conversion).not.toBeNull());

    await user.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(await screen.findByText('Converting to USD…')).toBeTruthy();
    // Typed against amounts still in ringgit, and kept on the device meanwhile
    await addEntry('8', async (form) => {
      await user.click(form.getByRole('button', { name: /Food/ }));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.transactions).toEqual([]);

    finishConversion(server);
    await waitFor(() => expect(server.transactions).toHaveLength(1), { timeout: 10_000 });
    expect(server.transactions[0]).toMatchObject({ categoryId: FOOD, amountCents: 200 });
    await waitFor(() => expect(screen.queryByText('Converting to USD…')).toBeNull(), {
      timeout: 10_000,
    });

    // Amounts now show in the new currency
    await goToPlace('Accounts');
    expect(
      await screen.findAllByText((text) => text.includes('$ 23.00 in accounts')),
    ).not.toHaveLength(0);
  });

  test.each([
    ['amount', 'Kept MYR: an entry would come to more than 10,000,000 IDR'],
    ['opening', 'Kept MYR: an opening balance would come to more than 10,000,000 IDR either way'],
    ['budget', 'Kept MYR: a budget would come to more than 10,000,000 IDR'],
    ['scheduled', 'Kept MYR: a scheduled item would come to more than 10,000,000 IDR'],
    [
      'rates',
      "Kept MYR: rates for IDR weren't available, so nothing was converted. Try again later",
    ],
  ] as const)('says which limit refused a change (%s)', async (limit, words) => {
    const server = withWallet();
    server.me.conversion = { from: 'MYR', to: 'IDR', since: Date.now(), refused: limit };
    renderApp(server, '/?settings=money');
    expect(await within(await moneyCard()).findByText(words)).toBeTruthy();
    expect((await currencyButton()).textContent).toContain('MYR, RM');
  });

  test('needs a connection to change', async () => {
    const server = withWallet();
    renderApp(server, '/?settings=money', { size: 'phone' });
    const button = await currencyButton();
    goOffline(server);
    expect(
      await within(await moneyCard()).findByText('Connect to change the currency'),
    ).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test('the Settings index names the currency', async () => {
    const server = withWallet();
    server.me.settings = { ...server.me.settings, currency: 'SGD' };
    renderApp(server, '/?settings', { size: 'phone' });
    expect(await screen.findByText('SGD · month from the 1st')).toBeTruthy();
  });
});
