// Exchange rates for converting amounts between currencies: Wise's live mid-market
// rate (when a token is set) and the ECB's daily rate from Frankfurter (free, no key),
// the one the person prefers tried first and the other after.
// Each pair is kept in Cloudflare's cache and reused for 4 hours, so a day costs the
// services a few requests per pair, and a day-old rate still serves if both are down.
// A refresh asks for one no older than 10 minutes.
// An amount is converted at the rate on the day it was spent (getRateOn): today's live
// rate, or for an earlier day the ECB's rate for it, then Wise's.

import {
  DEFAULT_SETTINGS,
  type FetchedRateSource,
  RATE_PREFERENCES,
  RATE_PROVIDERS,
  type RatePreference,
} from '../../shared/api';
import { isValidRate, rateDay } from '../../shared/rates';

export interface RatesEnv {
  /** Wise personal API token (a Worker secret); without it Wise is skipped */
  WISE_TOKEN?: string;
  /** Overridable so tests can stand in for the services */
  WISE_BASE?: string;
  FRANKFURTER_BASE?: string;
}

export interface Rate {
  rate: number;
  source: FetchedRateSource;
  /**
   * When the rate was fetched from the service, in ms; for an earlier day's rate, noon
   * UTC on that day, so it reads as that day wherever people are
   */
  fetchedAt: number;
}

export class RatesUnavailable extends Error {}

/** Fresh for this long; older copies are refetched but still used if that fails */
const FRESH_MS = 4 * 60 * 60 * 1000;
/** How old a rate may be when someone presses Refresh */
export const REFRESH_MAX_AGE_MS = 10 * 60 * 1000;
/** How long Cloudflare keeps a copy at all */
const KEEP_SECONDS = 24 * 60 * 60;
/** An earlier day's rate never changes, so its copy is kept longer */
const KEEP_DAY_SECONDS = 30 * 24 * 60 * 60;
const TIMEOUT_MS = 4000;

export interface Deps {
  fetch: typeof fetch;
  /** Null where there's no cache, as in unit tests */
  cache: Cache | null;
  now: () => number;
}

const defaultDeps = (): Deps => ({
  fetch: (input, init) => fetch(input, init),
  cache: typeof caches === 'undefined' ? null : caches.default,
  now: Date.now,
});

export interface RateOptions {
  /** Use a cached rate younger than this rather than fetching */
  maxAgeMs?: number;
  /** Wise first (the default), or the ECB first for people who picked it in Settings */
  prefer?: RatePreference;
  /** The network, cache and clock; tests stand in for them */
  deps?: Deps;
}

const cacheKey = (from: string, to: string, prefer: RatePreference) =>
  `https://rates.internal/v1/${prefer}/${from}/${to}`;

