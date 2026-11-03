// Exchange rates for the app's live preview when an amount is in another currency:
// today's, or with `at` the one for a day it was spent. Whatever saves a converted
// amount fetches its rate again on the server.

import { Hono } from 'hono';
import type { RateQuote } from '../../shared/api';
import { MAX_AMOUNT, convertCents, isCurrency, toCents } from '../../shared/rates';
import type { AppEnv } from '../app';
import { json, fail } from '../http';
import { getRatePreference } from '../accounts/profiles';
import {
  REFRESH_MAX_AGE_MS,
  RatesUnavailable,
  getRate,
  getRateOn,
} from '../currency/exchange-rates';

/** Earliest day a rate may be asked for: before this app existed */
const EARLIEST = Date.UTC(2000, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

/** A time, in ms, that has come (give or take a day for time zones) */
const isPastTime = (at: number) =>
  Number.isInteger(at) && at >= EARLIEST && at <= Date.now() + DAY_MS;

const rates = new Hono<AppEnv>();

rates.get('/rates', async (c) => {
  const from = c.req.query('from')?.toUpperCase() ?? '';
  const to = c.req.query('to')?.toUpperCase() ?? '';
  if (!isCurrency(from) || !isCurrency(to)) {
    return fail('Give from and to as currency codes, like USD', 400);
  }
  const rawAmount = c.req.query('amount');
  const amount = rawAmount == null ? null : Number(rawAmount);
  if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT)) {
    return fail(`Amount must be between 0 and ${MAX_AMOUNT.toLocaleString('en-US')}`, 400);
  }
  const rawAt = c.req.query('at');
  const at = rawAt == null ? null : Number(rawAt);
  if (at != null && !isPastTime(at)) return fail('Give at as a time that has come, in ms', 400);

  try {
    const prefer = await getRatePreference(c.env.DB, c.var.email);
    // Refresh asks for a recent rate rather than one from hours ago
    const maxAgeMs = c.req.query('fresh') != null ? REFRESH_MAX_AGE_MS : undefined;
    const { rate, source, fetchedAt } =
      at == null
        ? await getRate(c.env, from, to, { prefer, maxAgeMs })
        : await getRateOn(c.env, from, to, at, { prefer });
    return json<RateQuote>({
      from,
      to,
      rate,
      source,
      fetchedAt,
      ...(amount != null && { convertedCents: convertCents(toCents(amount), rate) }),
    });
  } catch (err) {
    if (err instanceof RatesUnavailable) return fail(err.message, 503);
    throw err;
  }
});

export default rates;
