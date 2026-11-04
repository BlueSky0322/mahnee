// Rendering the whole app in a test (jsdom), against a small in-memory stand-in for the
// API. Screen tests drive it the way a person would: by what's on screen.

// IndexedDB, for the offline cache
import 'fake-indexeddb/auto';
import { cleanup, configure, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import type { Profile } from '@shared/api';
import { DEFAULT_SETTINGS } from '@shared/api';
import { rateDay } from '@shared/rates';
import { Root } from '../Root';
import { queryClient } from '../query-client';
import { clearCache } from '../offline/cache';

// The whole app renders in each test, which takes a while when every test file runs at
// once: wait longer than the default second for things to appear
configure({ asyncUtilTimeout: 4000 });

/** The screen tests run at: a computer, a tablet or a phone, and how wide each is */
const WIDTHS = { desktop: 1280, tablet: 820, phone: 390 };
let screenSize: keyof typeof WIDTHS = 'desktop';

/** Whether a width query, say "(min-width: 64em)", holds at the screen's width */
function matchesWidth(query: string) {
  const m = /\((min|max)-width:\s*([\d.]+)(em|px)\)/.exec(query);
  if (m == null) return false;
  const px = Number(m[2]) * (m[3] === 'em' ? 16 : 1);
  return m[1] === 'min' ? WIDTHS[screenSize] >= px : WIDTHS[screenSize] <= px;
}

// What jsdom doesn't have, and the app (or Mantine) uses
function stubBrowser() {
  window.matchMedia = (query: string) => ({
    matches: matchesWidth(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
}

/** The data the stand-in server holds; tests set it up and read it back */
export interface FakeServer {
  /**
   * Signed out (the sign-in expired) or down: every request is turned away. Unreachable:
   * no request gets there at all, as with no connection.
   */
  health: 'up' | 'signedOut' | 'down' | 'unreachable';
  me: Profile;
  /**
   * 1 `from` is `rate` `to`: today's by `${from}${to}`, an earlier day's by
   * `${from}${to}@2026-10-12`. Asked about a day with none, it's today's, as the real one does.
   */
  rates: Map<string, number>;
  /** The next save of the profile answers with this status */
  failNext: Partial<Record<'profile', number>>;
  /** Answers being held back until a test releases them (see holdNext) */
  held: { method: string; path: string; release: Promise<void> }[];
}

/**
 * Holds back the answer to the next `method` request for `path`: it's worked out when
 * the request arrives (so it shows the server as it was then) and delivered once
 * `release` is called. For putting answers in a different order than their requests.
 */
export function holdNext(server: FakeServer, method: string, path: string) {
  let release = () => {};
  server.held.push({ method, path, release: new Promise<void>((r) => (release = r)) });
  return { release };
}

const EMAIL = 'ryan@example.com';

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

/**
 * The rate from `from` into `to` at `at`, as the real server finds it: that day's when
 * there's one (from the ECB), else today's (from Wise); null when there's none
 */
function rateOn(server: FakeServer, from: string, to: string, at?: number) {
  const day = at == null ? null : rateDay(at);
  const onDay = day == null ? null : server.rates.get(`${from}${to}@${day}`);
  if (onDay != null) {
    return { rate: onDay, source: 'frankfurter' as const, at: Date.parse(`${day}T12:00:00Z`) };
  }
  const rate = server.rates.get(`${from}${to}`);
  return rate == null ? null : { rate, source: 'wise' as const, at: Date.now() };
}

/** Requests the app has made that the stand-in server hasn't answered yet */
let unanswered = 0;

function serve(server: FakeServer) {
  const answer = answerNow(server);
  const respond = (input: RequestInfo | URL, init?: RequestInit) => {
    const response = answer(input, init);
    const method = init?.method ?? 'GET';
    const path = new URL(input instanceof Request ? input.url : input, 'http://app').pathname;
    const at = server.held.findIndex((h) => h.method === method && h.path === path);
    if (at < 0) return response;
    const [{ release }] = server.held.splice(at, 1);
    return release.then(() => response);
  };
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const response = respond(input, init);
    // Counted alongside, so the app gets its answer exactly as before
    unanswered++;
    void response.then(
      () => unanswered--,
      () => unanswered--,
    );
    return response;
  };
}

/**
 * Waits until the app has nothing under way: no request unanswered, nothing loading or
 * saving, for a few turns in a row (work often waits on the device's storage between
 * requests). Gives up after a few seconds, for an answer a test never releases.
 */
async function settle() {
  if (vi.isFakeTimers()) return;
  const giveUpAt = Date.now() + 3000;
  for (let quiet = 0; quiet < 5 && Date.now() < giveUpAt; ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const busy = unanswered > 0 || queryClient.isFetching() > 0 || queryClient.isMutating() > 0;
    quiet = busy ? 0 : quiet + 1;
  }
}

function answerNow(server: FakeServer) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input, 'http://app');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    const path = url.pathname;

    if (server.health === 'unreachable') return Promise.reject(new TypeError('Failed to fetch'));
    if (server.health === 'signedOut') return json({ error: 'Signed out' }, 401);
    if (server.health === 'down') return json({ error: 'Internal error' }, 500);
    if (path === '/api/me' && method === 'GET') return json(server.me);
    const failing = (kind: keyof FakeServer['failNext']) => {
      const status = server.failNext[kind];
      delete server.failNext[kind];
      return status && json({ error: 'Something went wrong. Try again in a moment.' }, status);
    };
    if (path === '/api/me' && method === 'PATCH') {
      const failure = failing('profile');
      if (failure) return failure;
      const patch = body as Partial<Profile>;
      server.me = {
        ...server.me,
        ...('displayName' in patch ? { displayName: patch.displayName ?? null } : {}),
        settings: { ...server.me.settings, ...patch.settings },
      };
      return json(server.me);
    }
    if (path === '/api/rates') {
      const [from, to] = [url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? ''];
      const at = url.searchParams.get('at');
      const found = rateOn(server, from, to, at == null ? undefined : Number(at));
      return found == null
        ? json({ error: 'No rate' }, 503)
        : json({ from, to, rate: found.rate, source: found.source, fetchedAt: found.at });
    }
    return json({ error: `No stand-in for ${method} ${path}` }, 404);
  };
}

/** A fresh server with the signed-in account */
export function fakeServer(): FakeServer {
  return {
    health: 'up',
    me: { email: EMAIL, displayName: 'Ryan', settings: { ...DEFAULT_SETTINGS } },
    rates: new Map(),
    failNext: {},
    held: [],
  };
}

/** Renders the app at `path`, talking to `server` */
export function renderApp(
  server: FakeServer,
  path = '/',
  { size = 'desktop' }: { size?: typeof screenSize } = {},
) {
  screenSize = size;
  vi.stubGlobal('innerWidth', WIDTHS[size]);
  vi.stubGlobal('fetch', vi.fn(serve(server)));
  window.history.replaceState(null, '', path);
  return render(createElement(Root));
}

/** Call in a screen test's file: a browser to render into, emptied between tests */
export function setupAppTests() {
  beforeEach(() => {
    stubBrowser();
    // What the app tries again, it tries again straight away
    queryClient.setDefaultOptions({
      ...queryClient.getDefaultOptions(),
      queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 },
    });
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(async () => {
    cleanup();
    // What the test set going finishes now, rather than landing in the next test as its data
    await settle();
    queryClient.clear();
    // The device's cache, and whose it is, start empty for the next test
    await clearCache();
    vi.unstubAllGlobals();
  });
}
