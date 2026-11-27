// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { ProfilePatch } from '@shared/api';
import { SETTINGS_QUIET_MS, SETTINGS_RESEND_MS } from '../../profile/ProfileContext';
import type { FakeServer, Within } from '../../testing/app';
import { fakeServer, holdNext, renderApp, settle, setupAppTests } from '../../testing/app';

// Settings save quietly in the background: each change shows at once, and once the person
// has stopped changing things for a moment, what they changed goes to the server as one
// save, and a small message says so ("Accent set to Plum", or "Settings saved" for
// several). Nothing is sent, or said, for a change taken back before then. Leaving
// Settings, hiding the page or signing out sends what waits straight away. Without a
// connection the message says it's kept on this device; a save the server refuses goes
// back and offers Retry. Names and figures are made up.

setupAppTests();
// The clock runs again before the app is closed, so closing it never waits on a stopped one
afterEach(() => void vi.useRealTimers());

const SIZES = ['phone', 'desktop'] as const;

/** The saves of the profile the app has sent, each as sent */
function saves(): ProfilePatch[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([input, init]) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://app');
      return url.pathname === '/api/me' && init?.method === 'PATCH';
    })
    .map(([, init]) => JSON.parse(init!.body as string) as ProfilePatch);
}

/** The messages showing at the foot of the screen, each with its role and words */
const toasts = () =>
  [...document.querySelectorAll<HTMLElement>('[data-toast-id]')].map((t) => ({
    role: t.getAttribute('role'),
    text: t.querySelector('span')?.textContent ?? '',
  }));

/** Look and start, once drawn */
async function openLook(server: FakeServer, size: (typeof SIZES)[number]) {
  renderApp(server, '/?settings=look', { size });
  await screen.findByRole('heading', { name: 'Look and start', level: 1 });
  return within(await screen.findByRole('region', { name: 'Look and start' }));
}

/**
 * The clock stops: a timer runs only when the test moves it on, so quick changes are quick
 * however slow the machine. `quiet()` moves it on past the pause before a save.
 */
function stopClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Testing Library moves a stopped clock on itself (by nothing, between steps) once it
  // knows the clock is stopped, which it learns from a global named for Jest
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
  onTestFinished(() => void vi.useRealTimers());
  // Without the pauses it takes between keys and clicks, which would wait on the clock
  const user = userEvent.setup({ delay: null });
  const quiet = async () => {
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_QUIET_MS));
    // The rest runs as it would: the device's storage, the server's answer, the message
    vi.useRealTimers();
  };
  return { user, quiet };
}

function goOffline(server: FakeServer) {
  server.health = 'unreachable';
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  onTestFinished(() => onLine.mockRestore());
  act(() => void window.dispatchEvent(new Event('offline')));
  return () => {
    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
  };
}

