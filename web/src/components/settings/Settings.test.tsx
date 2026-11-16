// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import type { FakeServer } from '../../testing/app';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';

// Settings: reached from the round initial on Home (phones and tablets) or the sidebar
// (computers). Who's signed in and Sign out moved here from Home, with Categories and
// Import and export; each section opens today's page for it.

setupAppTests();

function withWallet(): FakeServer {
  const server = fakeServer();
  server.accounts.push({
    id: 'a'.repeat(16),
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 10_000,
    position: 0,
    archived: false,
  });
  return server;
}

const pageTitle = (name: string) => screen.findByRole('heading', { name, level: 1 });

/** Opens Settings from the initial on Home's header */
async function openFromHome() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('link', { name: 'You and settings' }));
  await pageTitle('Settings');
  return user;
}

describe('Settings on phones and tablets', () => {
  test.each(['phone', 'tablet'] as const)(
    "opens from the initial on Home's header and goes back Home (%s)",
    async (size) => {
      renderApp(withWallet(), '/', { size });
      const initial = await screen.findByRole('link', { name: 'You and settings' });
      expect(initial.textContent).toBe('R');
      const user = await openFromHome();
      expect(window.location.search).toBe('?settings');

      await user.click(screen.getByRole('button', { name: 'Home' }));
      expect(await screen.findByRole('link', { name: 'You and settings' })).toBeTruthy();
      expect(window.location.search).toBe('');
    },
  );

  // Interim: the index as piece 2 draws it. Piece 10 adds search, the App sections and each
  // section's summary, and replaces these expectations.
  test("shows who's signed in, their data and Sign out", async () => {
    renderApp(withWallet(), '/', { size: 'phone' });
    await openFromHome();
    expect(screen.getByText('Ryan')).toBeTruthy();
    expect(screen.getByText('ryan@example.com')).toBeTruthy();
    const data = within(screen.getByRole('region', { name: 'Your data' }));
    expect(data.getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Categories',
      'Import and export',
    ]);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    // No close button: that's the computer's
    expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull();
  });

  test("the initial is the first letter of the person's name, or of their email", async () => {
    const server = withWallet();
    server.me.displayName = 'mei';
    renderApp(server, '/', { size: 'phone' });
    const initial = await screen.findByRole('link', { name: 'You and settings' });
    await waitFor(() => expect(initial.textContent).toBe('M'));
  });

  test('without a display name, the email names them', async () => {
    const server = withWallet();
    server.me.displayName = null;
    renderApp(server, '/', { size: 'phone' });
    const initial = await screen.findByRole('link', { name: 'You and settings' });
    expect(initial.textContent).toBe('R');
    await openFromHome();
    expect(await screen.findByText('ryan')).toBeTruthy();
  });

  test.each(['phone', 'desktop'] as const)(
    'Home no longer lists the ways out, or who is signed in (%s)',
    async (size) => {
      renderApp(withWallet(), '/', { size });
      await screen.findByRole('button', { name: /^Wallet,/ });
      expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'Categories' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
      expect(screen.queryByText(/Signed in as/)).toBeNull();
    },
  );

  test('Categories opens from Settings and goes back up to it', async () => {
    renderApp(withWallet(), '/', { size: 'phone' });
    const user = await openFromHome();
    await user.click(screen.getByRole('link', { name: 'Categories' }));
    expect(await pageTitle('Categories')).toBeTruthy();
    expect(window.location.search).toBe('?settings=categories');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await pageTitle('Settings')).toBeTruthy();
    expect(window.location.search).toBe('?settings');
  });

  // Interim: piece 10 rebuilds Import and export
  test('Import and export holds Export and Import, each as today', async () => {
    renderApp(withWallet(), '/', { size: 'phone' });
    const user = await openFromHome();
    await user.click(screen.getByRole('link', { name: 'Import and export' }));
    expect(await pageTitle('Import and export')).toBeTruthy();
    expect(window.location.search).toBe('?settings=data');

    await user.click(screen.getByRole('button', { name: 'Export' }));
    const exporting = await screen.findByRole('dialog', { name: 'Export' });
    expect(within(exporting).getByRole('button', { name: 'Download' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.search).toBe('?settings=data');

    await user.click(screen.getByRole('link', { name: 'Import' }));
    expect(await pageTitle('Import')).toBeTruthy();
    expect(window.location.search).toBe('?import');
    await user.click(screen.getByRole('button', { name: 'Import and export' }));
    expect(await pageTitle('Import and export')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await pageTitle('Settings')).toBeTruthy();
  });
});

describe('Settings on computers', () => {
  test('opens from the sidebar over the page it came from, and closes back to it', async () => {
    renderApp(withWallet(), '/?activity');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('link', { name: 'Settings: you, categories, import and export' }),
    );
    expect(await pageTitle('Settings')).toBeTruthy();
    expect(window.location.search).toBe('?settings');
    // Settings covers the places; it has no back to Home
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();

    const close = screen.getByRole('button', { name: 'Close settings' });
    expect(within(close).getByText('Esc')).toBeTruthy();
    await user.click(close);
    expect(await pageTitle('Activity')).toBeTruthy();
    expect(window.location.search).toBe('?activity');
  });

  test('opened at its own address, Close goes Home', async () => {
    renderApp(withWallet(), '/?settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Close settings' }));
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(window.location.search).toBe('');
  });

  test("Home's header has no initial: the sidebar holds Settings", async () => {
    renderApp(withWallet(), '/');
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByRole('link', { name: 'You and settings' })).toBeNull();
  });

  // Interim: piece 5 builds the first run, which may move or remove the initial
  test('before there is an account, Home keeps the initial, so Settings is still there', async () => {
    renderApp(fakeServer(), '/');
    expect(await screen.findByText('Add your first account')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'You and settings' })).toBeTruthy();
  });
});
