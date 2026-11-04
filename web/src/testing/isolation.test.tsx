// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { fakeServer, holdNext, renderApp, setupAppTests } from './app';

// Each screen test starts from nothing: work an earlier test left running (a save still
// waiting on the server, say) finishes before the next test, rather than landing in it
// as that test's data

setupAppTests();

describe('screen tests, one after another', () => {
  test('one ends while a save is still waiting on the server', async () => {
    const server = fakeServer();
    server.me.displayName = 'Bali';
    server.me.settings.theme = 'dark';
    renderApp(server, '/', { size: 'phone' });
    await screen.findByText('Signed in as Bali', {}, { timeout: 3000 });
    // The server answers the save only once this test has finished
    const save = holdNext(server, 'PATCH', '/api/me');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Switch to light mode' }));
    setTimeout(() => save.release(), 0);
  });

  test('the next shows its own account, not the one left from before', async () => {
    renderApp(fakeServer(), '/', { size: 'phone' });
    expect(await screen.findByText('Signed in as Ryan', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText('Signed in as Bali')).toBeNull();
  });
});
