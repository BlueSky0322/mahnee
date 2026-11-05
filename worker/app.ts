// What every route shares: the Worker's bindings and who's asking.
//
// Routes (routes/*.ts) read the request and answer; the work lives in the feature
// folders, which export handlers (taking the database, the account and the request or
// its body, and answering with a Response) and loaders (returning data shaped as in
// shared/api.ts, for the route to send with json<T>()). The feature folders:
//   - accounts/: who's signed in (auth.ts), and their profile and settings (profiles.ts);
//   - currency/: exchange rates;
//   - ledger/: the money a person tracks: their cash, bank, card and e-wallet accounts
//     with balances, their categories, and their transactions a page at a time
//     (read.ts), a month's spending and income (summary.ts), saving the app's batches of
//     changes all or nothing (changes.ts), and the receipts that make a change sent again
//     count once (receipts.ts).
// Reading requests and answering is in http.ts.

import type { AuthEnv } from './accounts/auth';
import type { RatesEnv } from './currency/exchange-rates';

export interface Env extends AuthEnv, RatesEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Changes per account per minute */
  API_LIMITER: RateLimit;
  /** "true": writes must say whose they are (EXPECTED_ACCOUNT_HEADER); older apps are told to update */
  REQUIRE_EXPECTED_ACCOUNT?: string;
}

export type AppEnv = {
  Bindings: Env;
  /** email: the signed-in account */
  Variables: { email: string };
};
