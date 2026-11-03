// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Once the app is installed, it asks the browser to keep what this device holds rather
// than clear it when space runs low: once per device, and never relied on

const persist = vi.fn(() => Promise.resolve(true));
const persisted = vi.fn(() => Promise.resolve(false));

/** A fresh start of the app, opened as the installed app or in a browser tab */
async function start({ standalone }: { standalone: boolean }) {
  vi.resetModules();
  window.matchMedia = (query: string) =>
    ({ matches: standalone && query.includes('standalone') }) as MediaQueryList;
  const { trackInstall } = await import('../pwa/install');
  const { keepStorageOnceInstalled } = await import('./storage');
  trackInstall();
  keepStorageOnceInstalled();
  // Whatever the browser answers, it answers before this test looks
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  localStorage.clear();
  persist.mockClear();
  persisted.mockClear();
  persisted.mockResolvedValue(false);
  // jsdom has no navigator.storage; this browser has one
  Object.defineProperty(navigator, 'storage', {
    value: { persist, persisted },
    configurable: true,
  });
});

afterEach(() => {
  delete (navigator as { storage?: unknown }).storage;
});

describe('asking the browser to keep what this device holds', () => {
  test('not asked in a browser tab of an app never installed', async () => {
    await start({ standalone: false });
    expect(persist).not.toHaveBeenCalled();
  });

  test('asked when opened as the installed app, and not again on later starts', async () => {
    await start({ standalone: true });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    await start({ standalone: true });
    await start({ standalone: false });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  test('asked once installed from a browser tab', async () => {
    await start({ standalone: false });
    window.dispatchEvent(new Event('appinstalled'));
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
  });

  test('not asked when the browser keeps it already', async () => {
    persisted.mockResolvedValue(true);
    await start({ standalone: true });
    await vi.waitFor(() => expect(persisted).toHaveBeenCalled());
    expect(persist).not.toHaveBeenCalled();
  });

  test('a browser that can’t be asked, or fails to answer, changes nothing', async () => {
    persist.mockRejectedValueOnce(new Error('Not allowed'));
    await expect(start({ standalone: true })).resolves.toBeUndefined();
    delete (navigator as { storage?: unknown }).storage;
    localStorage.clear();
    await expect(start({ standalone: true })).resolves.toBeUndefined();
  });
});
