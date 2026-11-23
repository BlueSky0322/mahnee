import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../app';
import { stepRates } from './convert-queue';
import { MAX_RANGE_DAYS, MAX_RATE_REQUESTS, RatesUnavailable } from './exchange-rates';

// The rates a conversion step converts at (stepRates), against stand-ins for the services:
// Frankfurter has nothing for VND, and Wise only today's rate.

const env = {
  WISE_TOKEN: 't',
  WISE_BASE: 'https://wise.test',
  FRANKFURTER_BASE: 'https://ecb.test',
} as unknown as Env;

/** Answers each request with `answer`, keeping the addresses asked */
function services(answer: (url: string) => Response) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    asked.push(url);
    return Promise.resolve(answer(url));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return asked;
}

const todayOnly = (url: string) =>
  url.startsWith('https://wise.test') && !url.includes('time=')
    ? new Response(JSON.stringify([{ rate: 0.00019 }]))
    : new Response('', { status: 404 });

/** Each of `count` days in a row from 2025-03-01 */
const days = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2025, 2, 1) + i * 86_400_000).toISOString().slice(0, 10),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a step’s rates', () => {
  it('answer none, rather than fail, once the step has asked as often as it may', async () => {
    const asked = services(todayOnly);
    const rateOf = stepRates(env, 'wise');
    const answers = [];
    for (const day of days(20)) answers.push(await rateOf('VND', 'MYR', day));
    expect(asked).toHaveLength(MAX_RATE_REQUESTS);
    expect(new Set(asked).size).toBe(asked.length);
    const first = answers.indexOf(null);
    expect(first).toBeGreaterThan(0);
    expect(answers.slice(0, first).every((r) => r?.rate === 0.00019)).toBe(true);
    expect(answers.slice(first)).toEqual(answers.slice(first).map(() => null));
    // The next step asks afresh
    expect(await stepRates(env, 'wise')('VND', 'MYR', '2025-04-01')).toMatchObject({
      rate: 0.00019,
    });
  });

  it('still fail when a service is down, so the step is tried again', async () => {
    services(() => new Response('', { status: 500 }));
    await expect(stepRates(env, 'wise')('VND', 'MYR', '2025-03-01')).rejects.toBeInstanceOf(
      RatesUnavailable,
    );
  });
});

/** Frankfurter's days for MYR to USD: each working day's rate, as its range answer gives them */
function ecbDays(rates: Record<string, number>, down: (url: string) => boolean = () => false) {
  return (url: string) => {
    if (down(url)) return new Response('', { status: 500 });
    const range = /\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})\?/.exec(url);
    if (url.startsWith('https://ecb.test') && range != null) {
      const [, start, end] = range;
      const inRange = Object.entries(rates).filter(([d]) => d >= start && d <= end);
      // As the real one does: it starts at the working day on or before the first asked
      const before = Object.keys(rates)
        .filter((d) => d < start)
        .sort()
        .at(-1);
      const all = before == null ? inRange : [[before, rates[before]] as const, ...inRange];
      return new Response(
        JSON.stringify({
          base: 'MYR',
          rates: Object.fromEntries(all.map(([d, r]) => [d, { USD: r }])),
        }),
      );
    }
    return todayOnly(url);
  };
}

