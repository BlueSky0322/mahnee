// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';

// Mahnee's logo and name at the top of a computer's sidebar go to Home (owner request
// 2026-11-25), as Home in the places below them does: read out once, as "Mahnee, Home",
// and from Home itself they stay put without adding to the history. How fresh the figures
// are, beside the name, isn't part of it. Phones and tablets have no such header.

setupAppTests();

function withWallet() {
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

const brand = () => screen.findByRole('link', { name: 'Mahnee, Home' });
const onHome = () => screen.findByRole('searchbox', { name: 'Search everything' });

describe('the Mahnee name on a computer', () => {
  test('goes to Home from another page, with a click', async () => {
    renderApp(withWallet(), '/?activity', { size: 'desktop' });
    await screen.findByRole('heading', { level: 1, name: 'Activity' });
    const link = await brand();
    await userEvent.setup().click(link);
    await onHome();
    expect(window.location.search).toBe('');
  });

  test('goes to Home from the keyboard', async () => {
    renderApp(withWallet(), '/?plan', { size: 'desktop' });
    const link = await brand();
    link.focus();
    await userEvent.setup().keyboard('{Enter}');
    await onHome();
    expect(window.location.search).toBe('');
  });

  test('on Home, stays there without a new history entry', async () => {
    renderApp(withWallet(), '/', { size: 'desktop' });
    await onHome();
    const before = window.history.length;
    await userEvent.setup().click(await brand());
    await onHome();
    expect(window.location.search).toBe('');
    expect(window.history.length).toBe(before);
  });

  test('the freshness beside it is not part of the link', async () => {
    renderApp(withWallet(), '/?activity', { size: 'desktop' });
    const link = await brand();
    // The logo and the name are the link, and nothing more: the freshness sits beside it
    expect(link.textContent).toBe('Mahnee');
    expect(link.querySelector('svg')).not.toBeNull();
  });

  test.each(['phone', 'tablet'] as const)('a %s has no such link', async (size) => {
    renderApp(withWallet(), '/?activity', { size });
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByRole('link', { name: 'Mahnee, Home' })).toBeNull();
  });
});
