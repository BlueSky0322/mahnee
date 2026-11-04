import { afterEach, describe, expect, it, vi } from 'vitest';
import { RatesUnavailable, getRate, getRateOn } from './exchange-rates';

// A cache that behaves like Cloudflare's for these tests, keeping each copy's headers
const memoryCache = () => {
  const store = new Map<string, { body: string; headers: Headers }>();
  const cache = {
    match: (key: string) => {
      const kept = store.get(key);
      return Promise.resolve(kept && new Response(kept.body, { headers: kept.headers }));
    },
    put: async (key: string, res: Response) => {
      store.set(key, { body: await res.text(), headers: new Headers(res.headers) });
    },
  } as unknown as Cache;
  /** How long Cloudflare is told to keep each copy */
  const keptFor = () => [...store.values()].map((kept) => kept.headers.get('Cache-Control'));
  return Object.assign(cache, { keptFor });
};

type Answer = (init?: RequestInit) => Response | Promise<Response>;

/** Answers Wise and Frankfurter requests from the given handlers, counting and keeping them */
function services(wise: Answer, frankfurter: Answer) {
  const calls = { wise: 0, frankfurter: 0 };
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push({ url, init });
    if (url.includes('/v1/rates')) {
      calls.wise++;
      return wise(init);
    }
    calls.frankfurter++;
    return frankfurter(init);
  };
  return { calls, requests, fetch: fetchImpl };
}

const ok = (body: unknown) => new Response(JSON.stringify(body));
const wiseRate = (rate: number) => () => ok([{ rate, source: 'USD', target: 'MYR' }]);
const ecbRate = (rate: number) => () => ok({ base: 'USD', rates: { MYR: rate } });
const down = () => new Response('down', { status: 500 });
const raw = (body: string) => () => new Response(body);
const rejected = () => Promise.reject(new TypeError('fetch failed'));
const timedOut = () => Promise.reject(new DOMException('timed out', 'TimeoutError'));

afterEach(() => {
  vi.restoreAllMocks();
});

/** getRate with no cache and a fixed clock, keeping provider errors out of the output */
const rateFrom = (s: ReturnType<typeof services>, prefer?: 'wise' | 'ecb') => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return getRate({ WISE_TOKEN: 't' }, 'USD', 'MYR', {
    deps: { fetch: s.fetch, cache: null, now: () => 1 },
    prefer,
  });
};

// Each is an unusable answer, or no answer, from a service
const unusable: [string, Answer][] = [
  ['an error status', down],
  ['a rejected request', rejected],
  ['a timed-out request', timedOut],
  ['a body that is not JSON', raw('<html>oops</html>')],
  ['JSON null', raw('null')],
];
const badWise: [string, Answer][] = [
  ...unusable,
  ['a zero rate', wiseRate(0)],
  ['a negative rate', wiseRate(-4.2)],
  ['an infinite rate', raw('[{"rate":1e999}]')],
  ['a rate as a string', () => ok([{ rate: '4.2' }])],
  ['a null rate', () => ok([{ rate: null }])],
  ['no rate', () => ok([{ source: 'USD', target: 'MYR' }])],
  ['an empty list', () => ok([])],
  ['an object instead of a list', () => ok({ rate: 4.2 })],
];
const badEcb: [string, Answer][] = [
  ...unusable,
  ['a currency it does not cover (404)', () => new Response('', { status: 404 })],
  ['a currency it does not cover (422)', () => new Response('', { status: 422 })],
  ['a zero rate', ecbRate(0)],
  ['a negative rate', ecbRate(-4.1)],
  ['an infinite rate', raw('{"rates":{"MYR":1e999}}')],
  ['a rate as a string', () => ok({ rates: { MYR: '4.1' } })],
  ['no rate for the currency', () => ok({ rates: { SGD: 1.3 } })],
  ['no rates at all', () => ok({ base: 'USD' })],
  ['rates as null', () => ok({ rates: null })],
];

