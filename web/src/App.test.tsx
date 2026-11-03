// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { fakeServer, renderApp, setupAppTests } from './testing/app';

setupAppTests();

describe('the app', () => {
  test('shows who is signed in on the home page', async () => {
    renderApp(fakeServer());
    expect(await screen.findByText('Signed in as Ryan')).toBeTruthy();
    expect(screen.getByText('ryan@example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  test('names someone without a display name by their email', async () => {
    const server = fakeServer();
    server.me.displayName = null;
    renderApp(server, '/', { size: 'phone' });
    expect(await screen.findByText('Signed in as ryan')).toBeTruthy();
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
    renderApp(server);
    const user = userEvent.setup();
    expect(await screen.findByText("Couldn't reach Mahnee")).toBeTruthy();
    expect(screen.queryByText("You're signed out")).toBeNull();

    server.health = 'up';
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Signed in as Ryan')).toBeTruthy();
  });

  test('the theme switch saves the choice with the account', async () => {
    const server = fakeServer();
    server.me.settings.theme = 'dark';
    renderApp(server);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Switch to light mode' }));
    await waitFor(() => expect(server.me.settings.theme).toBe('light'));
    expect(await screen.findByRole('button', { name: 'Switch to dark mode' })).toBeTruthy();
  });

  test('a theme that could not be saved goes back, and says so', async () => {
    const server = fakeServer();
    server.me.settings.theme = 'dark';
    server.failNext.profile = 500;
    renderApp(server);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Switch to light mode' }));
    expect(await screen.findByText('Something went wrong. Try again in a moment.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Switch to light mode' })).toBeTruthy();
    expect(server.me.settings.theme).toBe('dark');
  });
});
