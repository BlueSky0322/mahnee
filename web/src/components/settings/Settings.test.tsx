// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { trackInstall } from '../../pwa/install';
import type { FakeServer } from '../../testing/app';
import { addEntry, fakeServer, renderApp, setupAppTests } from '../../testing/app';

// Settings (R-Settings, R-Set-Account, R-Desk-Settings, R-Set-Search, R-Desk-Set-Search):
// reached from the round initial on Home (phones and tablets) or the sidebar (computers).
// A phone's index lists who's signed in, then each section with what it's set to, then
// Sign out; a computer's Settings covers the page with the sections down the left and the
// open one beside them, My account first. Search finds a setting by its name, its line or
// words that aren't on it, and opens its section with that setting in view.

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

/** What an element reads as: its text pieces in order, one space between each */
const text = (el: Element) => {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
    else node.childNodes.forEach(walk);
  };
  walk(el);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};

/** The same, a marked word read with the letters it sits among ("the month-end figure") */
const withMarks = (el: Element) => {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('mark').forEach((m) => m.replaceWith(m.textContent ?? ''));
  copy.normalize();
  return text(copy);
};

/** The links a region holds, each as it reads */
const linksIn = (name: string) =>
  within(screen.getByRole('region', { name })).getAllByRole('link').map(text);

/** The browser offers its install prompt, as Chrome does: returns what opening it calls */
function offerInstall() {
  trackInstall();
  const prompt = vi.fn(() => Promise.resolve());
  window.dispatchEvent(
    Object.assign(new Event('beforeinstallprompt'), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
    }),
  );
  return prompt;
}

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

  test('lists who is signed in, each section with what it is set to, then Sign out', async () => {
    renderApp(withWallet(), '/', { size: 'phone' });
    await openFromHome();
    expect(screen.getByRole('searchbox', { name: 'Search settings' })).toHaveProperty(
      'placeholder',
      'Search settings',
    );
    const me = await screen.findByRole('link', { name: /^Ryan ryan@example\.com/ });
    expect(text(me)).toBe('R Ryan ryan@example.com');
    expect(linksIn('App')).toEqual([
      'Money MYR · month from the 1st',
      'Adding entries Amount first · suggestions on',
      'Look and start Match phone · opens on Home',
      'Budgets and reminders Carry over on · daily at 9:00 PM',
    ]);
    // Nothing saved yet: the default categories, and no import
    await waitFor(() =>
      expect(linksIn('Your data')).toEqual([
        'Categories 8 expense, 2 income',
        'Import and export No imports yet',
      ]),
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(await screen.findByText('Mahnee · Up to date')).toBeTruthy();
    // No close button: that's the computer's
    expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull();
  });

  test("says what each section is set to now, the person's categories and last import", async () => {
    const server = withWallet();
    server.me.settings = {
      ...server.me.settings,
      monthStartDay: 25,
      startWith: 'category',
      suggestAsYouType: false,
      theme: 'dark',
      startScreen: 'plan',
      carryOverDefault: false,
      dailyReminder: false,
    };
    server.categories = DEFAULT_CATEGORIES.filter((c) => c.name !== 'Fun').map((c) => ({ ...c }));
    const year = new Date().getFullYear();
    server.imports.push(
      {
        id: 'c'.repeat(16),
        fileName: 'visa-sep.csv',
        accountId: 'a'.repeat(16),
        addedCount: 27,
        skippedCount: 0,
        createdAt: new Date(year, 0, 2, 9).getTime(),
        undoneAt: null,
      },
      {
        id: 'd'.repeat(16),
        fileName: 'maybank-oct.csv',
        accountId: 'a'.repeat(16),
        addedCount: 38,
        skippedCount: 4,
        createdAt: new Date(year, 0, 3, 9).getTime(),
        undoneAt: null,
      },
    );
    renderApp(server, '/?settings', { size: 'phone' });
    await pageTitle('Settings');
    await waitFor(() =>
      expect(linksIn('App')).toEqual([
        'Money MYR · month from the 25th',
        'Adding entries Category first · suggestions off',
        'Look and start Dark · opens on Plan',
        'Budgets and reminders Carry over off · no daily reminder',
      ]),
    );
    await waitFor(() =>
      expect(linksIn('Your data')).toEqual([
        'Categories 7 expense, 2 income',
        'Import and export Last import Jan 3',
      ]),
    );
  });

  test.each(['phone', 'tablet'] as const)(
    'each section opens with Settings to go back to (%s)',
    async (size) => {
      renderApp(withWallet(), '/?settings', { size });
      const user = userEvent.setup();
      for (const [section, address] of [
        ['Money', '?settings=money'],
        ['Adding entries', '?settings=adding'],
        ['Look and start', '?settings=look'],
        ['Budgets and reminders', '?settings=budgets'],
      ] as const) {
        await user.click(await screen.findByRole('link', { name: new RegExp(`^${section} `) }));
        expect(await pageTitle(section)).toBeTruthy();
        expect(window.location.search).toBe(address);
        await user.click(screen.getByRole('button', { name: 'Settings' }));
        expect(await pageTitle('Settings')).toBeTruthy();
        expect(window.location.search).toBe('?settings');
      }
    },
  );

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
    expect(text(await screen.findByRole('link', { name: /ryan@example\.com/ }))).toBe(
      'R ryan ryan@example.com',
    );
  });

  test.each(['phone', 'desktop'] as const)(
    'Home no longer lists the ways out, or who is signed in (%s)',
    async (size) => {
      renderApp(withWallet(), '/', { size });
      // Home is showing, its figures loaded
      await screen.findByText('Expected at month end');
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
    await user.click(await screen.findByRole('link', { name: /^Categories / }));
    expect(await pageTitle('Categories')).toBeTruthy();
    expect(window.location.search).toBe('?settings=categories');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await pageTitle('Settings')).toBeTruthy();
    expect(window.location.search).toBe('?settings');
  });

  test('Import and export opens from Settings and goes back up to it', async () => {
    renderApp(withWallet(), '/', { size: 'phone' });
    const user = await openFromHome();
    await user.click(await screen.findByRole('link', { name: /^Import and export / }));
    expect(await pageTitle('Import and export')).toBeTruthy();
    expect(window.location.search).toBe('?settings=data');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await pageTitle('Settings')).toBeTruthy();
  });
});

