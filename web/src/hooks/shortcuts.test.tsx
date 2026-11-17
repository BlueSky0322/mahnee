// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import type { FakeServer } from '../testing/app';
import { fakeServer, renderApp, setupAppTests } from '../testing/app';

// Keys on a computer: N for a new entry, / to search, Esc to close Settings. None fires
// while typing in a field, except Esc; none reaches past a dialog that's open.

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

/** Long enough for a dialog a key opened to be on screen */
const settle = () => act(() => new Promise((r) => setTimeout(r, 300)));

const pageTitle = (name: string) => screen.findByRole('heading', { name, level: 1 });
const places = () => screen.findByRole('navigation', { name: 'Main' });

describe('N', () => {
  test('opens a new entry', async () => {
    renderApp(withWallet(), '/');
    await places();
    await userEvent.setup().keyboard('n');
    expect(within(await screen.findByRole('dialog')).getByLabelText('Amount')).toBeTruthy();
  });

  test('typed into a field, is only typed', async () => {
    renderApp(withWallet(), '/?activity');
    const user = userEvent.setup();
    const search = await screen.findByRole('searchbox', { name: 'Search' });
    await user.click(search);
    await user.keyboard('n');
    expect(search).toHaveProperty('value', 'n');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('with Ctrl or Cmd held, is left to the browser', async () => {
    renderApp(withWallet(), '/');
    await places();
    const user = userEvent.setup();
    await user.keyboard('{Control>}n{/Control}');
    await user.keyboard('{Meta>}n{/Meta}');
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('does nothing on Settings or Import, reached once the places show', async () => {
    renderApp(withWallet(), '/');
    const user = userEvent.setup();
    // The keys are known to work here first
    await places();
    await user.click(
      screen.getByRole('link', { name: 'Settings: you, categories, import and export' }),
    );
    await pageTitle('My account');
    await user.keyboard('n');
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Import and export' }));
    await user.upload(
      await screen.findByLabelText('Import a file'),
      new File(['Date,Amount\r\n05/10/2026,-8.00\r\n'], 'bank.csv', { type: 'text/csv' }),
    );
    await pageTitle('Import bank.csv');
    await user.keyboard('n');
    await user.keyboard('/');
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.location.search).toBe('?import');
  });

  test('does nothing before there is an account to add to', async () => {
    renderApp(fakeServer(), '/');
    await screen.findByText('Where do you keep your money?');
    await userEvent.setup().keyboard('n');
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('/', () => {
  // Home on a computer has a search of its own, which / puts the cursor in (Home.test.tsx)
  test("on a page with no search, opens Activity with its search ready to type into, in that page's place", async () => {
    renderApp(withWallet(), '/?plan');
    await places();
    const before = window.history.length;
    const user = userEvent.setup();
    await user.keyboard('/');
    expect(await pageTitle('Activity')).toBeTruthy();
    expect(window.location.search).toBe('?activity');
    const search = screen.getByRole('searchbox', { name: 'Search' });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(search).toHaveProperty('value', '');
    expect(window.history.length).toBe(before);
  });

  test('typed into the search, is only typed', async () => {
    renderApp(withWallet(), '/?activity');
    const user = userEvent.setup();
    const search = await screen.findByRole('searchbox', { name: 'Search' });
    await user.click(search);
    await user.keyboard('a/b');
    expect(search).toHaveProperty('value', 'a/b');
    expect(window.location.search).toBe('?activity');
  });

  test('on Activity, puts the cursor in its search', async () => {
    renderApp(withWallet(), '/?activity');
    const search = await screen.findByRole('searchbox', { name: 'Search' });
    await userEvent.setup().keyboard('/');
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(search).toHaveProperty('value', '');
  });
});

describe('Esc', () => {
  test('closes Settings, back to the page it was opened over', async () => {
    renderApp(withWallet(), '/?plan');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('link', { name: 'Settings: you, categories, import and export' }),
    );
    await pageTitle('My account');
    await user.keyboard('{Escape}');
    expect(await pageTitle('Plan')).toBeTruthy();
    expect(window.location.search).toBe('?plan');
  });

  // A section is a pane of one Settings on a computer: Esc closes Settings from any
  test('on a section of Settings, closes Settings', async () => {
    renderApp(withWallet(), '/?settings=categories');
    await pageTitle('Categories');
    await userEvent.setup().keyboard('{Escape}');
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(window.location.search).toBe('');
  });

  test('with a dialog open, closes only the dialog', async () => {
    renderApp(withWallet(), '/?settings=account');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change name' }));
    await screen.findByRole('dialog', { name: 'Change name' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.search).toBe('?settings=account');
    expect(screen.getByRole('heading', { name: 'My account', level: 1 })).toBeTruthy();
  });

  test('on Import, does nothing: a file being looked over is kept', async () => {
    renderApp(withWallet(), '/?import');
    await pageTitle('Import');
    await userEvent.setup().keyboard('{Escape}');
    await settle();
    expect(window.location.search).toBe('?import');
    expect(screen.getByRole('heading', { name: 'Import', level: 1 })).toBeTruthy();
  });

  test('on a place, does nothing', async () => {
    renderApp(withWallet(), '/?accounts');
    await pageTitle('Accounts');
    await userEvent.setup().keyboard('{Escape}');
    await settle();
    expect(window.location.search).toBe('?accounts');
    expect(screen.getByRole('heading', { name: 'Accounts', level: 1 })).toBeTruthy();
  });

  test('with a new entry open, N types and Esc closes it, nothing more', async () => {
    renderApp(withWallet(), '/?activity');
    const user = userEvent.setup();
    await places();
    await user.keyboard('n');
    const sheet = await screen.findByRole('dialog');
    await user.keyboard('n');
    await settle();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(sheet).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.search).toBe('?activity');
  });
});

describe('with a dialog open, out of any field', () => {
  test('N and / do nothing: the dialog has the keys', async () => {
    renderApp(withWallet(), '/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New entry' }));
    const sheet = await screen.findByRole('dialog');
    // Out of the Amount field, onto the dialog itself
    await user.click(within(sheet).getAllByRole('heading')[0]);
    expect(document.activeElement?.tagName).not.toBe('INPUT');
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA');
    await user.keyboard('/');
    await user.keyboard('n');
    await settle();
    expect(window.location.search).toBe('');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(sheet).getByLabelText('Amount')).toHaveProperty('value', '');
  });
});

describe('what counts as typing', () => {
  /** Puts `el` on the page, focused, for the length of the test */
  function focusOn(el: HTMLElement) {
    document.body.append(el);
    el.focus();
    return () => el.remove();
  }
  const make = (html: string) => {
    const box = document.createElement('div');
    box.innerHTML = html;
    return box.firstElementChild as HTMLElement;
  };

  test.each([
    ['a text field', '<input type="text">'],
    ['a field with no type', '<input>'],
    ['a search', '<input type="search">'],
    ['a number', '<input type="number">'],
    ['a day', '<input type="date">'],
    ['an email', '<input type="email">'],
    ['a phone number', '<input type="tel">'],
    ['an address', '<input type="url">'],
    ['a password', '<input type="password">'],
    ['a longer text', '<textarea></textarea>'],
    ['a list to pick from', '<select><option>One</option></select>'],
    ['editable text', '<div contenteditable="true" tabindex="0"></div>'],
  ])('in %s, N is left to it', async (_what, html) => {
    renderApp(withWallet(), '/');
    await places();
    const remove = focusOn(make(html));
    await userEvent.setup().keyboard('n');
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    remove();
  });

  test.each([
    ['a tick box', '<input type="checkbox">'],
    ['a choice of several', '<input type="radio" name="way">'],
    ['a button', '<button type="button">Go</button>'],
  ])('on %s, N still opens a new entry', async (_what, html) => {
    renderApp(withWallet(), '/');
    await places();
    const remove = focusOn(make(html));
    await userEvent.setup().keyboard('n');
    expect(within(await screen.findByRole('dialog')).getByLabelText('Amount')).toBeTruthy();
    remove();
  });
});
