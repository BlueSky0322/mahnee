// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { Account } from '@shared/api';
import type { FakeServer } from '../../testing/app';
import { addForm, addSaveButton, fakeServer, renderApp, setupAppTests } from '../../testing/app';

// The places the app is always one tap away from: a tab bar on phones and tablets, a
// sidebar on computers (the design's "Navigation and shell"). On a running account's page
// Add opens on that account, as the floating Add did; piece 9 makes that "Add here".

setupAppTests();

const WALLET = 'a'.repeat(16);
const BANK = 'b'.repeat(16);

function seed(server: FakeServer, account: Partial<Account> & Pick<Account, 'id' | 'name'>) {
  server.accounts.push({
    kind: 'cash',
    currency: 'MYR',
    openingCents: 0,
    position: server.accounts.length,
    archived: false,
    ...account,
  });
}

/** A server with a wallet and a bank account, so there is somewhere to add to */
function withAccounts() {
  const server = fakeServer();
  seed(server, { id: WALLET, name: 'Wallet', openingCents: 10_000 });
  seed(server, { id: BANK, name: 'Bank', kind: 'bank', openingCents: 50_000 });
  return server;
}

const mainNav = () => screen.findByRole('navigation', { name: 'Main' });

/** Each link or button in a navigation, by the name it is read out by, in order */
const itemNames = (nav: HTMLElement) =>
  Array.from(nav.querySelectorAll('a, button')).map(
    (el) => el.getAttribute('aria-label') ?? el.textContent?.trim(),
  );

/** Which of the places is marked as the one open */
const current = (nav: HTMLElement) =>
  Array.from(nav.querySelectorAll('[aria-current="page"]')).map(
    (el) => el.getAttribute('aria-label') ?? el.textContent?.trim(),
  );

const pageTitle = (name: string) => screen.findByRole('heading', { name, level: 1 });

