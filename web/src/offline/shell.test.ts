import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { OPENED_FROM_DEVICE, OPENED_SIGNED_OUT, SIGN_IN_PARAM } from './cache';
import {
  type Answer,
  type Site,
  fakeCaches,
  fetchThroughWorker,
  install,
  keptPaths,
  keptText,
  openPage,
} from '../testing/sw';

// The service worker (public/sw.js) keeps the app's page and its built files, so the app
// opens offline and on a bad connection, and what it loads later works there too. Each
// deploy is a new version of the page, naming new files.

const SHELL = 'mahnee-shell-v1';
const ASSETS = 'mahnee-assets-v1';

/** One deploy: its page, which names its script and styles, and the build's list */
const version = (n: number) => {
  const page = [`/assets/index-v${n}.js`, `/assets/index-v${n}.css`];
  return {
    html: `<!doctype html><html><head><script type="module" src="${page[0]}"></script><link rel="stylesheet" href="${page[1]}"></head><body><div id="root"></div></body></html>`,
    // Also what features load when first used
    list: [...page, `/assets/feature-v${n}.js`, `/assets/library-v${n}.js`].sort(),
  };
};

/** The server with `v` deployed; `instead` answers some paths differently */
const deployed =
  (v: ReturnType<typeof version>, instead: Record<string, ReturnType<Site>> = {}): Site =>
  (path) => {
    if (path in instead) return instead[path];
    if (path === '/') return { status: 200, body: v.html, contentType: 'text/html' };
    if (path === '/precache.json') {
      return { status: 200, body: JSON.stringify(v.list), contentType: 'application/json' };
    }
    if (v.list.includes(path)) {
      return { status: 200, body: `code ${path}`, contentType: 'text/javascript' };
    }
    return { status: 404 };
  };

const offline: Site = () => ({ networkError: true });

/** The page as the device kept it, marked so the app knows */
const fromDevice = (html: string, why = 'true') =>
  html.replace('<head>', `<head><meta name="${OPENED_FROM_DEVICE}" content="${why}">`);

