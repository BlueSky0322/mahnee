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
  /**
   * For tests: "no" keeps no range of rates in the cache (the stand-in services gain rates
   * as tests go, which the real ones never do for a day gone by)
   */
  RATES_KEEP_RANGES?: string;
}

export interface Rate {
  rate: number;
  source: FetchedRateSource;
  /**
   * When the rate was fetched from the service, in ms; for an earlier day's rate, noon
   * UTC on that day
   */
  fetchedAt: number;
  /** For an earlier day's rate, the calendar day it's from (2026-11-12) */
  day?: string;
}

export class RatesUnavailable extends Error {}

/**
 * Every service answered, and none has a rate for the pair (nor a copy kept): asking again
 * won't find one, so a change needing it is refused rather than tried again. Still a
 * RatesUnavailable for everything that only needs to know there's no rate.
 */
export class NoRate extends RatesUnavailable {
  constructor(from: string, to: string) {
    super(`No rate for ${from} to ${to} is available`);
  }
}

/**
 * The services were asked as often as one conversion step or request may (RateLookups):
 * the rest wait for the next step, or the change is tried again
 */
export class LookupsSpent extends RatesUnavailable {}

/**
 * The most requests to the rate services and calls to the cache one conversion step or
 * request makes. They share the Worker's 50 subrequests a run on the free plan with the
 * step's few database calls and its queue message, so this leaves a margin; and it's above
 * the 20 one day's rate can take (each of 8 days from both services, then today's from
 * both, and reading and keeping that day's copy).
 */
export const MAX_RATE_REQUESTS = 36;

/**
 * The services' answers within one conversion step or request, so each day is asked
 * for at most once (found or not) and the requests stay within MAX_RATE_REQUESTS
 */
export class RateLookups {
  private readonly answers = new Map<string, Promise<unknown>>();
  private readonly known = new Set<string>();
  private requests = 0;

  constructor(private readonly limit = MAX_RATE_REQUESTS) {}

  /**
   * Notes what `key` is, found ahead of time (a range of days' rates fetched at once), so
   * asking for it later costs no request; one asked already keeps its answer
   */
  know<T>(key: string, value: T) {
    if (this.answers.has(key)) return;
    this.answers.set(key, Promise.resolve(value));
    this.known.add(key);
  }

  /** Whether `key` was found ahead of time (know) */
  knows(key: string) {
    return this.known.has(key);
  }

  /** What `ask` answers for `key`, asked once */
  once<T>(key: string, ask: () => Promise<T>): Promise<T> {
    let answer = this.answers.get(key) as Promise<T> | undefined;
    if (answer == null) {
      answer = ask();
      this.answers.set(key, answer);
    }
    return answer;
  }

  /** `deps` with each request counted, refused (LookupsSpent) past the limit */
  counted(deps: Deps): Deps {
    /** Runs `call` if there's room left, counting it; refused (LookupsSpent) otherwise */
    const spend = <T>(call: () => Promise<T>): Promise<T> => {
      if (this.requests >= this.limit) {
        return Promise.reject(new LookupsSpent('Asked for as many rates as one step may'));
      }
      this.requests++;
      return call();
    };
    const cache = deps.cache;
    return {
      ...deps,
      fetch: (input, init) => spend(() => deps.fetch(input, init)),
      // Each cache call counts too: the Worker counts them with its requests
      cache:
        cache == null
          ? null
          : ({
              match: (...args: Parameters<Cache['match']>) => spend(() => cache.match(...args)),
              put: (...args: Parameters<Cache['put']>) => spend(() => cache.put(...args)),
            } as Cache),
    };
  }

  /** How many more requests and cache calls this step may make */
  remaining() {
    return this.limit - this.requests;
  }
}

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
  /** Answers already had in this conversion step or request, and how many may be asked */
  lookups?: RateLookups;
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
  // Wise has no rate for the pair, as for an earlier day's (noRateFor); anything else is it failing
  if (noRateFor(res.status)) return null;
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
    if (!(err instanceof LookupsSpent)) console.error(err);
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
    .catch((err: unknown) => {
      if (!(err instanceof LookupsSpent)) console.error(err);
    });
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
  let down = false;
  for (const preference of order) {
    const source = RATE_PROVIDERS[preference];
    let rate: number | null;
    try {
      rate = await FETCHERS[source](env, from, to, deps);
    } catch (err) {
      if (err instanceof LookupsSpent) throw err;
      console.error(err);
      down = true;
      continue;
    }
    if (rate == null) continue;
    const fresh: Rate = { rate, source, fetchedAt: deps.now() };
    await keep(deps.cache, key, fresh, KEEP_SECONDS);
    return fresh;
  }

  // Both down: an older rate beats none
  if (saved) return saved;
  if (!down) throw new NoRate(from, to);
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