describe('My account', () => {
  test('opens from who is signed in, and names them with a way to change the name', async () => {
    const server = withWallet();
    renderApp(server, '/?settings', { size: 'phone' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: /^Ryan ryan@example\.com/ }));
    expect(await pageTitle('My account')).toBeTruthy();
    expect(window.location.search).toBe('?settings=account');
    const profile = screen.getByRole('region', { name: 'Profile' });
    expect(text(profile)).toBe('R Ryan ryan@example.com Change name');

    await user.click(within(profile).getByRole('button', { name: 'Change name' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Change name' }));
    const field = dialog.getByRole('textbox', { name: 'Name' });
    expect(field).toHaveProperty('value', 'Ryan');
    await user.clear(field);
    await user.type(field, '  Mei ');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(server.me.displayName).toBe('Mei'));
    expect(text(screen.getByRole('region', { name: 'Profile' }))).toBe(
      'M Mei ryan@example.com Change name',
    );

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await pageTitle('Settings')).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Mei ryan@example\.com/ })).toBeTruthy();
  });

  test('an empty name goes back to the email; one too long is cut to fit', async () => {
    const server = withWallet();
    renderApp(server, '/?settings=account', { size: 'phone' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change name' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Change name' }));
    const field = dialog.getByRole('textbox', { name: 'Name' });
    expect(field).toHaveProperty('maxLength', 32);
    await user.clear(field);
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.me.displayName).toBeNull());
    expect(text(screen.getByRole('region', { name: 'Profile' }))).toBe(
      'R ryan ryan@example.com Change name',
    );
  });

  test('a name the server refuses goes back, and says so', async () => {
    const server = withWallet();
    renderApp(server, '/?settings=account', { size: 'phone' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change name' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Change name' }));
    server.failNext.profile = 500;
    await user.clear(dialog.getByRole('textbox', { name: 'Name' }));
    await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'Mei');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Couldn't save your name/)).toBeTruthy();
    await waitFor(() =>
      expect(text(screen.getByRole('region', { name: 'Profile' }))).toBe(
        'R Ryan ryan@example.com Change name',
      ),
    );
    expect(server.me.displayName).toBe('Ryan');
  });

  test('says whether this phone has saved everything, and what waits offline', async () => {
    const server = withWallet();
    renderApp(server, '/?settings=account', { size: 'phone' });
    const phone = await screen.findByRole('region', { name: 'This phone' });
    await waitFor(() => expect(text(phone)).toMatch(/^Saved Up to date/));

    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    act(() => void window.dispatchEvent(new Event('offline')));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Settings' }));
    await pageTitle('Settings');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Home' }));
    await addEntry('8');
    await userEvent.setup().click(await screen.findByRole('link', { name: 'You and settings' }));
    await userEvent
      .setup()
      .click(await screen.findByRole('link', { name: /^Ryan ryan@example\.com/ }));
    await waitFor(() =>
      expect(text(screen.getByRole('region', { name: 'This phone' }))).toMatch(
        /^Saved Offline · 1 change waiting to save/,
      ),
    );
  });

  test.each(['phone', 'desktop'] as const)(
    'offers to install the app where the browser can, and opens its prompt (%s)',
    async (size) => {
      const prompt = offerInstall();
      renderApp(withWallet(), '/?settings=account', { size });
      const install = await screen.findByRole('button', {
        name: size === 'phone' ? 'Install the app Opens offline' : 'Install',
      });
      await userEvent.setup().click(install);
      expect(prompt).toHaveBeenCalledTimes(1);
    },
  );

  // Its one home now: Home's card goes (R-Home, R-Desk-Home, R-FirstRun draw none)
  test.each([
    ['phone', true],
    ['desktop', true],
    ['phone', false],
    ['desktop', false],
  ] as const)('Home draws no install offer (%s, with an account: %s)', async (size, account) => {
    offerInstall();
    renderApp(account ? withWallet() : fakeServer(), '/', { size });
    await screen.findByText(account ? 'Expected at month end' : 'Where do you keep your money?');
    expect(screen.queryByRole('button', { name: /Install/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Get the app' })).toBeNull();
  });

  test("on a computer, it's what Settings opens on, and says This computer", async () => {
    renderApp(withWallet(), '/?settings');
    expect(await pageTitle('My account')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Ryan', level: 2 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change name' })).toBeTruthy();
    const computer = screen.getByRole('region', { name: 'This computer' });
    await waitFor(() => expect(text(computer)).toMatch(/^This computer Saved Up to date/));
    expect(screen.queryByRole('region', { name: 'This phone' })).toBeNull();
  });
});