describe.each(SIZES)('saving settings (%s)', (size) => {
  test('three quick changes are sent as one save, and said once', async () => {
    const server = fakeServer();
    const page = await openLook(server, size);
    await settle();
    const { user, quiet } = stopClock();
    await user.click(page.getByRole('radio', { name: 'Dark' }));
    await user.click(page.getByRole('radio', { name: 'Plum' }));
    await user.click(page.getByRole('radio', { name: 'Essentials' }));
    // Shown at once, sent not yet
    expect(page.getByRole('radio', { name: 'Plum' }).getAttribute('aria-checked')).toBe('true');
    expect(saves()).toEqual([]);

    await quiet();
    await waitFor(() => expect(server.me.settings.homeDensity).toBe('essentials'));
    expect(saves()).toEqual([
      { settings: { theme: 'dark', accent: 'plum', homeDensity: 'essentials' } },
    ]);
    await waitFor(() => expect(toasts()).toEqual([{ role: 'status', text: 'Settings saved' }]));
    expect(server.me.settings).toMatchObject({ theme: 'dark', accent: 'plum' });
  });

  test('one change says what it was, and the next replaces the message', async () => {
    const server = fakeServer();
    const page = await openLook(server, size);
    await settle();
    let { user, quiet } = stopClock();
    await user.click(page.getByRole('radio', { name: 'Plum' }));
    await quiet();
    await waitFor(() => expect(toasts()).toEqual([{ role: 'status', text: 'Accent set to Plum' }]));

    ({ user, quiet } = stopClock());
    await user.click(page.getByRole('radio', { name: 'Light' }));
    await quiet();
    await waitFor(() => expect(toasts()).toEqual([{ role: 'status', text: 'Theme set to Light' }]));
    expect(saves()).toEqual([{ settings: { accent: 'plum' } }, { settings: { theme: 'light' } }]);
  });

  test('the message goes by itself after a few seconds, and can be put away', async () => {
    const server = fakeServer();
    const page = await openLook(server, size);
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    onTestFinished(() => void vi.useRealTimers());
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(page.getByRole('radio', { name: 'Rust' }));
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_QUIET_MS));
    expect(await screen.findByText('Accent set to Rust')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText('Accent set to Rust')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await waitFor(() => expect(toasts()).toEqual([]));

    await user.click(page.getByRole('radio', { name: 'Green' }));
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_QUIET_MS));
    const saved = await screen.findByText('Accent set to Green');
    await user.click(
      within(saved.closest('[data-toast-id]')!).getByRole('button', { name: 'Dismiss' }),
    );
    expect(toasts()).toEqual([]);
  });

  test('a change taken back before the pause sends nothing, and says nothing', async () => {
    const server = fakeServer();
    const page = await openLook(server, size);
    await settle();
    const { user, quiet } = stopClock();
    await user.click(page.getByRole('radio', { name: 'Plum' }));
    await user.click(page.getByRole('radio', { name: 'Cobalt' }));
    await quiet();
    await settle();
    expect(saves()).toEqual([]);
    expect(toasts()).toEqual([]);
    expect(page.getByRole('radio', { name: 'Cobalt' }).getAttribute('aria-checked')).toBe('true');
  });

  test('typing a name sends it once, after Save and the pause', async () => {
    const server = fakeServer();
    renderApp(server, '/?settings=account', { size });
    const { user, quiet } = stopClock();
    await user.click(await screen.findByRole('button', { name: 'Change name' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Change name' }));
    await user.clear(dialog.getByRole('textbox', { name: 'Name' }));
    await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'Mei');
    expect(saves()).toEqual([]);
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(saves()).toEqual([]);
    await quiet();
    await waitFor(() => expect(server.me.displayName).toBe('Mei'));
    expect(saves()).toEqual([{ displayName: 'Mei' }]);
    await waitFor(() => expect(toasts()).toEqual([{ role: 'status', text: 'Name set to Mei' }]));
  });

  test('leaving Settings before the pause still saves, straight away', async () => {
    const server = fakeServer();
    const page = await openLook(server, size);
    await settle();
    const { user } = stopClock();
    await user.click(page.getByRole('radio', { name: 'Graphite' }));
    if (size === 'desktop') {
      await user.click(screen.getByRole('button', { name: 'Close settings' }));
    } else {
      await user.click(screen.getByRole('button', { name: 'Settings' }));
      await user.click(await screen.findByRole('button', { name: 'Home' }));
    }
    await waitFor(() => expect(server.me.settings.accent).toBe('graphite'));
    expect(saves()).toEqual([{ settings: { accent: 'graphite' } }]);
    vi.useRealTimers();
    expect(await screen.findByText('Accent set to Graphite')).toBeTruthy();
  });

  test('the page being hidden before the pause still saves, straight away', async () => {
    const server = fakeServer();
    const page = await openLook(server, size);
    await settle();
    const { user } = stopClock();
    await user.click(page.getByRole('radio', { name: 'Green' }));
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    onTestFinished(() => hidden.mockRestore());
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(server.me.settings.accent).toBe('green'));
    expect(saves()).toEqual([{ settings: { accent: 'green' } }]);
  });

  test('offline, it says the change is kept here, and later syncs without a word', async () => {
    const server = fakeServer();
    const page = await openLook(server, size);
    await settle();
    const back = goOffline(server);
    const { user, quiet } = stopClock();
    await user.click(page.getByRole('radio', { name: 'Plum' }));
    await quiet();
    await waitFor(() =>
      expect(toasts()).toEqual([
        {
          role: 'status',
          text: "Saved on this device. It will sync when you're back online.",
        },
      ]),
    );
    expect(server.me.settings.accent).toBe('cobalt');

    back();
    await waitFor(() => expect(server.me.settings.accent).toBe('plum'), { timeout: 5000 });
    await settle();
    expect(toasts().map((t) => t.text)).not.toContain('Accent set to Plum');
    expect(toasts().map((t) => t.text)).not.toContain('Settings saved');
  });

  test('a change the server refuses goes back, says why, and offers Retry', async () => {
    const server = fakeServer();
    server.me.settings.theme = 'light';
    const page = await openLook(server, size);
    await settle();
    server.failNext.profile = { status: 400, error: 'That theme is not available.' };
    let { user, quiet } = stopClock();
    await user.click(page.getByRole('radio', { name: 'Dark' }));
    await quiet();
    await waitFor(() =>
      expect(toasts()).toEqual([{ role: 'alert', text: 'That theme is not available.' }]),
    );
    await waitFor(() =>
      expect(page.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true'),
    );
    expect(server.me.settings.theme).toBe('light');

    ({ user, quiet } = stopClock());
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(page.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    await quiet();
    await waitFor(() => expect(server.me.settings.theme).toBe('dark'));
    await waitFor(() => expect(toasts()).toEqual([{ role: 'status', text: 'Theme set to Dark' }]));
  });

  test('a save that fails offers Retry, which saves it', async () => {
    const server = fakeServer();
    const page = await openLook(server, size);
    await settle();
    server.failNext.profile = 500;
    let { user, quiet } = stopClock();
    await user.click(page.getByRole('radio', { name: 'Rust' }));
    await quiet();
    const failed = await screen.findByText('Something went wrong. Try again in a moment.');
    ({ user, quiet } = stopClock());
    await user.click(
      within(failed.closest('[data-toast-id]')!).getByRole('button', { name: 'Retry' }),
    );
    await quiet();
    await waitFor(() => expect(server.me.settings.accent).toBe('rust'));
    expect(await screen.findByText('Accent set to Rust')).toBeTruthy();
  });
});

test('the sync cloud says Saving while settings are on their way, then Saved', async () => {
  const server = fakeServer();
  const page = await openLook(server, 'desktop');
  await waitFor(() => expect(screen.getByText('Mahnee · Up to date')).toBeTruthy());
  const held = holdNext(server, 'PATCH', '/api/me');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  onTestFinished(() => void vi.useRealTimers());
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.click(page.getByRole('radio', { name: 'Plum' }));
  await act(() => vi.advanceTimersByTimeAsync(SETTINGS_QUIET_MS + 500));
  expect(await screen.findByText('Mahnee · Saving')).toBeTruthy();
  held.release();
  expect(await screen.findByText('Mahnee · Saved')).toBeTruthy();
});

test("Sign out sends settings still in their pause first, and needn't ask", async () => {
  const server = fakeServer();
  const page = await openLook(server, 'desktop');
  await settle();
  const sentTo: string[] = [];
  const real = window.location;
  vi.stubGlobal(
    'location',
    new Proxy(
      {},
      {
        get: (_, key) => Reflect.get(real, key),
        set: (_, key, value: string) => {
          if (key === 'href') sentTo.push(value);
          return true;
        },
      },
    ),
  );
  const user = userEvent.setup();
  await user.click(page.getByRole('radio', { name: 'Plum' }));
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(sentTo).toEqual(['/cdn-cgi/access/logout']));
  expect(server.me.settings.accent).toBe('plum');
  expect(screen.queryByRole('dialog', { name: 'Sign out anyway?' })).toBeNull();
});