/** Opens the app once with `site` and lets the service worker finish */
async function visit(caches: ReturnType<typeof fakeCaches>, site: Site, path = '/') {
  const opened = openPage(path, site, caches);
  const response = await opened.response;
  await opened.done;
  return { text: await response?.text(), response, fetch: opened.fetch };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('opening the app', () => {
  test('a healthy connection shows the fresh page, and keeps it with every file it needs', async () => {
    const caches = fakeCaches();
    await visit(caches, deployed(version(1)));

    const { text } = await visit(caches, deployed(version(2)), '/?page=accounts');
    expect(text).toBe(version(2).html);
    expect(await keptText(caches, SHELL, '/')).toBe(version(2).html);
    // Including what the app loads later, which the page doesn't name
    expect(keptPaths(caches, ASSETS)).toEqual(
      expect.arrayContaining(['/assets/feature-v2.js', '/assets/library-v2.js']),
    );
  });

  test('a slow connection shows the kept page after 3 seconds, and keeps the fresh one once it comes', async () => {
    const caches = fakeCaches();
    await visit(caches, deployed(version(1)));
    vi.useFakeTimers();
    const slowPage = new Promise<Answer>((resolve) =>
      setTimeout(
        () => resolve({ status: 200, body: version(2).html, contentType: 'text/html' }),
        10_000,
      ),
    );
    const opened = openPage('/', deployed(version(2), { '/': slowPage }), caches);
    let shown = false;
    void opened.response.then(() => (shown = true));

    await vi.advanceTimersByTimeAsync(2_999);
    expect(shown).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(shown).toBe(true);
    expect(await (await opened.response)?.text()).toBe(fromDevice(version(1).html));

    await vi.advanceTimersByTimeAsync(7_000);
    await opened.done;
    expect(await keptText(caches, SHELL, '/')).toBe(version(2).html);
  });

  test('no connection shows the kept page, marked as opened from the device', async () => {
    const caches = fakeCaches();
    await visit(caches, deployed(version(1)));
    const { text } = await visit(caches, offline, '/?page=month');
    expect(text).toBe(fromDevice(version(1).html));
  });

  test.each<[string, Answer]>([
    ['500', { status: 500, body: 'Internal error', contentType: 'text/plain' }],
    [
      '502 from Cloudflare',
      { status: 502, body: '<html>Bad gateway</html>', contentType: 'text/html' },
    ],
    ['503', { status: 503 }],
    [
      'a proxy answering with something other than a page',
      { status: 200, body: '{}', contentType: 'application/json' },
    ],
  ])('the server failing (%s) shows the kept page, which stays kept', async (_name, answer) => {
    const caches = fakeCaches();
    await visit(caches, deployed(version(1)));
    const { text } = await visit(caches, deployed(version(2), { '/': answer }));
    expect(text).toBe(fromDevice(version(1).html));
    expect(await keptText(caches, SHELL, '/')).toBe(version(1).html);
  });

  test('with nothing kept yet, the page gets whatever the server says', async () => {
    const { response } = await visit(fakeCaches(), deployed(version(1), { '/': { status: 503 } }));
    expect(response?.status).toBe(503);
  });

  test('Access asking to sign in again opens the kept page, marked so, and leaves it kept', async () => {
    const caches = fakeCaches();
    await visit(caches, deployed(version(1)));
    const { text } = await visit(caches, deployed(version(2), { '/': { signIn: true } }));
    expect(text).toBe(fromDevice(version(1).html, OPENED_SIGNED_OUT));
    expect(await keptText(caches, SHELL, '/')).toBe(version(1).html);
  });

  test('with no page kept yet, a redirect to sign in goes to the browser', async () => {
    const { response } = await visit(fakeCaches(), deployed(version(1), { '/': { signIn: true } }));
    expect(response).toMatchObject({ type: 'opaqueredirect' });
  });

  test('going to sign in is left to the browser, so Access answers', async () => {
    const caches = fakeCaches();
    await visit(caches, deployed(version(1)));
    const path = `/?page=accounts&${SIGN_IN_PARAM}=`;
    expect(() => openPage(path, deployed(version(1)), caches)).toThrow(
      `left ${path} to the browser`,
    );
  });

  test.each<[string, ReturnType<Site>, Partial<Response>]>([
    [
      'a sign-in page reached by a redirect',
      { status: 200, body: '<html>Sign in</html>', contentType: 'text/html', redirected: true },
      { status: 200, redirected: true },
    ],
    [
      'Access turning them away',
      { status: 403, body: '<html>Forbidden</html>', contentType: 'text/html' },
      { status: 403 },
    ],
  ])(
    '%s goes to the browser, and never replaces the kept page',
    async (_name, answer, expected) => {
      const caches = fakeCaches();
      await visit(caches, deployed(version(1)));
      const { response } = await visit(caches, deployed(version(2), { '/': answer }));
      expect(response).toMatchObject(expected);
      expect(await keptText(caches, SHELL, '/')).toBe(version(1).html);
      expect(keptPaths(caches, ASSETS)).toEqual(version(1).list);
    },
  );

  test('signing in and out with Cloudflare Access is left to the browser', () => {
    const path = '/cdn-cgi/access/authorization?token=t';
    expect(() => openPage(path, deployed(version(1)), fakeCaches())).toThrow(
      `left ${path} to the browser`,
    );
  });
});

describe('updating the kept page', () => {
  test.each([['/assets/index-v2.js'], ['/assets/feature-v2.js']])(
    'stopped halfway (%s not fetched), it leaves the kept page whole, and finishes next time',
    async (missing) => {
      const caches = fakeCaches();
      await visit(caches, deployed(version(1)));
      await visit(caches, deployed(version(2), { [missing]: { networkError: true } }));
      expect(await keptText(caches, SHELL, '/')).toBe(version(1).html);

      // Offline, the kept page opens, with every file it needs
      expect((await visit(caches, offline)).text).toBe(fromDevice(version(1).html));
      expect(keptPaths(caches, ASSETS)).toEqual(expect.arrayContaining(version(1).list));

      await visit(caches, deployed(version(2)));
      expect(await keptText(caches, SHELL, '/')).toBe(version(2).html);
      expect(keptPaths(caches, ASSETS)).toEqual(expect.arrayContaining(version(2).list));
    },
  );

  test('a page and a list of files from different deploys leave the kept page as it was', async () => {
    const caches = fakeCaches();
    await visit(caches, deployed(version(1)));
    const mixed = deployed(version(2), {
      '/precache.json': { status: 200, body: JSON.stringify(version(3).list) },
    });
    await visit(caches, mixed);
    expect(await keptText(caches, SHELL, '/')).toBe(version(1).html);
  });

  test('the files of the newest two deploys are kept, and older or unlisted ones go', async () => {
    const caches = fakeCaches();
    await visit(caches, deployed(version(1)));
    // Something a library loads for itself, fetched once and kept along the way
    const extra = '/assets/html2canvas-v1.js';
    await fetchThroughWorker(extra, { status: 200, body: 'code' }, caches);
    expect(keptPaths(caches, ASSETS)).toContain(extra);

    await visit(caches, deployed(version(2)));
    // A tab still open on the first deploy can still load what it needs
    expect(keptPaths(caches, ASSETS)).toEqual([...version(1).list, ...version(2).list].sort());

    await visit(caches, deployed(version(3)));
    expect(keptPaths(caches, ASSETS)).toEqual([...version(2).list, ...version(3).list].sort());
  });

  test('opening the same deploy again fetches nothing more', async () => {
    const caches = fakeCaches();
    await visit(caches, deployed(version(1)));
    const { fetch } = await visit(caches, deployed(version(1)));
    expect(fetch.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ url: 'https://mahnee.test/' }),
    ]);
  });

  test('a new service worker keeps what the app loads later, though the page was kept before', async () => {
    const caches = fakeCaches();
    // As an older service worker left it: the page and the files it names, nothing else
    const shell = await caches.open(SHELL);
    await shell.put(
      '/',
      new Response(version(1).html, { headers: { 'Content-Type': 'text/html' } }),
    );
    const assets = await caches.open(ASSETS);
    for (const file of version(1).list.filter((f) => f.includes('index'))) {
      await assets.put(file, new Response('code'));
    }

    await install(deployed(version(1)), caches);
    expect(keptPaths(caches, ASSETS)).toEqual(version(1).list);
    expect(await keptText(caches, SHELL, '/')).toBe(version(1).html);
  });
});

