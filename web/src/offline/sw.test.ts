import { describe, expect, test } from 'vitest';
import { fakeCaches, fetchThroughWorker, keptPaths } from '../testing/sw';

// What the service worker (public/sw.js) does with requests other than page loads, which
// shell.test.ts covers: web fonts are kept once fetched, and the API is never answered
// from the device. It runs here as it would in the browser, with the server stood in for.

const FONT = 'https://fonts.gstatic.com/s/inter/v1/inter.woff2';

describe('the service worker, keeping web fonts', () => {
  test('keeps a font once fetched, and answers from the device after', async () => {
    const caches = fakeCaches();
    const font = { status: 200, body: 'font bytes', contentType: 'font/woff2' };
    const first = await fetchThroughWorker(FONT, font, caches);
    expect(first.fetch).toHaveBeenCalledTimes(1);
    expect(await first.response?.text()).toBe('font bytes');

    const offline = await fetchThroughWorker(FONT, { networkError: true }, caches);
    expect(offline.fetch).not.toHaveBeenCalled();
    expect(await offline.response?.text()).toBe('font bytes');
  });

  test('never keeps a failed answer', async () => {
    const caches = fakeCaches();
    await fetchThroughWorker(FONT, { status: 503, contentType: 'font/woff2' }, caches);
    expect(keptPaths(caches, 'mahnee-fonts-v1')).toEqual([]);
    const next = await fetchThroughWorker(
      FONT,
      { status: 200, body: 'font bytes', contentType: 'font/woff2' },
      caches,
    );
    expect(next.fetch).toHaveBeenCalledTimes(1);
    expect(await next.response?.text()).toBe('font bytes');
  });
});

describe('the service worker, with the API', () => {
  test('leaves every API request to the browser, so nothing an account holds is kept', async () => {
    const caches = fakeCaches();
    await expect(
      fetchThroughWorker(
        '/api/me',
        { status: 200, body: '{}', contentType: 'application/json' },
        caches,
      ),
    ).rejects.toThrow('left /api/me to the browser');
    expect(caches.stores.size).toBe(0);
  });
});