describe('Settings on computers', () => {
  test('opens from the sidebar over the page it came from, and closes back to it', async () => {
    renderApp(withWallet(), '/?activity');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('link', { name: 'Settings: you, categories, import and export' }),
    );
    expect(await pageTitle('My account')).toBeTruthy();
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

  test('lists its sections down the left, the open one marked, and moves between them', async () => {
    renderApp(withWallet(), '/?activity');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('link', { name: 'Settings: you, categories, import and export' }),
    );
    const nav = within(await screen.findByRole('navigation', { name: 'Settings' }));
    expect(nav.getByRole('searchbox', { name: 'Search settings' })).toBeTruthy();
    expect(nav.getByText('Ctrl K')).toBeTruthy();
    expect(nav.getAllByRole('link').map(text)).toEqual([
      'My account',
      'Money',
      'Adding entries',
      'Look and start',
      'Budgets and reminders',
      'Categories',
      'Import and export',
    ]);
    expect(nav.getByRole('link', { name: 'My account' }).getAttribute('aria-current')).toBe('page');
    expect(nav.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(await nav.findByText('Mahnee · Up to date')).toBeTruthy();

    await user.click(nav.getByRole('link', { name: 'Categories' }));
    expect(await pageTitle('Categories')).toBeTruthy();
    expect(window.location.search).toBe('?settings=categories');
    expect(nav.getByRole('link', { name: 'Categories' }).getAttribute('aria-current')).toBe('page');
    expect(nav.getByRole('link', { name: 'My account' }).getAttribute('aria-current')).toBeNull();
    // Moving between sections isn't somewhere Close goes back through
    await user.click(nav.getByRole('link', { name: 'Import and export' }));
    expect(await pageTitle('Import and export')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(await pageTitle('Activity')).toBeTruthy();
    expect(window.location.search).toBe('?activity');
  });

  test.each([
    ['Categories', '?settings=categories', ['Expenses', 'Income']],
    ['Import and export', '?settings=data', ['Import', 'Export']],
  ] as const)(
    '%s lists its parts under it, each bringing its card into view',
    async (name, address, parts) => {
      renderApp(withWallet(), `/${address}`);
      const shown: Element[] = [];
      const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
        this: Element,
      ) {
        shown.push(this);
      });
      onTestFinished(() => spy.mockRestore());
      const user = userEvent.setup();
      await pageTitle(name);
      const nav = within(screen.getByRole('navigation', { name: 'Settings' }));
      const group = within(nav.getByRole('group', { name: `Parts of ${name}` }));
      const buttons = group.getAllByRole('button');
      expect(buttons.map(text)).toEqual([...parts]);
      expect(buttons.map((b) => b.getAttribute('aria-current'))).toEqual(['true', null]);
      // The other sections have none
      expect(nav.getAllByRole('group')).toHaveLength(1);

      const card = await screen.findByRole('region', { name: parts[1] });
      await user.click(group.getByRole('button', { name: parts[1] }));
      expect(shown.at(-1)).toBe(card);
      // The keyboard and screen readers go with it
      expect(document.activeElement).toBe(card);
      expect(buttons.map((b) => b.getAttribute('aria-current'))).toEqual([null, 'true']);
      // Moving within a section isn't kept in history
      expect(window.location.search).toBe(address);
    },
  );

  test('a section without parts lists none', async () => {
    renderApp(withWallet(), '/?settings=look');
    await pageTitle('Look and start');
    const nav = within(screen.getByRole('navigation', { name: 'Settings' }));
    expect(nav.queryByRole('group')).toBeNull();
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

  // The first run keeps the initial, so Settings (and Sign out) is still there
  test('before there is an account, Home keeps the initial, so Settings is still there', async () => {
    renderApp(fakeServer(), '/');
    expect(await screen.findByText('Where do you keep your money?')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'You and settings' })).toBeTruthy();
  });
});