describe('getRate', () => {
  it('uses Wise when there is a token', async () => {
    const s = services(wiseRate(4.2), ecbRate(4.1));
    const rate = await getRate({ WISE_TOKEN: 't' }, 'USD', 'MYR', {
      deps: { fetch: s.fetch, cache: null, now: () => 1 },
    });
    expect(rate).toEqual({ rate: 4.2, source: 'wise', fetchedAt: 1 });
    expect(s.calls.frankfurter).toBe(0);
  });

  it('falls back to Frankfurter without a token', async () => {
    const deps = (s: ReturnType<typeof services>) => ({
      fetch: s.fetch,
      cache: null,
      now: () => 1,
    });
    const noToken = services(wiseRate(4.2), ecbRate(4.1));
    expect((await getRate({}, 'USD', 'MYR', { deps: deps(noToken) })).source).toBe('frankfurter');
    expect(noToken.calls.wise).toBe(0);
  });

  it('fetches as usual when the cache cannot be read, or holds something unreadable', async () => {
    const failing = {
      match: () => Promise.reject(new Error('cache unavailable')),
      put: () => Promise.resolve(),
    } as unknown as Cache;
    const s = services(down, ecbRate(4.1));
    expect(
      await getRate({}, 'USD', 'MYR', { deps: { fetch: s.fetch, cache: failing, now: () => 1 } }),
    ).toEqual({ rate: 4.1, source: 'frankfurter', fetchedAt: 1 });

    for (const kept of ['{"rate":', 'null', '{"rate":"lots","source":"wise","fetchedAt":1}']) {
      const garbled = {
        match: () => Promise.resolve(new Response(kept)),
        put: () => Promise.resolve(),
      } as unknown as Cache;
      const fresh = services(down, ecbRate(4.3));
      expect(
        await getRate({}, 'USD', 'MYR', {
          deps: { fetch: fresh.fetch, cache: garbled, now: () => 2 },
        }),
      ).toEqual({ rate: 4.3, source: 'frankfurter', fetchedAt: 2 });
    }
  });

  it('uses an old rate when both services are down, and fails with none', async () => {
    let now = 0;
    const cache = memoryCache();
    await getRate({}, 'USD', 'MYR', {
      deps: { ...services(down, ecbRate(4.1)), cache, now: () => now },
    });
    now = 5 * 60 * 60 * 1000;
    const outage = services(down, down);
    expect(
      await getRate({}, 'USD', 'MYR', { deps: { fetch: outage.fetch, cache, now: () => now } }),
    ).toEqual({ rate: 4.1, source: 'frankfurter', fetchedAt: 0 });
    await expect(
      getRate({}, 'USD', 'SGD', { deps: { fetch: outage.fetch, cache, now: () => now } }),
    ).rejects.toBeInstanceOf(RatesUnavailable);
  });

  it('is 1 between the same currency, without asking anyone', async () => {
    const s = services(down, down);
    expect(
      (await getRate({}, 'MYR', 'MYR', { deps: { fetch: s.fetch, cache: null, now: () => 1 } }))
        .rate,
    ).toBe(1);
    expect(s.calls.wise + s.calls.frankfurter).toBe(0);
  });

  it('reuses a cached rate for 4 hours, unless a recent one is asked for', async () => {
    const cache = memoryCache();
    let now = 0;
    const s = services(wiseRate(4.2), ecbRate(4.1));
    const deps = { fetch: s.fetch, cache, now: () => now };
    await getRate({ WISE_TOKEN: 't' }, 'USD', 'MYR', { deps });
    // Cloudflare is told to keep each copy for a day
    expect(cache.keptFor()).toEqual([`max-age=${24 * 60 * 60}`]);
    now = 3 * 60 * 60 * 1000;
    expect((await getRate({ WISE_TOKEN: 't' }, 'USD', 'MYR', { deps })).fetchedAt).toBe(0);
    expect(s.calls.wise).toBe(1);
    // Refresh: anything older than 10 minutes is fetched again
    expect(
      (await getRate({ WISE_TOKEN: 't' }, 'USD', 'MYR', { deps, maxAgeMs: 10 * 60 * 1000 }))
        .fetchedAt,
    ).toBe(now);
    expect(s.calls.wise).toBe(2);
    now += 4 * 60 * 60 * 1000;
    await getRate({ WISE_TOKEN: 't' }, 'USD', 'MYR', { deps });
    expect(s.calls.wise).toBe(3);
  });

  it('asks the ECB first for people who prefer it, and falls back to Wise', async () => {
    const s = services(wiseRate(4.2), ecbRate(4.1));
    const deps = { fetch: s.fetch, cache: memoryCache(), now: () => 1 };
    const ecb = await getRate({ WISE_TOKEN: 't' }, 'USD', 'MYR', { deps, prefer: 'ecb' });
    expect(ecb).toMatchObject({ rate: 4.1, source: 'frankfurter' });
    expect(s.calls.wise).toBe(0);
    // Its own cache entry: someone preferring Wise still gets Wise's rate
    const wise = await getRate({ WISE_TOKEN: 't' }, 'USD', 'MYR', { deps });
    expect(wise).toMatchObject({ rate: 4.2, source: 'wise' });

    const noEcb = services(wiseRate(4.2), () => new Response('', { status: 404 }));
    const fallback = await getRate({ WISE_TOKEN: 't' }, 'USD', 'MYR', {
      deps: { fetch: noEcb.fetch, cache: null, now: () => 1 },
      prefer: 'ecb',
    });
    expect(fallback.source).toBe('wise');
  });

  it.each(badWise)('falls back to the ECB when Wise answers with %s', async (_name, wise) => {
    const s = services(wise, ecbRate(4.1));
    expect(await rateFrom(s)).toEqual({ rate: 4.1, source: 'frankfurter', fetchedAt: 1 });
    expect(s.calls).toEqual({ wise: 1, frankfurter: 1 });
  });

  it.each(badEcb)('falls back to Wise when the ECB answers with %s', async (_name, ecb) => {
    const s = services(wiseRate(4.2), ecb);
    expect(await rateFrom(s, 'ecb')).toEqual({ rate: 4.2, source: 'wise', fetchedAt: 1 });
    expect(s.calls).toEqual({ wise: 1, frankfurter: 1 });
  });

  // Each bad answer is shown above to fall through to the other service; with both bad,
  // a service down and one answering junk stand for the rest
  it.each([
    ['both down', down, down],
    ['Wise down, the ECB answering something that is not JSON', down, raw('<html>oops</html>')],
  ] as [string, Answer, Answer][])(
    'fails with RatesUnavailable when neither service gives a usable rate: %s',
    async (_name, wise, ecb) => {
      await expect(rateFrom(services(wise, ecb))).rejects.toBeInstanceOf(RatesUnavailable);
    },
  );

  it('gives up on a service that does not answer in 4 seconds', async () => {
    // Stands in for the timeout so the test needn't wait: the signal fires at once
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => AbortSignal.abort(new DOMException('timed out', 'TimeoutError')));
    const hangs: Answer = (init) =>
      new Promise((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason as Error);
        signal?.addEventListener('abort', () => reject(signal.reason as Error));
      });
    const s = services(hangs, ecbRate(4.1));
    expect(await rateFrom(s)).toEqual({ rate: 4.1, source: 'frankfurter', fetchedAt: 1 });
    expect(timeout.mock.calls).toEqual([[4000], [4000]]);
    // Each request carries the signal made for it
    s.requests.forEach((r, n) => expect(r.init?.signal).toBe(timeout.mock.results[n].value));
  });

  it('asks each service for the pair, with the Wise token sent only to Wise', async () => {
    const s = services(down, ecbRate(4.1));
    await rateFrom(s);
    const [wise, ecb] = s.requests;
    const wiseUrl = new URL(wise.url);
    expect(wiseUrl.origin + wiseUrl.pathname).toBe('https://api.wise.com/v1/rates');
    expect(Object.fromEntries(wiseUrl.searchParams)).toEqual({ source: 'USD', target: 'MYR' });
    expect(new Headers(wise.init?.headers).get('Authorization')).toBe('Bearer t');
    expect(wise.init?.signal).toBeInstanceOf(AbortSignal);

    const ecbUrl = new URL(ecb.url);
    expect(ecbUrl.origin + ecbUrl.pathname).toBe('https://api.frankfurter.dev/v1/latest');
    expect(Object.fromEntries(ecbUrl.searchParams)).toEqual({ base: 'USD', symbols: 'MYR' });
    expect(new Headers(ecb.init?.headers).has('Authorization')).toBe(false);
    expect(ecb.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks the services at the addresses given in the environment', async () => {
    const s = services(down, ecbRate(4.1));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await getRate(
      { WISE_TOKEN: 't', WISE_BASE: 'http://wise.test', FRANKFURTER_BASE: 'http://ecb.test' },
      'USD',
      'MYR',
      { deps: { fetch: s.fetch, cache: null, now: () => 1 } },
    );
    expect(s.requests.map((r) => r.url)).toEqual([
      'http://wise.test/v1/rates?source=USD&target=MYR',
      'http://ecb.test/v1/latest?base=USD&symbols=MYR',
    ]);
  });

  it('still returns a fetched rate when keeping a copy of it fails', async () => {
    const s = services(wiseRate(4.2), ecbRate(4.1));
    const cache = {
      match: () => Promise.resolve(undefined),
      put: () => Promise.reject(new Error('cache full')),
    } as unknown as Cache;
    const rate = await getRate({ WISE_TOKEN: 't' }, 'USD', 'MYR', {
      deps: { fetch: s.fetch, cache, now: () => 1 },
    });
    expect(rate).toMatchObject({ rate: 4.2, source: 'wise' });
    expect(s.calls.frankfurter).toBe(0);
  });
});

