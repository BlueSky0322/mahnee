// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { APPEARANCE_KEY } from '../../profile/ProfileContext';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';
import {
  TOKENS,
  addStyles,
  background,
  mantineCss,
  moduleCss,
  readBeside,
  textColour,
  tokensCss,
} from '../../testing/css';
import classes from './UpdateNotice.module.css';

// When a newer version is on the server, a notice floats at the bottom of the page with
// Reload. On the light theme it's ink, so it stands out on the paper; on the dark theme
// it's raised a step from the ground rather than turned light, so it doesn't glare. Reload
// is the app's usual filled button in either.

setupAppTests();

beforeEach(() =>
  addStyles([
    mantineCss(),
    tokensCss(),
    moduleCss(readBeside('./UpdateNotice.module.css', import.meta.url), classes),
  ]),
);

/** The app open in `theme`, running one version while the server has the next */
async function openWithUpdate(theme: 'light' | 'dark') {
  const running = document.createElement('script');
  running.type = 'module';
  running.src = '/assets/index-1111.js';
  document.head.appendChild(running);
  onTestFinished(() => running.remove());

  const server = fakeServer();
  server.me.settings.theme = theme;
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme, accent: 'cobalt' }));
  renderApp(server);
  const answer = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url, 'http://app').pathname !== '/') return answer(input, init);
    return Promise.resolve(
      new Response('<script type="module" crossorigin src="/assets/index-2222.js"></script>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    );
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const text = await screen.findByText('New version available');
  return text.closest<HTMLElement>('[role="status"]')!;
}

describe.each(['light', 'dark'] as const)('on the %s theme', (theme) => {
  test('the notice floats in its own colours, with Reload filled in the accent', async () => {
    const notice = await openWithUpdate(theme);
    expect(background(notice)).toBe(TOKENS[theme]['--float']);
    expect(textColour(notice)).toBe(TOKENS[theme]['--float-ink']);

    const reload = within(notice).getByRole('button', { name: 'Reload' });
    expect(background(reload)).toBe(TOKENS[theme]['--accent']);
    expect(textColour(reload)).toBe(TOKENS[theme]['--accent-ink']);
  });
});
