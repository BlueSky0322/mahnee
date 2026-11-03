// The service worker (public/sw.js) run as it would be in the browser, with the server
// stood in for.
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { vi } from 'vitest';

// Node's URL, since a browser-like test environment has its own
const source = readFileSync(
  fileURLToPath(new NodeURL('../../public/sw.js', import.meta.url)),
  'utf8',
);

/** How the server (or whatever is in the way) answers one request */
export type Answer =
  | {
      status: number;
      body?: string | null;
      redirected?: boolean;
      contentType?: string;
      headers?: Record<string, string>;
    }
  | { networkError: true };

function respond(answer: Answer) {
  if ('networkError' in answer) return Promise.reject(new TypeError('Failed to fetch'));
  const headers = {
    ...(answer.contentType && { 'Content-Type': answer.contentType }),
    ...answer.headers,
  };
  const res = new Response(answer.body ?? null, { status: answer.status, headers });
  if (answer.redirected) Object.defineProperty(res, 'redirected', { value: true });
  return Promise.resolve(res);
}

/** Where the app is served from, in these tests */
const ORIGIN = 'https://mahnee.test';

type Handlers = Record<string, (event: unknown) => void>;

/**
 * Runs the service worker's script, returning the events it listens for. `globals` (fetch,
 * caches) add to or replace what it is given here.
 */
function load(globals: object): Handlers {
  const handlers: Handlers = {};
  runInNewContext(source, {
    self: {
      addEventListener: (type: string, handler: (event: unknown) => void) =>
        (handlers[type] = handler),
      navigator: {},
      location: new URL(ORIGIN),
      skipWaiting: () => Promise.resolve(),
    },
    Headers,
    Response,
    TextEncoder,
    URL,
    URLSearchParams,
    // Through the test's own, so fake timers reach the service worker too
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    ...globals,
  });
  return handlers;
}

/** The browser's caches, kept in memory by URL, and shared by each page load in a test */
export function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  // As the browser does, a path is on the service worker's own address
  const urlOf = (request: Request | string) =>
    new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;
  return {
    stores,
    has: (name: string) => Promise.resolve(stores.has(name)),
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name: string) => Promise.resolve(stores.delete(name)),
    open: (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return Promise.resolve({
        match: (request: Request | string) => Promise.resolve(store.get(urlOf(request))?.clone()),
        put: (request: Request | string, response: Response) => {
          store.set(urlOf(request), response);
          return Promise.resolve();
        },
        keys: () => Promise.resolve([...store.keys()].map((url) => new Request(url))),
        delete: (request: Request | string) => Promise.resolve(store.delete(urlOf(request))),
      });
    },
  };
}

/** The paths kept in one of the browser's caches, in order */
export const keptPaths = (caches: ReturnType<typeof fakeCaches>, name: string) =>
  [...(caches.stores.get(name)?.keys() ?? [])].map((url) => new URL(url).pathname).sort();

/** What a kept response says, or undefined when nothing is kept at `path` */
export const keptText = (caches: ReturnType<typeof fakeCaches>, name: string, path: string) =>
  caches.stores.get(name)?.get(`${ORIGIN}${path}`)?.clone().text();

/**
 * How the server answers each path; a promise for an answer that takes a while. Also
 * a redirect to sign in, which the browser hands a page's request as it is.
 */
export type Site = (path: string) => Answer | { signIn: true } | Promise<Answer>;

/** The response the browser would hand the service worker for `answer` */
async function siteResponse(answer: Awaited<ReturnType<Site>>) {
  if ('signIn' in answer) {
    const res = new Response(null);
    Object.defineProperties(res, {
      type: { value: 'opaqueredirect' },
      status: { value: 0 },
      ok: { value: false },
    });
    return res;
  }
  const res = await respond(answer);
  // From the app's own address, as the browser marks it
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

/**
 * The browser opening `path` (a page load, or a fresh start of the installed app)
 * through the service worker, with the server answering as `site` says. `response` is
 * what the page gets (null when it fails, as with no connection); `done` settles once
 * the service worker has finished what it carries on with afterwards.
 */
export function openPage(path: string, site: Site, caches: ReturnType<typeof fakeCaches>) {
  const fetch = vi.fn(async (request: string | { url: string }) =>
    siteResponse(
      await site(new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname),
    ),
  );
  const handlers = load({ fetch, caches });
  const background: Promise<unknown>[] = [];
  let answered: Promise<Response> | null = null;
  handlers.fetch({
    // A page load: what Request can't be made with outside the browser
    request: { url: `${ORIGIN}${path}`, method: 'GET', mode: 'navigate' },
    respondWith: (r: Promise<Response>) => (answered = r),
    waitUntil: (work: Promise<unknown>) => background.push(work),
  });
  if (answered == null) throw new Error(`The service worker left ${path} to the browser`);
  return {
    fetch,
    response: (answered as Promise<Response>).catch(() => null),
    done: Promise.allSettled(background).then(() => undefined),
  };
}

/** The service worker being installed, as after a deploy, with the server answering as `site` says */
export async function install(site: Site, caches: ReturnType<typeof fakeCaches>) {
  const fetch = vi.fn(async (request: string) => siteResponse(await site(request)));
  const handlers = load({ fetch, caches });
  let done: Promise<unknown> = Promise.resolve();
  handlers.install({ waitUntil: (work: Promise<unknown>) => (done = work) });
  await done;
  return { fetch };
}

/**
 * The page asks for `path` (on the app's own address, or a full address elsewhere)
 * through the service worker, which reaches the network (answering with `answer`) or
 * answers from `caches`. The response
 * is null when the request fails, as with no connection.
 */
export async function fetchThroughWorker(
  path: string,
  answer: Answer,
  caches: ReturnType<typeof fakeCaches>,
) {
  const fetch = vi.fn<(request: Request, init?: RequestInit) => Promise<Response>>(async () => {
    const res = await respond(answer);
    // From the app's own address, as the browser marks it
    Object.defineProperty(res, 'type', { value: 'basic' });
    return res;
  });
  const handlers = load({ fetch, caches });
  const background: Promise<unknown>[] = [];
  let answered: Promise<Response> | null = null;
  handlers.fetch({
    request: new Request(path.startsWith('https://') ? path : `${ORIGIN}${path}`),
    respondWith: (r: Promise<Response>) => (answered = r),
    waitUntil: (work: Promise<unknown>) => background.push(work),
  });
  if (answered == null) throw new Error(`The service worker left ${path} to the browser`);
  const response = await (answered as Promise<Response>).catch(() => null);
  // What it carries on with afterwards (keeping a copy, say)
  await Promise.allSettled(background);
  return { fetch, response };
}