describe('the tab bar on phones and tablets', () => {
  test.each(['phone', 'tablet'] as const)(
    'holds Home, Activity, Add, Plan and Accounts, with Home open (%s)',
    async (size) => {
      renderApp(withAccounts(), '/', { size });
      const nav = await mainNav();
      expect(itemNames(nav)).toEqual(['Home', 'Activity', 'Add', 'Plan', 'Accounts']);
      expect(current(nav)).toEqual(['Home']);
      // Add opens a sheet, so it is a button; the others are places
      expect(within(nav).getByRole('button', { name: 'Add' })).toBeTruthy();
      for (const place of ['Home', 'Activity', 'Plan', 'Accounts']) {
        expect(within(nav).getByRole('link', { name: place })).toBeTruthy();
      }
      // No sidebar: its New entry is the computer's
      expect(screen.queryByRole('button', { name: 'New entry' })).toBeNull();
    },
  );

  test('switching tabs shows each place and never adds to history', async () => {
    renderApp(withAccounts(), '/', { size: 'phone' });
    const user = userEvent.setup();
    const nav = await mainNav();
    const before = window.history.length;

    await user.click(within(nav).getByRole('link', { name: 'Activity' }));
    expect(await pageTitle('Activity')).toBeTruthy();
    expect(window.location.search).toBe('?activity');
    expect(current(await mainNav())).toEqual(['Activity']);

    await user.click(within(await mainNav()).getByRole('link', { name: 'Plan' }));
    expect(await pageTitle('Plan')).toBeTruthy();
    expect(window.location.search).toBe('?plan');
    expect(current(await mainNav())).toEqual(['Plan']);

    await user.click(within(await mainNav()).getByRole('link', { name: 'Accounts' }));
    expect(await pageTitle('Accounts')).toBeTruthy();
    expect(window.location.search).toBe('?accounts');
    expect(current(await mainNav())).toEqual(['Accounts']);

    await user.click(within(await mainNav()).getByRole('link', { name: 'Home' }));
    await waitFor(() =>
      expect(current(screen.getByRole('navigation', { name: 'Main' }))).toEqual(['Home']),
    );
    expect(window.location.search).toBe('');
    // Back never walks through the tabs
    expect(window.history.length).toBe(before);
  });

  test('each place shows what it holds today', async () => {
    renderApp(withAccounts(), '/?accounts', { size: 'phone' });
    // Accounts: the accounts with their balances
    expect(await screen.findByRole('link', { name: /^Wallet, Cash, 100\.00$/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Bank, Bank, 500\.00$/ })).toBeTruthy();
    // Activity: every entry; with none yet, says so (R-Empty-Activity)
    const user = userEvent.setup();
    await user.click(within(await mainNav()).getByRole('link', { name: 'Activity' }));
    expect(await screen.findByRole('heading', { name: 'No transactions yet' })).toBeTruthy();
  });

  test('Add opens a new entry, and Back closes it before leaving the page', async () => {
    renderApp(withAccounts(), '/?activity', { size: 'phone' });
    const user = userEvent.setup();
    await user.click(within(await mainNav()).getByRole('button', { name: 'Add' }));
    const form = await addForm();
    expect(form.getByRole('group', { name: 'Keypad' })).toBeTruthy();
    expect(addSaveButton(form)).toBeTruthy();

    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.search).toBe('?activity');
    expect(await pageTitle('Activity')).toBeTruthy();
  });

  test("on an account's page, Accounts is open and Add puts the entry on that account", async () => {
    renderApp(withAccounts(), `/?account=${BANK}`, { size: 'phone' });
    const nav = await mainNav();
    expect(current(nav)).toEqual(['Accounts']);
    const user = userEvent.setup();
    await user.click(within(nav).getByRole('button', { name: 'Add' }));
    const form = await addForm();
    expect(form.getByRole('button', { name: /^From Bank/ })).toBeTruthy();
  });

  test("an account's page goes back up to Accounts", async () => {
    renderApp(withAccounts(), '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: /^Bank, Bank,/ }));
    await user.click(await screen.findByRole('button', { name: 'Accounts' }));
    expect(await pageTitle('Accounts')).toBeTruthy();
    expect(window.location.search).toBe('?accounts');
  });

  test('there is one Add, in the tab bar: nothing floats over the page', async () => {
    renderApp(withAccounts(), '/', { size: 'phone' });
    const nav = await mainNav();
    // Home is showing
    await screen.findByText('Expected at month end');
    const adds = screen.getAllByRole('button', { name: 'Add' });
    expect(adds).toHaveLength(1);
    expect(nav.contains(adds[0])).toBe(true);
  });

  test("on an archived account's page, Add stays and opens on an account still in use", async () => {
    const server = withAccounts();
    server.accounts[0].archived = true;
    renderApp(server, `/?account=${WALLET}`, { size: 'phone' });
    expect(await screen.findByText('Cash · archived')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(await mainNav()).getByRole('button', { name: 'Add' }));
    const form = await addForm();
    expect(form.getByRole('button', { name: /^From Bank/ })).toBeTruthy();
    // The archived one isn't offered
    await user.click(form.getByRole('button', { name: /^From Bank/ }));
    expect(await screen.findByRole('radio', { name: /^Bank/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /^Wallet/ })).toBeNull();
  });

  test('with every account archived, Add stays in its place but can not be used', async () => {
    const server = withAccounts();
    for (const a of server.accounts) a.archived = true;
    renderApp(server, '/', { size: 'phone' });
    const nav = await mainNav();
    expect(itemNames(nav)).toEqual(['Home', 'Activity', 'Add', 'Plan', 'Accounts']);
    expect(within(nav).getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true);
  });

  test('an earlier month on Home still has Home open', async () => {
    renderApp(withAccounts(), '/?month=2026-01', { size: 'phone' });
    expect(current(await mainNav())).toEqual(['Home']);
  });

  test('Plan on an earlier month still has Plan open', async () => {
    renderApp(withAccounts(), '/?plan&month=2026-01', { size: 'phone' });
    expect(await pageTitle('Plan')).toBeTruthy();
    expect(current(await mainNav())).toEqual(['Plan']);
  });
});

describe('pages without the places', () => {
  test.each(['phone', 'desktop'] as const)(
    'Settings, its sections and Import cover them, reached once they show (%s)',
    async (size) => {
      renderApp(withAccounts(), '/', { size });
      const user = userEvent.setup();
      // The places are known before going anywhere: absence below isn't just early
      await mainNav();
      const covered = async (title: string) => {
        expect(await pageTitle(title)).toBeTruthy();
        expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'New entry' })).toBeNull();
      };
      await user.click(
        await screen.findByRole('link', {
          name:
            size === 'phone' ? 'You and settings' : 'Settings: you, categories, import and export',
        }),
      );
      // A computer's Settings opens on My account, its sections down the left
      await covered(size === 'phone' ? 'Settings' : 'My account');
      await user.click(screen.getByRole('link', { name: /^Categories( |$)/ }));
      await covered('Categories');
      if (size === 'phone') await user.click(screen.getByRole('button', { name: 'Settings' }));
      await user.click(await screen.findByRole('link', { name: /^Import and export( |$)/ }));
      await covered('Import and export');
      // A file chosen there opens the import
      await user.upload(
        screen.getByLabelText(size === 'phone' ? 'Choose a file' : 'Import a file'),
        new File(['Date,Amount\r\n05/10/2026,-8.00\r\n'], 'bank.csv', { type: 'text/csv' }),
      );
      await covered(size === 'phone' ? 'bank.csv into Wallet' : 'Import bank.csv');
    },
  );

  test.each(
    (['phone', 'desktop'] as const).flatMap((size) =>
      [
        ['/?settings', size === 'phone' ? 'Settings' : 'My account'],
        ['/?settings=categories', 'Categories'],
        ['/?settings=data', 'Import and export'],
        ['/?import', 'Import'],
      ].map(([path, title]) => [path, title, size] as const),
    ),
  )(
    '%s, opened at its own address, has no tab bar or sidebar (%s, %s)',
    async (path, title, size) => {
      renderApp(withAccounts(), path, { size });
      expect(await pageTitle(title)).toBeTruthy();
      // Once the accounts are in, which the places wait for
      await waitFor(() =>
        expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/accounts')).toBe(true),
      );
      await act(() => new Promise((r) => setTimeout(r, 200)));
      expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'New entry' })).toBeNull();
    },
  );
});