// What the server answers when a save fails, and what's on screen after: a refusal takes
// back only what was refused and not changed since; an answer that says nothing about the
// change (busy, unavailable, too slow) keeps it waiting here and sends it again.

const BANK = 'b'.repeat(16);

/** Adding entries with two accounts in use, once drawn */
async function openAdding(server: FakeServer) {
  for (const [id, name, position] of [
    ['a'.repeat(16), 'Wallet', 0],
    [BANK, 'Bank', 1],
  ] as const) {
    server.accounts.push({
      id,
      name,
      kind: 'cash',
      currency: 'MYR',
      openingCents: 10_000,
      position,
      archived: false,
    });
  }
  renderApp(server, '/?settings=adding', { size: 'desktop' });
  await screen.findByRole('heading', { name: 'Adding entries', level: 1 });
  return within(await screen.findByRole('region', { name: 'Adding entries' }));
}

const accentShown = (page: Within) =>
  page
    .getAllByRole('radio')
    .filter((r) =>
      ['Cobalt', 'Green', 'Plum', 'Rust', 'Graphite'].includes(r.getAttribute('aria-label') ?? ''),
    )
    .find((r) => r.getAttribute('aria-checked') === 'true')
    ?.getAttribute('aria-label');

describe('when a save fails', () => {
  test('a refused change goes back even when another setting changed while it was sent', async () => {
    const server = fakeServer();
    const page = await openLook(server, 'desktop');
    await settle();
    server.failNext.profile = { status: 400, error: 'That accent is not available.' };
    const held = holdNext(server, 'PATCH', '/api/me');
    // The other setting's save waits too, so its answer can't put the accent right instead
    const heldTheme = holdNext(server, 'PATCH', '/api/me');
    const { user, quiet } = stopClock();
    await user.click(page.getByRole('radio', { name: 'Plum' }));
    await quiet();
    await waitFor(() => expect(saves()).toHaveLength(1));
    // Another setting, while the accent is on its way
    await userEvent.setup().click(page.getByRole('radio', { name: 'Dark' }));
    held.release();
    await waitFor(() =>
      expect(toasts()).toContainEqual({ role: 'alert', text: 'That accent is not available.' }),
    );
    await waitFor(() => expect(accentShown(page)).toBe('Cobalt'));
    expect(page.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    heldTheme.release();
    await waitFor(() => expect(server.me.settings.theme).toBe('dark'));
    expect(server.me.settings.accent).toBe('cobalt');
    expect(accentShown(page)).toBe('Cobalt');
  });

  test.each([503, 429, 408])(
    'an answer of %s keeps the change here, says so, and sends it again',
    async (status) => {
      const server = fakeServer();
      const page = await openLook(server, 'desktop');
      await settle();
      server.failNext.profile = status;
      // The clock runs, but the wait before sending again can be skipped
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
      await userEvent
        .setup({ advanceTimers: vi.advanceTimersByTime })
        .click(page.getByRole('radio', { name: 'Rust' }));
      await act(() => vi.advanceTimersByTimeAsync(SETTINGS_QUIET_MS));
      await waitFor(() =>
        expect(toasts()).toEqual([
          { role: 'status', text: 'Saved on this device. It will sync when the server answers.' },
        ]),
      );
      // Not put back
      expect(accentShown(page)).toBe('Rust');
      expect(server.me.settings.accent).toBe('cobalt');

      await act(() => vi.advanceTimersByTimeAsync(SETTINGS_RESEND_MS));
      await waitFor(() => expect(server.me.settings.accent).toBe('rust'));
      expect(saves()).toEqual([{ settings: { accent: 'rust' } }, { settings: { accent: 'rust' } }]);
    },
  );

  test('one refused setting goes back alone, the others are saved, and Retry sends only it', async () => {
    const server = fakeServer();
    const page = await openAdding(server);
    await settle();
    let { user, quiet } = stopClock();
    await user.click(page.getByRole('button', { name: /^Account to use/ }));
    const list = await screen.findByRole('radiogroup', { name: 'Account to use' });
    await user.click(within(list).getByRole('radio', { name: 'Bank' }));
    await user.click(page.getByRole('switch', { name: 'Suggest as you type' }));
    // Bank is archived on another device meanwhile
    server.accounts.find((a) => a.id === BANK)!.archived = true;
    await quiet();
    await waitFor(() =>
      expect(toasts()).toEqual([{ role: 'alert', text: 'That account is archived' }]),
    );
    await waitFor(() => expect(server.me.settings.suggestAsYouType).toBe(false));
    expect(server.me.settings.defaultAccountId).toBeNull();
    await waitFor(() =>
      expect(page.getByRole('button', { name: /^Account to use/ }).textContent).toMatch(
        /Last used/,
      ),
    );
    expect(page.getByRole('switch', { name: 'Suggest as you type' })).toHaveProperty(
      'checked',
      false,
    );

    // Back in use: Retry sends the account alone
    server.accounts.find((a) => a.id === BANK)!.archived = false;
    const before = saves().length;
    ({ user, quiet } = stopClock());
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await quiet();
    await waitFor(() => expect(server.me.settings.defaultAccountId).toBe(BANK));
    expect(saves().slice(before)).toEqual([{ settings: { defaultAccountId: BANK } }]);
  });

  test('Retry leaves alone a setting changed since it failed', async () => {
    const server = fakeServer();
    const page = await openLook(server, 'desktop');
    await settle();
    server.failNext.profile = { status: 400, error: 'That theme is not available.' };
    let { user, quiet } = stopClock();
    await user.click(page.getByRole('radio', { name: 'Dark' }));
    await quiet();
    await screen.findByText('That theme is not available.');
    await waitFor(() =>
      expect(page.getByRole('radio', { name: 'Match device' }).getAttribute('aria-checked')).toBe(
        'true',
      ),
    );
    // Changed again and back before its pause: nothing sent, the message stays
    ({ user, quiet } = stopClock());
    await user.click(page.getByRole('radio', { name: 'Light' }));
    await user.click(page.getByRole('radio', { name: 'Match device' }));
    await quiet();
    await settle();
    const before = saves().length;
    ({ user, quiet } = stopClock());
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await quiet();
    await settle();
    expect(saves().slice(before)).toEqual([]);
    expect(page.getByRole('radio', { name: 'Match device' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(server.me.settings.theme).toBe('auto');
  });

  test("a save this browser stops part-way is said, and the cloud doesn't stay on Saving", async () => {
    const server = fakeServer();
    const page = await openLook(server, 'desktop');
    await waitFor(() => expect(screen.getByText('Mahnee · Up to date')).toBeTruthy());
    // The browser refuses the lock every save of the profile takes
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: () => Promise.reject(new DOMException('Not allowed', 'InvalidStateError')),
      },
    });
    onTestFinished(() => void delete (navigator as { locks?: unknown }).locks);
    const { user, quiet } = stopClock();
    await user.click(page.getByRole('radio', { name: 'Plum' }));
    await quiet();
    await waitFor(() =>
      expect(toasts()).toEqual([{ role: 'alert', text: "Couldn't save your settings." }]),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByText('Mahnee · Saving')).toBeNull();
  });
});

test("Sign out waits for settings already on their way, and needn't ask", async () => {
  const server = fakeServer();
  const page = await openLook(server, 'desktop');
  await settle();
  const sentTo: string[] = [];
  const real = window.location;
  vi.stubGlobal(
    'location',
    new Proxy(
      {},
      {
        get: (_, key) => Reflect.get(real, key),
        set: (_, key, value: string) => {
          if (key === 'href') sentTo.push(value);
          return true;
        },
      },
    ),
  );
  const held = holdNext(server, 'PATCH', '/api/me');
  const { user, quiet } = stopClock();
  await user.click(page.getByRole('radio', { name: 'Plum' }));
  await quiet();
  await waitFor(() => expect(saves()).toHaveLength(1));
  await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  held.release();
  await waitFor(() => expect(sentTo).toEqual(['/cdn-cgi/access/logout']));
  expect(server.me.settings.accent).toBe('plum');
  expect(screen.queryByRole('dialog', { name: 'Sign out anyway?' })).toBeNull();
});