// Installing the app reads the manifest and its icons. Kept beside the page, they're there
// whenever the kept page opens, so it installs with its name and icon even when Access or
// the connection turns the browser's request for them away.
describe('keeping what installing the app reads', () => {
  const read = (file: string) =>
    readFileSync(fileURLToPath(new NodeURL(`../../${file}`, import.meta.url)), 'utf8');
  /** The manifest, each icon it names, and the iPhone icon the page links to */
  const installFiles = () => {
    const manifest = JSON.parse(read('public/manifest.webmanifest')) as {
      icons: { src: string }[];
    };
    const touch = /rel="apple-touch-icon"\s+href="([^"]+)"/.exec(read('index.html'))![1];
    return ['/manifest.webmanifest', ...manifest.icons.map((i) => i.src), touch].sort();
  };
  const serving = (files: string[]) =>
    Object.fromEntries(
      files.map((f) => [f, { status: 200, body: `file ${f}`, contentType: 'image/png' }]),
    );

  test('keeps each of them with the page, as the manifest and the page name them', async () => {
    const caches = fakeCaches();
    const files = installFiles();
    await visit(caches, deployed(version(1), serving(files)));
    expect(keptPaths(caches, SHELL)).toEqual(['/', '/shell-files', ...files].sort());
  });

  test.each<[string, Answer]>([
    [
      'Access asks to sign in',
      { status: 200, body: '<html>Sign in</html>', contentType: 'text/html', redirected: true },
    ],
    ['there is no connection', { networkError: true }],
    ['the server fails', { status: 503 }],
  ])('when %s, the manifest comes from the kept copy', async (_when, answer) => {
    const caches = fakeCaches();
    await visit(caches, deployed(version(1), serving(installFiles())));
    const { response } = await fetchThroughWorker('/manifest.webmanifest', answer, caches);
    expect(await response?.text()).toBe('file /manifest.webmanifest');
  });

  test('from the network it is fresh, and kept so', async () => {
    const caches = fakeCaches();
    await visit(caches, deployed(version(1), serving(installFiles())));
    const fresh = { status: 200, body: 'new icon', contentType: 'image/png' };
    const { response } = await fetchThroughWorker('/icon-192.png', fresh, caches);
    expect(await response?.text()).toBe('new icon');
    expect(await keptText(caches, SHELL, '/icon-192.png')).toBe('new icon');
  });
});
