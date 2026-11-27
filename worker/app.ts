// What every route shares: the Worker's bindings and who's asking.
//
// Routes (routes/*.ts) read the request and answer; the work lives in the feature
// folders, which export handlers (taking the database, the account and the request or
// its body, and answering with a Response) and loaders (returning data shaped as in
// shared/api.ts, for the route to send with json<T>()). The feature folders:
//   - accounts/: who's signed in (auth.ts), their profile and settings (profiles.ts), and
//     their profile picture (pictures.ts);
//   - currency/: exchange rates, and converting every amount when the home currency
//     changes (convert.ts), a step at a time from the mahnee-reconvert queue
//     (convert-queue.ts, wired in index.ts and wrangler.jsonc);
//   - push/: reminders by web push: encrypting (encrypt.ts) and signing (vapid.ts) each
//     one with WebCrypto, sending it (send.ts), and the cron's job that picks who to
//     remind (reminders.ts);
//   - ledger/: the money a person tracks: their cash, bank, card and e-wallet accounts
//     with balances, their categories, and their transactions a page at a time
//     (read.ts), a month's spending and income (summary.ts) and the 12 months up to it
//     (trend.ts), every transaction as a CSV file to take away (export.ts), the
//     category each payee was last filed under, for importing (payees.ts), saving the
//     app's batches of changes all or nothing (changes.ts), and the receipts that make a
//     change sent again count once (receipts.ts).
// Reading requests and answering is in http.ts.

import type { AuthEnv } from './accounts/auth';
import type { ConvertJob } from './currency/convert';
import type { RatesEnv } from './currency/exchange-rates';
import type { PushEnv } from './push/reminders';

export interface McpEnv extends RatesEnv {
  DB: D1Database;
  /** Changes per account per minute */
  API_LIMITER: RateLimit;
}

export interface Env extends AuthEnv, McpEnv, PushEnv {
  ASSETS: Fetcher;
  /** "true": writes must say whose they are (EXPECTED_ACCOUNT_HEADER); older apps are told to update */
  REQUIRE_EXPECTED_ACCOUNT?: string;
  /** Conversions into a new home currency, a step at a time (currency/convert-queue.ts) */
  CONVERT_QUEUE: Queue<ConvertJob>;
  /** For tests: seconds between tries of a failed conversion step */
  CONVERT_RETRY_DELAY_S?: string;
  /**
   * Where a Google picture may be copied from; the only address a sign-in's picture is
   * fetched at. Google's own unless tests stand in for it.
   */
  GOOGLE_PICTURE_BASE?: string;
}

export type AppEnv = {
  Bindings: Env;
  /** email: the signed-in account; googlePicture: the Google picture its sign-in names */
  Variables: { email: string; googlePicture: string | null };
};