async function fromWise(env: RatesEnv, from: string, to: string, deps: Deps) {
  if (!env.WISE_TOKEN) return null;
  const base = env.WISE_BASE ?? 'https://api.wise.com';
  const res = await deps.fetch(`${base}/v1/rates?source=${from}&target=${to}`, {
    headers: { Authorization: `Bearer ${env.WISE_TOKEN}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Wise rates: ${res.status}`);
  const body = await res.json<{ rate?: unknown }[]>();
  return isValidRate(body[0]?.rate) ? body[0].rate : null;
}

async function fromFrankfurter(env: RatesEnv, from: string, to: string, deps: Deps) {
  const base = env.FRANKFURTER_BASE ?? 'https://api.frankfurter.dev';
  const res = await deps.fetch(`${base}/v1/latest?base=${from}&symbols=${to}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // Frankfurter answers 404 or 422 for currencies it doesn't cover
  if (res.status === 404 || res.status === 422) return null;
  if (!res.ok) throw new Error(`Frankfurter: ${res.status}`);
  const body = await res.json<{ rates?: Record<string, unknown> }>();
  const rate = body.rates?.[to];
  return isValidRate(rate) ? rate : null;
}

const FETCHERS: Record<FetchedRateSource, typeof fromWise> = {
  wise: fromWise,
  frankfurter: fromFrankfurter,
};

const isRate = (kept: unknown): kept is Rate => {
  const r = kept as Partial<Rate> | null;
  return (
    isValidRate(r?.rate) &&
    typeof r?.fetchedAt === 'number' &&
    Object.values(RATE_PROVIDERS).includes(r.source as FetchedRateSource)
  );
};

/**
 * The copy kept in the cache, if there's a usable one. The cache is a bonus, as when
 * keeping a copy: one that can't be read, or holds something that isn't a rate, is
 * the same as none, and the services are asked instead.
 */
async function readKept(cache: Cache | null, key: string): Promise<Rate | null> {
  if (!cache) return null;
  try {
    const kept = await cache.match(key);
    const rate = kept ? await kept.json<unknown>() : null;
    return isRate(rate) ? rate : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** Keeps a copy of a rate. A bonus: a rate that can't be cached is still the rate. */
async function keep(cache: Cache | null, key: string, rate: Rate, seconds: number) {
  await cache
    ?.put(
      key,
      new Response(JSON.stringify(rate), { headers: { 'Cache-Control': `max-age=${seconds}` } }),
    )
    .catch((err: unknown) => console.error(err));
}

/** The rate to convert `from` into `to`: 1 unit of `from` is `rate` units of `to` */
export async function getRate(
  env: RatesEnv,
  from: string,
  to: string,
  {
    maxAgeMs = FRESH_MS,
    prefer = DEFAULT_SETTINGS.ratePreference,
    deps = defaultDeps(),
  }: RateOptions = {},
): Promise<Rate> {
  // Nothing to fetch; named after the service the person chose, which a fetch would use
  if (from === to) return { rate: 1, source: RATE_PROVIDERS[prefer], fetchedAt: deps.now() };

  const key = cacheKey(from, to, prefer);
  const saved = await readKept(deps.cache, key);
  if (saved && deps.now() - saved.fetchedAt < maxAgeMs) return saved;

  // The ECB doesn't publish every currency, so the other service is always the fallback
  const order = [prefer, ...RATE_PREFERENCES.filter((p) => p !== prefer)];
  for (const preference of order) {
    const source = RATE_PROVIDERS[preference];
    let rate: number | null;
    try {
      rate = await FETCHERS[source](env, from, to, deps);
    } catch (err) {
      console.error(err);
      continue;
    }
    if (rate == null) continue;
    const fresh: Rate = { rate, source, fetchedAt: deps.now() };
    await keep(deps.cache, key, fresh, KEEP_SECONDS);
    return fresh;
  }

  // Both down: an older rate beats none
  if (saved) return saved;
  throw new RatesUnavailable(`No rate for ${from} to ${to} right now`);
}

/** getRate, or null when neither service has the rate (nor a copy of it) */
export const rateOrNull = (env: RatesEnv, from: string, to: string, options?: RateOptions) =>
  getRate(env, from, to, options).catch((err: unknown) => {
    if (err instanceof RatesUnavailable) return null;
    throw err;
  });

/**
 * A service saying it has no rate for that day or those currencies, as opposed to one
 * that's down, turning us away (a token, too many requests) or failing
 */
const noRateFor = (status: number) => status === 400 || status === 404 || status === 422;

/** The ECB's rate on a day, or on the working day before it when it publishes none */
async function frankfurterOn(env: RatesEnv, from: string, to: string, day: string, deps: Deps) {
  const base = env.FRANKFURTER_BASE ?? 'https://api.frankfurter.dev';
  const res = await deps.fetch(`${base}/v1/${day}?base=${from}&symbols=${to}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (noRateFor(res.status)) return null;
  if (!res.ok) throw new Error(`Frankfurter: ${res.status}`);
  const body = await res.json<{ date?: unknown; rates?: Record<string, unknown> }>();
  const rate = body.rates?.[to];
  // A rate for a later day isn't that day's
  const forDay = typeof body.date === 'string' && body.date <= day;
  return forDay && isValidRate(rate) ? rate : null;
}

/**
 * Wise's rate at noon UTC on a day. Used only if Wise says the rate is from that day,
 * so an answer with today's rate instead is no answer.
 */
async function wiseOn(env: RatesEnv, from: string, to: string, day: string, deps: Deps) {
  if (!env.WISE_TOKEN) return null;
  const base = env.WISE_BASE ?? 'https://api.wise.com';
  const res = await deps.fetch(
    `${base}/v1/rates?source=${from}&target=${to}&time=${day}T12:00:00`,
    {
      headers: { Authorization: `Bearer ${env.WISE_TOKEN}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (noRateFor(res.status)) return null;
  if (!res.ok) throw new Error(`Wise rates: ${res.status}`);
  const body = await res.json<{ rate?: unknown; time?: unknown }[]>();
  const { rate, time } = body[0] ?? {};
  // Wise writes the offset as +0000, which not every date parser reads
  const at =
    typeof time === 'string' ? Date.parse(time.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
  return Number.isFinite(at) && rateDay(at) === day && isValidRate(rate) ? rate : null;
}

const DAY_FETCHERS: [FetchedRateSource, typeof frankfurterOn][] = [
  ['frankfurter', frankfurterOn],
  ['wise', wiseOn],
];

/**
 * The rate to convert an amount spent at `at`: the live rate (getRate) for one spent today,
 * and for an earlier day the ECB's rate on it, else Wise's. When neither has that day's
 * rate for these currencies (the ECB doesn't publish them all), it's today's rate, which
 * then says so by its date. A service that is down throws RatesUnavailable instead, so
 * the change is tried again rather than settling for today's rate.
 */
export async function getRateOn(
  env: RatesEnv,
  from: string,
  to: string,
  at: number,
  { prefer, deps = defaultDeps() }: Omit<RateOptions, 'maxAgeMs'> = {},
): Promise<Rate> {
  const day = rateDay(at);
  if (from === to || day >= rateDay(deps.now())) return getRate(env, from, to, { prefer, deps });

  const key = `https://rates.internal/v1/day/${day}/${from}/${to}`;
  const saved = await readKept(deps.cache, key);
  if (saved) return saved;

  let down = false;
  for (const [source, fetcher] of DAY_FETCHERS) {
    let rate: number | null;
    try {
      rate = await fetcher(env, from, to, day, deps);
    } catch (err) {
      console.error(err);
      down = true;
      continue;
    }
    if (rate == null) continue;
    const found: Rate = { rate, source, fetchedAt: Date.parse(`${day}T12:00:00Z`) };
    await keep(deps.cache, key, found, KEEP_DAY_SECONDS);
    return found;
  }
  if (down) throw new RatesUnavailable(`No rate for ${from} to ${to} on ${day} right now`);
  return getRate(env, from, to, { prefer, deps });
}
