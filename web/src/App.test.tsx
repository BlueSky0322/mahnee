// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { fakeServer, renderApp, setupAppTests } from './testing/app';

setupAppTests();

describe('the app', () => {
  test('shows who is signed in, in Settings', async () => {
    renderApp(fakeServer(), '/?settings');
    expect(await screen.findByText('Ryan')).toBeTruthy();
    expect(screen.getByText('ryan@example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  test('names someone without a display name by their email', async () => {
    const server = fakeServer();
    server.me.displayName = null;
    renderApp(server, '/?settings', { size: 'phone' });
    expect(await screen.findByText('ryan')).toBeTruthy();
  });

  test('asks you to sign in again once signed out', async () => {
    const server = fakeServer();
    server.health = 'signedOut';
    renderApp(server);
    expect(await screen.findByText("You're signed out")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  test("says when the server can't be reached, and tries again", async () => {
    const server = fakeServer();
    server.health = 'down';
    renderApp(server, '/?settings');
    const user = userEvent.setup();
    expect(await screen.findByText("Couldn't reach Mahnee")).toBeTruthy();
    expect(screen.queryByText("You're signed out")).toBeNull();

    server.health = 'up';
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Ryan')).toBeTruthy();
  });

  // The theme is chosen in Settings › Look and start (it was a switch on Home's header)
  test('the theme chosen is saved with the account', async () => {
    const server = fakeServer();
    server.me.settings.theme = 'dark';
    renderApp(server, '/?settings=look');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Light' }));
    await waitFor(() => expect(server.me.settings.theme).toBe('light'));
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true');
  });

  test('a theme that could not be saved goes back, and says so', async () => {
    const server = fakeServer();
    server.me.settings.theme = 'dark';
    server.failNext.profile = 500;
    renderApp(server, '/?settings=look');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Light' }));
    expect(await screen.findByText('Something went wrong. Try again in a moment.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true'),
    );
    expect(server.me.settings.theme).toBe('dark');
  });
});
