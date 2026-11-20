import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../app';
import { stepRates } from './convert-queue';
import { MAX_RATE_REQUESTS, RatesUnavailable } from './exchange-rates';

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