describe('getRateOn', () => {
  const now = Date.parse('2026-10-17T09:00:00Z');
  // A Sunday: the ECB answers with the Friday before
  const sunday = Date.parse('2026-10-11T03:00:00Z');
  const deps = (s: ReturnType<typeof services>, cache: Cache | null = null) => ({
    fetch: s.fetch,
    cache,
    now: () => now,
  });
  const ecbOn = (date: string, rate: number) => () =>
    ok({ base: 'USD', date, rates: { MYR: rate } });
  const wiseAt = (time: string, rate: number) => () =>
    ok([{ rate, source: 'USD', target: 'MYR', time }]);

  it("takes today's live rate for an amount spent today", async () => {
    const s = services(wiseRate(4.2), ecbRate(4.1));
    const rate = await getRateOn({ WISE_TOKEN: 't' }, 'USD', 'MYR', now - 60_000, {
      deps: deps(s),
    });
    expect(rate).toEqual({ rate: 4.2, source: 'wise', fetchedAt: now });
  });

  it("takes the ECB's rate for an earlier day, the working day before on a weekend, said to be from that day", async () => {
    const s = services(wiseRate(4.2), ecbOn('2026-10-09', 4.08));
    const cache = memoryCache();
    const rate = await getRateOn({ WISE_TOKEN: 't' }, 'USD', 'MYR', sunday, {
      deps: deps(s, cache),
    });
    expect(rate).toEqual({
      rate: 4.08,
      source: 'frankfurter',
      fetchedAt: Date.parse('2026-10-11T12:00:00Z'),
    });
    expect(s.requests[0].url).toContain('/v1/2026-10-11?base=USD&symbols=MYR');
    expect(s.calls.wise).toBe(0);
    // A past day's rate never changes, so it's kept a month, and asked for only once
    expect(cache.keptFor()).toEqual([`max-age=${30 * 24 * 60 * 60}`]);
    await getRateOn({ WISE_TOKEN: 't' }, 'USD', 'MYR', sunday, { deps: deps(s, cache) });
    expect(s.calls.frankfurter).toBe(1);
  });

  it("uses Wise's rate only when Wise says it is from that day", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = () => new Response('', { status: 404 });
    const onDay = services(wiseAt('2026-10-11T12:00:00+0000', 0.14), missing);
    expect(
      await getRateOn({ WISE_TOKEN: 't' }, 'TWD', 'MYR', sunday, { deps: deps(onDay) }),
    ).toMatchObject({ rate: 0.14, source: 'wise' });
    expect(onDay.requests.at(-1)?.url).toContain('time=2026-10-11T12:00:00');

    // Today's rate in its place: not that day's, so today's rate is fetched as today's
    const today = services(wiseAt('2026-10-17T08:00:00+0000', 0.15), missing);
    expect(
      await getRateOn({ WISE_TOKEN: 't' }, 'TWD', 'MYR', sunday, { deps: deps(today) }),
    ).toEqual({ rate: 0.15, source: 'wise', fetchedAt: now });
  });

  it('refuses an ECB answer for a later day than the one asked', async () => {
    const s = services(down, ecbOn('2026-10-12', 4.1));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(getRateOn({}, 'USD', 'MYR', sunday, { deps: deps(s) })).resolves.toMatchObject({
      fetchedAt: now,
    });
  });

  it("throws rather than fall back to today's rate when a service is down or turns us away", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = () => new Response('', { status: 404 });
    for (const [wise, ecb] of [
      [wiseRate(4.2), down],
      [() => new Response('', { status: 429 }), missing],
      [() => new Response('', { status: 401 }), missing],
    ] as const) {
      const s = services(wise, ecb);
      await expect(
        getRateOn({ WISE_TOKEN: 't' }, 'USD', 'MYR', sunday, { deps: deps(s) }),
      ).rejects.toBeInstanceOf(RatesUnavailable);
    }
  });
});