describe('searching settings', () => {
  test('on a phone, finds settings as the words are typed, and opens one in view', async () => {
    renderApp(withWallet(), '/?settings', { size: 'phone' });
    const user = userEvent.setup();
    const search = await screen.findByRole('searchbox', { name: 'Search settings' });
    await user.type(search, 'month');

    expect(await screen.findByText('3 settings')).toBeTruthy();
    const results = within(screen.getByRole('region', { name: 'Search results' }));
    const found = results.getAllByRole('link');
    expect(found.map(withMarks)).toEqual([
      'Month starts on Money',
      'Main currency Money · "the month end"',
      'Home shows Look and start · "the month-end figure"',
    ]);
    expect(found.map((a) => a.querySelector('mark')?.textContent)).toEqual([
      'Month',
      'month',
      'month',
    ]);
    // The sections give way to what's found
    expect(screen.queryByRole('region', { name: 'App' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Your data' })).toBeNull();

    await user.click(found[2]);
    expect(await pageTitle('Look and start')).toBeTruthy();
    expect(window.location.search).toBe('?settings=look&setting=homeShows');
    // The setting found is the one in view, with the keyboard on it
    await waitFor(() => expect(text(document.activeElement!)).toMatch(/^Home shows /));
  });

  test('clears with ×, back to the sections', async () => {
    renderApp(withWallet(), '/?settings', { size: 'phone' });
    const user = userEvent.setup();
    const search = await screen.findByRole('searchbox', { name: 'Search settings' });
    await user.type(search, 'month');
    await screen.findByRole('region', { name: 'Search results' });
    const clear = screen.getByRole('button', { name: 'Clear search' });
    expect(clear.textContent).toBe('×');
    await user.click(clear);
    expect(search).toHaveProperty('value', '');
    expect(screen.queryByRole('region', { name: 'Search results' })).toBeNull();
    expect(screen.getByRole('region', { name: 'App' })).toBeTruthy();
  });

  test('says when nothing matches', async () => {
    renderApp(withWallet(), '/?settings', { size: 'phone' });
    const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox', { name: 'Search settings' }), 'zebra');
    expect(await screen.findByText('No settings match "zebra"')).toBeTruthy();
    expect(screen.queryAllByRole('link', { name: /^Month/ })).toEqual([]);
  });

  test('on a computer, Ctrl K finds the search and Enter opens the first', async () => {
    renderApp(withWallet(), '/?settings=categories');
    const user = userEvent.setup();
    await pageTitle('Categories');
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    expect(document.activeElement).not.toBe(search);
    await user.keyboard('{Control>}k{/Control}');
    expect(document.activeElement).toBe(search);

    await user.keyboard('month');
    const nav = within(screen.getByRole('navigation', { name: 'Settings' }));
    expect(await nav.findByText('3 settings · Enter opens the first')).toBeTruthy();
    // What's found takes the sections' place in the sidebar, the first one marked
    const found = within(nav.getByRole('region', { name: 'Search results' })).getAllByRole('link');
    expect(found.map(withMarks)).toEqual([
      'Month starts on Money',
      'Main currency Money · "the month end"',
      'Home shows Look and start · "the month-end figure"',
    ]);
    expect(found.map((a) => a.getAttribute('aria-current'))).toEqual(['true', null, null]);
    expect(nav.queryByRole('link', { name: 'Categories' })).toBeNull();
    expect(nav.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    // Beside it, the first one's section, without leaving the keyboard or the address
    expect(await pageTitle('Money')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Categories', level: 1 })).toBeNull();
    expect(document.activeElement).toBe(search);
    expect(window.location.search).toBe('?settings=categories');

    await user.keyboard('{Enter}');
    expect(await pageTitle('Money')).toBeTruthy();
    expect(window.location.search).toBe('?settings=money&setting=monthStart');
    await waitFor(() => expect(text(document.activeElement!)).toMatch(/^Month starts on /));
    expect(search).toHaveProperty('value', '');
    expect(nav.getByRole('link', { name: 'Money' }).getAttribute('aria-current')).toBe('page');
  });

  test('on a computer, what nothing matches leaves the open section as it was', async () => {
    renderApp(withWallet(), '/?settings=categories');
    const user = userEvent.setup();
    await pageTitle('Categories');
    await user.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'zebra');
    const nav = within(screen.getByRole('navigation', { name: 'Settings' }));
    expect(await nav.findByText('No settings match "zebra"')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Categories', level: 1 })).toBeTruthy();
    await user.click(nav.getByRole('button', { name: 'Clear search' }));
    expect(nav.getByRole('link', { name: 'Categories' }).getAttribute('aria-current')).toBe('page');
  });
});