describe('landmarks', () => {
  test.each(['phone', 'desktop'] as const)(
    'one main region holds the page; the places sit outside it (%s)',
    async (size) => {
      renderApp(withAccounts(), '/?accounts', { size });
      const nav = await mainNav();
      const title = await pageTitle('Accounts');
      const mains = screen.getAllByRole('main');
      expect(mains).toHaveLength(1);
      expect(mains[0].contains(title)).toBe(true);
      expect(mains[0].contains(nav)).toBe(false);
    },
  );
});

describe('the sidebar on computers', () => {
  test('has Mahnee, New entry, the four places with Home open, and Settings', async () => {
    renderApp(withAccounts(), '/');
    const nav = await mainNav();
    expect(itemNames(nav)).toEqual(['Home', 'Activity', 'Plan', 'Accounts']);
    expect(current(nav)).toEqual(['Home']);

    const sidebar = nav.closest('aside')!;
    expect(sidebar).toBeTruthy();
    expect(within(sidebar).getByText('Mahnee')).toBeTruthy();
    const newEntry = within(sidebar).getByRole('button', { name: 'New entry' });
    // Its key, drawn as a keycap
    expect(within(newEntry).getByText('N')).toBeTruthy();
    const settings = within(sidebar).getByRole('link', {
      name: 'Settings: you, categories, import and export',
    });
    expect(within(settings).getByText('Settings')).toBeTruthy();
    expect(within(settings).getByText('ryan@example.com')).toBeTruthy();
    expect(within(settings).getByText('R')).toBeTruthy();
    // No tab bar
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  test('New entry opens a new entry', async () => {
    renderApp(withAccounts(), '/?plan');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New entry' }));
    expect((await addForm()).getByRole('textbox', { name: 'Amount' })).toBeTruthy();
  });

  test('moving between places never adds to history', async () => {
    renderApp(withAccounts(), '/');
    const user = userEvent.setup();
    const before = window.history.length;
    await user.click(within(await mainNav()).getByRole('link', { name: 'Accounts' }));
    expect(await pageTitle('Accounts')).toBeTruthy();
    expect(current(await mainNav())).toEqual(['Accounts']);
    await user.click(within(await mainNav()).getByRole('link', { name: 'Activity' }));
    expect(await pageTitle('Activity')).toBeTruthy();
    expect(window.location.search).toBe('?activity');
    expect(window.history.length).toBe(before);
  });

  test("Accounts is open on an account's page", async () => {
    renderApp(withAccounts(), `/?account=${WALLET}`);
    expect(current(await mainNav())).toEqual(['Accounts']);
  });

  test("on an archived account's page, New entry opens on an account still in use", async () => {
    const server = withAccounts();
    server.accounts[0].archived = true;
    renderApp(server, `/?account=${WALLET}`);
    expect((await screen.findAllByText('Cash · archived')).length).toBeGreaterThan(0);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New entry' }));
    expect((await addForm()).getByRole('button', { name: /^From Bank/ })).toBeTruthy();
  });

  test('with every account archived, New entry can not be used', async () => {
    const server = withAccounts();
    for (const a of server.accounts) a.archived = true;
    renderApp(server, '/');
    expect(await screen.findByRole('button', { name: 'New entry' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('the first run, before there is an account', () => {
  test.each(['phone', 'desktop'] as const)('has no tab bar, sidebar or Add (%s)', async (size) => {
    renderApp(fakeServer(), '/', { size });
    expect(await screen.findByText('Where do you keep your money?')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New entry' })).toBeNull();
  });
});
