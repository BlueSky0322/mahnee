// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test } from 'vitest';
import type { FakeServer } from '../testing/app';
import { fakeServer, goToPlace, renderApp, setupAppTests } from '../testing/app';

// Where each page opens on the screen: a place (Home, Activity, Plan, Accounts) opens at
// the top the first time, and where it was left when the person comes back to it, from
// the tab bar or the sidebar. Back from a page opened from another (an account's page)
// puts the one under it back where it was. Moving to a page never carries another page's
// position with it.

setupAppTests();

const WALLET = 'a'.repeat(16);

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
  return server;
}

// jsdom lays nothing out and doesn't scroll: the page scrolls here as far as it's asked,
// and says so as a browser does
let y = 0;
beforeEach(() => {
  y = 0;
  const before = Object.getOwnPropertyDescriptor(window, 'scrollY');
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
  return () => {
    if (before != null) Object.defineProperty(window, 'scrollY', before);
  };
});

/** The person scrolls the page to `to` */
function scrollPage(to: number) {
  y = to;
  window.dispatchEvent(new Event('scroll'));
}

/** How far the page can scroll, while what's on it is still being drawn */
let furthest = Infinity;

/** Scrolling, as the app asks for it, no further than the page goes */
function letAppScroll() {
  furthest = Infinity;
  window.scrollTo = ((a: number | ScrollToOptions, b?: number) => {
    y = Math.min(furthest, typeof a === 'object' ? a.top ?? y : b ?? y);
    window.dispatchEvent(new Event('scroll'));
  }) as typeof window.scrollTo;
}

const pageTitle = (name: string | RegExp) => screen.findByRole('heading', { name, level: 1 });

describe('where a page opens', () => {
  test.each(['phone', 'desktop'] as const)(
    'Home and Plan each keep their own place, and open at the top the first time (%s)',
    async (size) => {
      renderApp(withWallet(), '/', { size });
      letAppScroll();
      await pageTitle(/November|October|December|Home/);
      scrollPage(520);

      await goToPlace('Plan');
      await pageTitle('Plan');
      await waitFor(() => expect(window.scrollY).toBe(0));
      scrollPage(240);

      await goToPlace('Home');
      await waitFor(() => expect(window.scrollY).toBe(520));

      await goToPlace('Plan');
      await pageTitle('Plan');
      await waitFor(() => expect(window.scrollY).toBe(240));

      // A place not seen yet opens at the top
      await goToPlace('Activity');
      await pageTitle('Activity');
      await waitFor(() => expect(window.scrollY).toBe(0));
    },
  );

  test('Back from an account’s page puts Accounts back where it was (phone)', async () => {
    renderApp(withWallet(), '/?accounts', { size: 'phone' });
    letAppScroll();
    const user = userEvent.setup();
    await pageTitle('Accounts');
    scrollPage(300);

    await user.click(await screen.findByRole('link', { name: /^Wallet/ }));
    await pageTitle('Wallet');
    await waitFor(() => expect(window.scrollY).toBe(0));
    scrollPage(90);

    await user.click(screen.getByRole('button', { name: 'Accounts' }));
    await pageTitle('Accounts');
    await waitFor(() => expect(window.scrollY).toBe(300));
  });

  test('the browser’s Back does the same, and Forward puts the account back too', async () => {
    renderApp(withWallet(), '/?accounts', { size: 'phone' });
    letAppScroll();
    const user = userEvent.setup();
    await pageTitle('Accounts');
    scrollPage(300);
    await user.click(await screen.findByRole('link', { name: /^Wallet/ }));
    await pageTitle('Wallet');
    scrollPage(90);

    window.history.back();
    await pageTitle('Accounts');
    await waitFor(() => expect(window.scrollY).toBe(300));

    window.history.forward();
    await pageTitle('Wallet');
    await waitFor(() => expect(window.scrollY).toBe(90));
  });

  test('changing what Activity shows keeps it where it is', async () => {
    const server = withWallet();
    server.transactions.push({
      id: 'b'.repeat(16),
      kind: 'expense',
      accountId: WALLET,
      toAccountId: null,
      amountCents: 450,
      categoryId: null,
      payee: 'Kopi',
      note: null,
      date: new Date().toISOString().slice(0, 10),
      createdAt: 1,
    });
    renderApp(server, '/?activity', { size: 'phone' });
    letAppScroll();
    await pageTitle('Activity');
    await screen.findByText('Kopi');
    scrollPage(150);
    const user = userEvent.setup();
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'kopi');
    await waitFor(() => expect(window.location.search).toContain('q=kopi'), { timeout: 3000 });
    expect(window.scrollY).toBe(150);
    expect(within(document.body).getByRole('heading', { name: 'Activity', level: 1 })).toBeTruthy();
  });

  test('a page left while it was still drawing keeps where it was, not where it got to', async () => {
    renderApp(withWallet(), '/', { size: 'phone' });
    letAppScroll();
    await pageTitle(/November|October|December|Home/);
    scrollPage(520);
    await goToPlace('Plan');
    await pageTitle('Plan');
    // Home comes back short, still drawing, and is left before it's whole
    furthest = 100;
    await goToPlace('Home');
    await waitFor(() => expect(window.scrollY).toBe(100));
    await goToPlace('Plan');
    await pageTitle('Plan');
    furthest = Infinity;
    await goToPlace('Home');
    await waitFor(() => expect(window.scrollY).toBe(520));
  });

  test('each visit is its own: Back to an earlier month comes back where that one was', async () => {
    renderApp(withWallet(), '/', { size: 'phone' });
    letAppScroll();
    const user = userEvent.setup();
    await pageTitle(/November|October|December|Home/);
    scrollPage(300);
    // An earlier month is the same page, so it stays put, and then is moved on its own
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(window.scrollY).toBe(300);
    scrollPage(50);
    await goToPlace('Accounts');
    await pageTitle('Accounts');
    window.history.back();
    await waitFor(() => expect(window.scrollY).toBe(300));
  });
});