/** A rate found for a day, and the day it is really from (on or before the one asked) */
type DayRate = { rate: number; day: string } | null;

/** The ECB's rate on a day, or on the working day before it when it publishes none */
async function frankfurterOn(
  env: RatesEnv,
  from: string,
  to: string,
  day: string,
  deps: Deps,
): Promise<DayRate> {
  const base = env.FRANKFURTER_BASE ?? 'https://api.frankfurter.dev';
  const res = await deps.fetch(`${base}/v1/${day}?base=${from}&symbols=${to}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (noRateFor(res.status)) return null;
  if (!res.ok) throw new Error(`Frankfurter: ${res.status}`);
  const body = await res.json<{ date?: unknown; rates?: Record<string, unknown> }>();
  const rate = body.rates?.[to];
  // A rate for a later day isn't that day's; one for an earlier day says so
  const forDay = typeof body.date === 'string' && DAY.test(body.date) && body.date <= day;
  return forDay && isValidRate(rate) ? { rate, day: body.date as string } : null;
}

/**
 * Wise's rate at noon UTC on a day. Used only if Wise says the rate is from that day,
 * so an answer with today's rate instead is no answer.
 */
async function wiseOn(
  env: RatesEnv,
  from: string,
  to: string,
  day: string,
  deps: Deps,
): Promise<DayRate> {
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
  // The latest point at or before noon that day (Wise answers one a little before it)
  return isWiseNoonPoint(wiseTime(time), day) && isValidRate(rate) ? { rate, day } : null;
}

/** Noon UTC, in ms into a day */
const NOON_MS = 12 * 60 * 60 * 1000;

/** A time as Wise writes it (2026-09-15T11:59:14+0000), in ms; NaN when it isn't one */
const wiseTime = (time: unknown) =>
  typeof time === 'string' ? Date.parse(time.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;

/**
 * Wise's rate for a day: its latest point at or before noon UTC on that day, the same rule
 * whether the day is asked for alone or in a range
 */
const isWiseNoonPoint = (at: number, day: string) =>
  Number.isFinite(at) && rateDay(at) === day && at % (24 * 60 * 60 * 1000) <= NOON_MS;

const DAY_FETCHERS: [FetchedRateSource, typeof frankfurterOn][] = [
  ['frankfurter', frankfurterOn],
  ['wise', wiseOn],
];

/** How many days before an entry's own a rate may come from, when no service has its day's */
export const MAX_EARLIER_DAYS = 7;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day `days` before `day` (2026-11-12) */
const daysBefore = (day: string, days: number) =>
  rateDay(Date.parse(`${day}T12:00:00Z`) - days * 24 * 60 * 60 * 1000);

/**
 * The rate to convert an amount spent at `at`: the live rate (getRate) for one spent today,
 * and for an earlier day the ECB's rate on it, else Wise's (with its history, for the
 * currencies the ECB doesn't publish, as VND). When neither has that day's, it's the
 * closest earlier day either has, up to MAX_EARLIER_DAYS before, then today's rate. The
 * rate's time (`fetchedAt`) is always on the day it's really from, so what's kept never
 * claims a day it didn't use. A service that is down throws RatesUnavailable instead, so
 * the change is tried again rather than settling for another day's rate. Within `lookups`
 * (one conversion step or request), each service is asked about each day once, and past
 * its limit LookupsSpent is thrown.
 */
export function getRateOn(
  env: RatesEnv,
  from: string,
  to: string,
  at: number,
  { prefer, deps = defaultDeps(), lookups = new RateLookups() }: Omit<RateOptions, 'maxAgeMs'> = {},
): Promise<Rate> {
  const day = rateDay(at);
  return lookups.once(`on ${prefer ?? ''} ${from} ${to} ${day}`, () =>
    rateOn(env, from, to, day, prefer, lookups.counted(deps), lookups),
  );
}

async function rateOn(
  env: RatesEnv,
  from: string,
  to: string,
  day: string,
  prefer: RatePreference | undefined,
  deps: Deps,
  lookups: RateLookups,
): Promise<Rate> {
  const live = () =>
    lookups.once(`live ${prefer ?? ''} ${from} ${to}`, () =>
      getRate(env, from, to, { prefer, deps }),
    );
  if (from === to || day >= rateDay(deps.now())) return live();

  // v2: each copy says its day. A day a range answered (prefetchRatesOn) is kept with its
  // range, so it costs no cache call here
  const key = `https://rates.internal/v2/day/${day}/${from}/${to}`;
  const ranged = lookups.knows(`frankfurter ${from} ${to} ${day}`);
  const saved = ranged ? null : await readKept(deps.cache, key);
  if (saved) return saved;

  for (let earlier = 0; earlier <= MAX_EARLIER_DAYS; earlier++) {
    const asked = daysBefore(day, earlier);
    let down = false;
    for (const [source, fetcher] of DAY_FETCHERS) {
      let found: DayRate;
      try {
        // Each service asked about each day once, whichever entry's day it's for
        found = await lookups.once(`${source} ${from} ${to} ${asked}`, () =>
          fetcher(env, from, to, asked, deps),
        );
      } catch (err) {
        if (err instanceof LookupsSpent) throw err;
        console.error(err);
        down = true;
        continue;
      }
      // An answer from further back than the days allowed isn't close enough
      if (found == null || found.day < daysBefore(day, MAX_EARLIER_DAYS)) continue;
      const rate: Rate = {
        rate: found.rate,
        source,
        fetchedAt: Date.parse(`${found.day}T12:00:00Z`),
        day: found.day,
      };
      if (!ranged) await keep(deps.cache, key, rate, KEEP_DAY_SECONDS);
      return rate;
    }
    // A service that's down may have this day: tried again later, never settled past
    if (down) throw new RatesUnavailable(`No rate for ${from} to ${to} on ${asked} right now`);
  }
  return live();
}

// --- Ranges of days -----------------------------------------------------------------------
// A conversion needs the rate of every day its entries fall on: a year of entries is a few
// hundred days, and asked a day at a time that was hundreds of requests over many steps. So
// before a step works out its entries, the days they need are asked for by range: the
// calendar is cut into fixed spans (MAX_RANGE_DAYS for the ECB, WISE_RANGE_DAYS for Wise,
// whose answer has a rate an hour), and each span a needed day (or the week before it)
// falls in is one request, kept in the cache as one copy, so the next step, or the next
// conversion, reads it rather than asking again. Each day's answer is then noted
// (RateLookups.know) exactly as asking for that day alone would have answered: the ECB's
// rate on the day or the working day before it, Wise's at noon UTC on it. getRateOn reads
// those with no request or cache call of its own (a step may make 50 of those in all). A span
// that fails, or isn't asked, leaves its days to be asked one at a time and kept a day at a
// time, as before.

/** The days one request to the ECB covers */
export const MAX_RANGE_DAYS = 128;
/**
 * The days one request to Wise covers: it gives a point every hour only up to 720 hours
 * (30 days), and one a day at midnight past that, without saying so
 */
export const WISE_RANGE_DAYS = 28;
/**
 * What a step keeps back from asking for ranges, so the days a range couldn't answer can
 * still be asked one at a time (one day can take 20)
 */
const KEEP_FOR_DAYS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (day: string) => Math.floor(Date.parse(`${day}T12:00:00Z`) / DAY_MS);
const dayOfNumber = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** The fixed spans of `size` days that hold any day from `first` to `last` */
function spansOver(first: string, last: string, size: number): [string, string][] {
  const out: [string, string][] = [];
  for (let w = Math.floor(dayNumber(first) / size); w * size <= dayNumber(last); w++) {
    out.push([dayOfNumber(w * size), dayOfNumber(w * size + size - 1)]);
  }
  return out;
}

/** The days from `first` to `last`, both included, in order */
function daysFrom(first: string, last: string): string[] {
  const out: string[] = [];
  for (let n = dayNumber(first); n <= dayNumber(last); n++) out.push(dayOfNumber(n));
  return out;
}

/** A span's answer: each day's rate, and the days it answers for (with a rate or none) */
interface SpanAnswer {
  rates: Record<string, number>;
  days: string[];
}

/**
 * The ECB's rates from `start` to `end` by day (its working days, and the one on or before
 * `start`), answering for every day of the span. A 404 is the ECB not publishing the pair
 * (as a day asked alone says); anything else that isn't a rate is a failure, thrown.
 */
async function frankfurterRange(
  env: RatesEnv,
  from: string,
  to: string,
  [start, end]: [string, string],
  deps: Deps,
): Promise<SpanAnswer> {
  const base = env.FRANKFURTER_BASE ?? 'https://api.frankfurter.dev';
  const res = await deps.fetch(`${base}/v1/${start}..${end}?base=${from}&symbols=${to}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const days = daysFrom(start, end);
  if (res.status === 404) return { rates: {}, days };
  if (!res.ok) throw new Error(`Frankfurter range: ${res.status}`);
  const body = await res.json<{ rates?: Record<string, Record<string, unknown>> }>();
  const rates: Record<string, number> = {};
  for (const [day, found] of Object.entries(body.rates ?? {})) {
    const rate = found?.[to];
    if (DAY.test(day) && day <= end && isValidRate(rate)) rates[day] = rate;
  }
  return { rates, days };
}

/**
 * Wise's rate for each day from `start` to `end`, asked an hour at a time: each day's
 * latest point at or before noon UTC, as a day asked alone gives it. It answers only for
 * the days it has such a point for. Any refusal, or an answer that isn't hourly (Wise's
 * one point a day, at midnight, for a range too long), is a failure, thrown: it is never
 * taken to mean Wise has no rate.
 */
async function wiseRange(
  env: RatesEnv,
  from: string,
  to: string,
  [start, end]: [string, string],
  deps: Deps,
): Promise<SpanAnswer> {
  if (!env.WISE_TOKEN) throw new Error('Wise range: no token');
  const base = env.WISE_BASE ?? 'https://api.wise.com';
  const res = await deps.fetch(
    `${base}/v1/rates?source=${from}&target=${to}&from=${start}T00:00&to=${end}T23:00&group=hour`,
    {
      headers: { Authorization: `Bearer ${env.WISE_TOKEN}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Wise range: ${res.status}`);
  const body = await res.json<unknown>();
  if (!Array.isArray(body)) throw new Error('Wise range: not a list');
  const perDay = new Map<string, number>();
  const best = new Map<string, { at: number; rate: number }>();
  for (const item of body as { rate?: unknown; time?: unknown }[]) {
    const at = wiseTime(item?.time);
    if (!Number.isFinite(at) || !isValidRate(item.rate)) continue;
    const day = rateDay(at);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    if (day < start || day > end || !isWiseNoonPoint(at, day)) continue;
    const held = best.get(day);
    if (held == null || at > held.at) best.set(day, { at, rate: item.rate });
  }
  // Hourly has many points a day; one a day is the answer for a range too long
  if (perDay.size > 0 && [...perDay.values()].every((n) => n <= 1)) {
    throw new Error('Wise range: not hourly');
  }
  const rates = Object.fromEntries([...best].map(([day, { rate }]) => [day, rate]));
  return { rates, days: Object.keys(rates) };
}

/** One span's rates as kept: the last day it was asked to, and each day's rate */
interface KeptSpan {
  end: string;
  rates: Record<string, number>;
  /** The days it answers for, with a rate or none */
  days: string[];
}

const isKeptSpan = (kept: unknown): kept is KeptSpan => {
  const k = kept as Partial<KeptSpan> | null;
  return (
    typeof k?.end === 'string' &&
    DAY.test(k.end) &&
    typeof k.rates === 'object' &&
    k.rates != null &&
    Array.isArray(k.days) &&
    k.days.every((d) => typeof d === 'string' && DAY.test(d)) &&
    Object.entries(k.rates).every(([d, r]) => DAY.test(d) && isValidRate(r))
  );
};

/**
 * Asks for the rates of `days` (2026-11-05, an entry's day each) from `from` into `to` by
 * span, noting each day's answer in `lookups` for getRateOn to read. Today and later are
 * left to the live rate. Never throws: what it couldn't find is asked one day at a time.
 */
export async function prefetchRatesOn(
  env: RatesEnv,
  from: string,
  to: string,
  days: string[],
  { deps = defaultDeps(), lookups = new RateLookups() }: Omit<RateOptions, 'maxAgeMs'> = {},
): Promise<void> {
  if (from === to) return;
  const today = rateDay(deps.now());
  const yesterday = daysBefore(today, 1);
  const wanted = [...new Set(days)].filter((d) => DAY.test(d) && d < today).sort();
  if (wanted.length === 0) return;
  const counted = lookups.counted(deps);

  /**
   * Every span of `size` days holding a wanted day or the `back` days before it: from the
   * cache, else asked for (to yesterday at the latest) and kept. Answers each day found, and
   * the days covered by spans that came back.
   */
  const gather = async (
    source: FetchedRateSource,
    fetch: (
      env: RatesEnv,
      from: string,
      to: string,
      span: [string, string],
      deps: Deps,
    ) => Promise<SpanAnswer>,
    size: number,
    back: number,
    only: (day: string) => boolean,
  ) => {
    const spans = new Map<string, [string, string]>();
    for (const day of wanted.filter(only)) {
      for (const span of spansOver(daysBefore(day, back), day, size)) spans.set(span[0], span);
    }
    const covered = new Set<string>();
    const found = new Map<string, number>();
    // The step's cache calls and requests count alike; some are kept back for single days
    const cache = env.RATES_KEEP_RANGES === 'no' ? null : counted.cache;
    for (const [start, spanEnd] of [...spans.values()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (lookups.remaining() < KEEP_FOR_DAYS + 3) break;
      const end = spanEnd < yesterday ? spanEnd : yesterday;
      // v2: named by the span's size too, so spans of another size are never read as these
      const key = `https://rates.internal/v2/range/${source}/${size}/${from}/${to}/${start}`;
      let span: KeptSpan | null = null;
      try {
        const kept = cache == null ? null : await cache.match(key);
        const value = kept ? await kept.json<unknown>() : null;
        if (isKeptSpan(value) && value.end >= end) span = value;
      } catch (err) {
        if (!(err instanceof LookupsSpent)) console.error(err);
      }
      if (span == null) {
        try {
          span = { end, ...(await fetch(env, from, to, [start, end], counted)) };
        } catch (err) {
          // A failure keeps nothing: its days are asked one at a time
          if (!(err instanceof LookupsSpent)) console.error(err);
          continue;
        }
        // Kept for long only when it ends before yesterday, whose rate may not be out yet
        const seconds = spanEnd < yesterday ? KEEP_DAY_SECONDS : KEEP_SECONDS;
        await cache
          ?.put(
            key,
            new Response(JSON.stringify(span), {
              headers: { 'Cache-Control': `max-age=${seconds}` },
            }),
          )
          .catch((err: unknown) => {
            if (!(err instanceof LookupsSpent)) console.error(err);
          });
      }
      for (const [day, rate] of Object.entries(span.rates)) found.set(day, rate);
      for (const day of span.days) if (day <= span.end) covered.add(day);
    }
    return { covered, found };
  };

  // The ECB, for each day and the week before it, and the week before that, so its "on or
  // before" is known for every day a rate may be asked for
  const ecb = await gather(
    'frankfurter',
    frankfurterRange,
    MAX_RANGE_DAYS,
    2 * MAX_EARLIER_DAYS,
    () => true,
  );
  const ecbDays = [...ecb.found.keys()].sort();
  /** The ECB's latest day on or before `day`, within a week of it */
  const ecbOn = (day: string) => {
    const cutoff = daysBefore(day, MAX_EARLIER_DAYS);
    for (let i = ecbDays.length - 1; i >= 0; i--) {
      if (ecbDays[i] > day) continue;
      return ecbDays[i] >= cutoff ? ecbDays[i] : null;
    }
    return null;
  };
  for (const day of daysFrom(daysBefore(wanted[0], MAX_EARLIER_DAYS), wanted.at(-1)!)) {
    // Known only where the ECB was asked about the day and the week before it
    if (!ecb.covered.has(day) || !ecb.covered.has(daysBefore(day, MAX_EARLIER_DAYS))) continue;
    const on = ecbOn(day);
    lookups.know<DayRate>(
      `frankfurter ${from} ${to} ${day}`,
      on == null ? null : { rate: ecb.found.get(on)!, day: on },
    );
  }

  // Wise only for the days the ECB may have nothing close to, as getRateOn would ask it.
  // A day Wise's range has no point for is left to be asked alone.
  const noEcb = (day: string) => !ecb.covered.has(day) || ecbOn(day) == null;
  if (!env.WISE_TOKEN || !wanted.some(noEcb)) return;
  const wise = await gather('wise', wiseRange, WISE_RANGE_DAYS, MAX_EARLIER_DAYS, noEcb);
  for (const day of wise.covered) {
    const rate = wise.found.get(day);
    if (rate != null) lookups.know<DayRate>(`wise ${from} ${to} ${day}`, { rate, day });
  }
}
