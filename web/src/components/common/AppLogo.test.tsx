// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test } from 'vitest';
import { navigate } from '../../hooks/useRoute';
import { APPEARANCE_KEY } from '../../profile/ProfileContext';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';
import {
  TOKENS,
  addStyles,
  computed,
  hex,
  moduleCss,
  readBeside,
  tokensCss,
} from '../../testing/css';
import { MARK_PATH } from './AppLogo';
import logoCss from './AppLogo.module.css';

// Mahnee's logo, the hand holding a coin, on a tile of the accent chosen in Look and start
// and in the ink written on it, light or dark as the app is: in the sidebar and on the
// signed-out screen, changing with the accent and the theme at once.

setupAppTests();

beforeEach(() =>
  addStyles([tokensCss(), moduleCss(readBeside('./AppLogo.module.css', import.meta.url), logoCss)]),
);

/** The tile's colour and the hand and coin's, as drawn */
const colours = (logo: HTMLElement) => ({
  tile: hex(computed(logo.querySelector('rect')!, 'fill')),
  mark: hex(computed(logo.querySelector('path')!, 'fill')),
});

/** A server with a wallet, so the app opens on its places */
function withWallet() {
  const server = fakeServer();
  server.accounts.push({
    id: 'a'.repeat(16),
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 0,
    position: 0,
    archived: false,
  });
  return server;
}

const sidebarLogo = async () => {
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  return within(nav.closest('aside')!).getByRole('img', { name: 'Mahnee' });
};

describe('the logo in the sidebar', () => {
  test('is white on cobalt on the light theme, before another accent is chosen', async () => {
    renderApp(withWallet(), '/');
    expect(colours(await sidebarLogo())).toEqual({
      tile: TOKENS.light['--accent'],
      mark: TOKENS.light['--accent-ink'],
    });
  });

  test('takes the accent picked in Look and start, without reloading', async () => {
    const server = withWallet();
    server.me.settings.theme = 'light';
    renderApp(server, '/');
    expect(colours(await sidebarLogo()).tile).toBe(TOKENS.light['--accent']);
    act(() => navigate('?settings=look'));
    const look = within(await screen.findByRole('region', { name: 'Look and start' }));
    await userEvent.setup().click(look.getByRole('radio', { name: 'Rust' }));
    act(() => navigate('?'));
    await waitFor(async () =>
      expect(colours(await sidebarLogo())).toEqual({ tile: '#b04a1c', mark: '#ffffff' }),
    );
  });

  test.each([
    ['cobalt', TOKENS.dark['--accent']],
    ['green', '#6cc59a'],
  ] as const)(
    "on the dark theme, takes %s's dark shade with the dark ink on it",
    async (accent, tile) => {
      const server = withWallet();
      server.me.settings.theme = 'dark';
      server.me.settings.accent = accent;
      localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme: 'dark', accent }));
      renderApp(server, '/');
      await waitFor(() =>
        expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('dark'),
      );
      await waitFor(async () =>
        expect(colours(await sidebarLogo())).toEqual({ tile, mark: TOKENS.dark['--accent-ink'] }),
      );
    },
  );
});

test('the signed-out screen shows the logo above Sign in', async () => {
  const server = fakeServer();
  server.health = 'signedOut';
  renderApp(server, '/', { size: 'phone' });
  const card = (await screen.findByText("You're signed out")).closest('[role="status"]')!;
  expect(within(card as HTMLElement).getByRole('img', { name: 'Mahnee' })).toBeTruthy();
  expect(within(card as HTMLElement).getByRole('button', { name: 'Sign in' })).toBeTruthy();
});

test('the first run shows the logo beside the name, before there is an account', async () => {
  renderApp(fakeServer(), '/', { size: 'phone' });
  await screen.findByRole('heading', { level: 1, name: 'Where do you keep your money?' });
  const logo = screen.getByRole('img', { name: 'Mahnee' });
  expect(logo.parentElement!.textContent).toBe('Mahnee');
  expect(colours(logo)).toEqual({
    tile: TOKENS.light['--accent'],
    mark: TOKENS.light['--accent-ink'],
  });
});

test('the app, the browser tab and the first screen draw the same mark', () => {
  const icon = readBeside('../../../public/icon.svg', import.meta.url);
  expect(/class="mark" fill-rule="evenodd" d="([^"]+)"/.exec(icon)?.[1]).toBe(MARK_PATH);
  const page = readBeside('../../../index.html', import.meta.url);
  const part = (name: string) =>
    new RegExp(`class="${name}"(?:\\s+fill-rule="evenodd")?\\s+d="([^"]+)"`).exec(page)?.[1];
  expect(`${part('hand')}${part('coin')}`).toBe(MARK_PATH);
});