describe('a step’s rates for a range of days', () => {
  it('asks each service once for every day a page needs, not once a day', async () => {
    const rates = Object.fromEntries(days(60).map((d, i) => [d, 0.2 + i / 10_000]));
    const asked = services(ecbDays(rates));
    const rateOf = stepRates(env, 'wise');
    await rateOf.prefetch!('MYR', 'USD', days(60));
    const answers = [];
    for (const day of days(60)) answers.push(await rateOf('MYR', 'USD', day));
    // One request for each fixed span of days they (and the fortnight before) fall in
    expect(asked.filter((u) => u.startsWith('https://ecb.test')).length).toBeLessThanOrEqual(2);
    // Every one at its own day's rate, saying the day, as one day at a time would
    expect(answers.map((r) => r?.rate)).toEqual(days(60).map((d) => rates[d]));
    expect(answers.every((r, i) => r?.day === days(60)[i] && r.source === 'frankfurter')).toBe(
      true,
    );
  });

  it('gives a weekend or a holiday the working day before it, up to a week', async () => {
    // Friday 7 March 2025 has a rate; Saturday and Sunday have none; then a gap of 10 days
    const rates = { '2025-03-07': 0.21, '2025-03-10': 0.22, '2025-03-21': 0.23 };
    const asked = services(ecbDays(rates));
    const rateOf = stepRates(env, 'wise');
    const wanted = ['2025-03-08', '2025-03-09', '2025-03-10', '2025-03-17', '2025-03-19'];
    await rateOf.prefetch!('MYR', 'USD', wanted);
    const answers = await Promise.all(wanted.map((d) => rateOf('MYR', 'USD', d)));
    expect(answers.map((r) => [r?.rate, r?.day])).toEqual([
      [0.21, '2025-03-07'],
      [0.21, '2025-03-07'],
      [0.22, '2025-03-10'],
      [0.22, '2025-03-10'],
      // Nine days after the last rate: past a week, so today's (Wise's live) rate
      [0.00019, undefined],
    ]);
    const ecb = asked.filter((u) => u.startsWith('https://ecb.test'));
    expect(ecb.length).toBeLessThanOrEqual(2);
    expect(ecb.every((u) => u.includes('..'))).toBe(true);
  });

  it('asks for two years of days in a handful of ranges of at most MAX_RANGE_DAYS', async () => {
    const asked = services(ecbDays({}));
    const rateOf = stepRates(env, 'wise');
    const year = Array.from({ length: 700 }, (_, i) =>
      new Date(Date.UTC(2023, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    );
    await rateOf.prefetch!('MYR', 'USD', year);
    const ranges = asked
      .filter((u) => u.startsWith('https://ecb.test'))
      .map((u) => /\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(u))
      .filter((m) => m != null);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.length).toBeLessThanOrEqual(Math.ceil((700 + 14) / MAX_RANGE_DAYS) + 1);
    // With no ECB rate close to any day, Wise is asked too, a month at a time, and the whole
    // stays within what one step may ask
    expect(asked.length).toBeLessThanOrEqual(MAX_RATE_REQUESTS);
    for (const [, start, end] of ranges) {
      expect((Date.parse(end) - Date.parse(start)) / 86_400_000 + 1).toBeLessThanOrEqual(
        MAX_RANGE_DAYS,
      );
    }
  });

  it('a range that fails leaves its days to be asked one at a time; the others are kept', async () => {
    const rates = Object.fromEntries(
      Array.from({ length: 700 }, (_, i) => {
        const d = new Date(Date.UTC(2023, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
        return [d, 0.2];
      }),
    );
    // The later range fails; one day at a time then answers for its days
    const asked = services((url) => {
      if (/\/v1\/2024-\d\d-\d\d\.\./.test(url)) return new Response('', { status: 500 });
      const one = /ecb\.test\/v1\/(\d{4}-\d{2}-\d{2})\?/.exec(url);
      if (one != null) {
        return new Response(JSON.stringify({ date: one[1], rates: { USD: 0.25 } }));
      }
      return ecbDays(rates)(url);
    });
    const rateOf = stepRates(env, 'wise');
    await rateOf.prefetch!('MYR', 'USD', ['2023-03-01', '2024-10-01']);
    expect((await rateOf('MYR', 'USD', '2023-03-01'))?.rate).toBe(0.2);
    expect((await rateOf('MYR', 'USD', '2024-10-01'))?.rate).toBe(0.25);
    expect(asked.filter((u) => /ecb\.test\/v1\/\d{4}-\d{2}-\d{2}\?/.test(u))).toHaveLength(1);
  });
});

describe('ranges kept for the next step', () => {
  it('a later step reads a range already asked for from the cache, asking nothing', async () => {
    const kept = new Map<string, string>();
    vi.stubGlobal('caches', {
      default: {
        match: (key: string) =>
          Promise.resolve(kept.has(key) ? new Response(kept.get(key)) : undefined),
        put: async (key: string, res: Response) => void kept.set(key, await res.text()),
      },
    });
    const rates = Object.fromEntries(days(30).map((d) => [d, 0.2]));
    const asked = services(ecbDays(rates));
    const first = stepRates(env, 'wise');
    await first.prefetch!('MYR', 'USD', days(30));
    const before = asked.length;
    expect(before).toBeGreaterThan(0);
    const next = stepRates(env, 'wise');
    await next.prefetch!('MYR', 'USD', days(30));
    expect((await next('MYR', 'USD', days(30)[10]))?.rate).toBe(0.2);
    expect(asked).toHaveLength(before);
  });
});
