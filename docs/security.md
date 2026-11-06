# Security and recovery

How Mahnee keeps a person's finances to that person, what it relies on outside this
repo, and what to do when something goes wrong. It lowers risk; it doesn't make the app
hack-proof, and the limits below are real.

## Who can do what

- **Signing in.** Cloudflare Access sits in front of the whole app. The Worker checks the
  Access token on every request against `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`
  (`worker/accounts/auth.ts`). With only one of the two set it refuses everyone. The
  developer stand-in (`DEV_USER_EMAIL`, `X-Dev-User`) works only with both unset, so
  never set `DEV_USER_EMAIL` on the deployed Worker, and never remove the Access
  settings from `wrangler.jsonc`. The Access application covers the Worker's
  `workers.dev` address with the same policy as Splitfoolish ("Anyone with an email"),
  so one email is one person in both apps; per-version preview
  addresses are turned off (`preview_urls`), since Access doesn't cover them.
- **Whose data it is.** Anyone with an email can sign in, and each account sees only its
  own data: every row belongs to the signed-in account, and every query is scoped by its
  email. Money accounts, categories and transactions are keyed by email and id together,
  so an id of someone else's is answered exactly as one that doesn't exist, and never
  reveals that it does; a subcategory's parent, and a transaction's accounts and category,
  are looked up among the person's own only (composite foreign keys hold this in the
  database too). There is no sharing between accounts.
- **Whose a write is.** Every write from the app names the account it was made as
  (`X-Expected-Account`). One made as another account is refused before it changes
  anything.
- **Other sites.** A write started by a page on another site is refused (403), since the
  sign-in cookie would ride along with it. Reads are allowed.

## Limits that bound abuse

- Changes: 60 a minute per account (`API_LIMITER`), counted per Cloudflare location.
  Reading is never limited.
- Request bodies are read only up to 256 KB and within 30 seconds (`readBody` in
  `worker/http.ts`).
- Money: an amount typed is at most `MAX_AMOUNT`, and once converted at most
  `MAX_AMOUNT_CENTS` (`shared/rates.ts`), so totals stay exact. An opening balance is at
  most `MAX_TRANSACTION` either way, a person has at most `MAX_ACCOUNTS` accounts, and
  their names at most `MAX_ACCOUNT_NAME` characters (`shared/ledger.ts`). They have at
  most `MAX_CATEGORIES` categories, `MAX_SUBCATEGORIES` under one, with names of at most
  `MAX_CATEGORY_NAME` characters (`shared/categories.ts`). A transaction is whole cents
  from 1 to `MAX_TRANSACTION_CENTS`, an account holds at most
  `MAX_TRANSACTIONS_PER_ACCOUNT`, a transfer counted on both its accounts (checked again
  as each row is saved), and a payee and
  note are at most `MAX_PAYEE` and `MAX_NOTE` characters (`shared/ledger.ts`), so every
  balance stays a whole number held exactly.
- Reading transactions: at most 200 to a page (`MAX_PAGE_SIZE` in
  `worker/ledger/read.ts`), 50 unless asked; searching (`/api/search`) too, with words of
  at most `MAX_SEARCH_TEXT` characters (`shared/search.ts`), matched as text by bound
  parameters (never put into the SQL; with `instr`, so no character is a wildcard), within the person's own rows. Search results
  are not kept on the device. A month's totals (`/api/summary`) are one
  grouped sum of the person's own, at most one row per category. Its budgets add one
  read of the person's budget rows and, only when they have any, one grouped sum of
  their spending by month and top-level category since the first budget: at most one
  row per month since 2000 and category, up to this month. A month still to come (after
  tomorrow's in UTC) gets no budgets and reads none, so the month-by-month walk is
  bounded by the months since 2000. A budget is whole cents from 1 to
  `MAX_BUDGET_CENTS` (`shared/budgets.ts`), set from a month no later than this one.
- Changes to the ledger: at most `MAX_CHANGES` in one request, saved all or nothing. A
  change to many transactions names at most `MAX_BULK_TRANSACTIONS` (500), each the
  person's own. A person has at most `MAX_RECURRING` (200) repeating items, stopped ones
  included (`shared/recurring.ts`), each amount within `MAX_TRANSACTION_CENTS`; logging one
  saves its transaction and its next due date together, and only from the occurrence it
  names, so it is never recorded twice.
  Each carries the app's id, kept as a receipt for 90 days, so a change sent again is
  never applied twice.
- Exporting (`/api/export`) reads the person's transactions a page at a time and sends
  each as it's read, so the Worker never holds the whole history at once; a person has
  at most `MAX_ACCOUNTS` x `MAX_TRANSACTIONS_PER_ACCOUNT` of them.
- `GET /api/payee-categories` answers each of the person's own payees with the category
  it was last filed under, at most `MAX_PAYEE_CATEGORIES`; someone else's account is
  answered as one that doesn't exist.
- Exchange rates are fetched by the Worker, never the browser, from Wise and Frankfurter,
  with a 4-second time limit; the request names only the two currencies and the day.

## On the device

- What the app keeps (the profile, the accounts with their balances, the categories,
  the newest page of each account's transactions it has opened, the totals of each
  month it has shown, and changes not yet
  saved) is tagged with the account and shown only to it. The account and categories
  used last are kept in `localStorage` by id only, under the account's email, and let go
  on signing out. Signing
  out clears it, and so does another account signing in, except that account's unsaved
  changes: those stay on the device, under its email, unread and unsent until it signs
  in here again. Signing out asks first when changes are waiting, then drops the leaving
  account's own.
- Unsaved changes are sent only as the account they were made as (`X-Expected-Account`),
  by the app or, while it's closed, by the service worker's background sync, which sends
  only the outbox of the account the app last said is signed in. The server refuses one
  sent while someone else is signed in, and it's kept.
- The service worker keeps the app's own files and web fonts, never anything from the
  API. It reads the app's IndexedDB only to send the outbox.
- Once an Access session runs out, the app opens with the last account's kept profile
  and offers to sign in. Whoever holds the device can read what was kept until someone
  signs in or signs out: an unlocked shared device is a risk, as with any app that opens
  offline.
- The export file holds the person's whole financial history: every transaction, with
  amounts, payees, notes and account names. The app doesn't store it anywhere: the
  Worker writes it as it's asked for, answers it with `Cache-Control: no-store`, and
  logs none of it; the service worker never keeps anything from `/api`. Once
  downloaded or shared it is wherever the person saved it, outside the app's care.
- An imported file is read in the browser and never sent anywhere whole: only the
  changes the person ticks go to the server, as any other change. The column mapping
  remembered per account keeps column names only, in `localStorage` under the account's
  email, let go on signing out.
- Errors are logged by name and message only, never with what a person typed.

## Secrets and where they live

| What                                            | Where                              | Used for                           |
| ----------------------------------------------- | ---------------------------------- | ---------------------------------- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secrets             | Migrations and deploys from `main` |
| Access team domain and audience                 | `wrangler.jsonc` vars (not secret) | Checking sign-in tokens            |
| `WISE_TOKEN` (optional)                         | Worker secret                      | Live rates from Wise               |

Never commit `.dev.vars` or tokens, and keep tokens and financial data out of logs. CI
runs with a read-only GitHub token, and its actions are pinned to commits
(`.github/workflows/deploy.yml`).

## Backups and restoring

A push to `main` applies new migrations to production and deploys. Before merging a
migration:

1. Export the database somewhere private (not the repo or a CI artifact):
   `npx wrangler d1 export mahnee-db --remote --output=<private path>.sql`
2. Check the export loads, for example into a scratch SQLite database, and that its
   tables have rows.
3. Note the Time Travel bookmark: `npx wrangler d1 time-travel info mahnee-db`. The
   deploy also prints one in its log just before applying migrations.

To go back:

- **To a moment in the last 30 days** (D1 Time Travel; the window depends on the plan):
  `npx wrangler d1 time-travel restore mahnee-db --bookmark=<bookmark>`, or
  `--timestamp=<unix seconds>`. This replaces the whole database, so everything written
  since is lost; export first if any of it matters.
- **From an export**: restore into a fresh database
  (`npx wrangler d1 create <name>`, then
  `npx wrangler d1 execute <name> --remote --file=<export>.sql`), check it, then point
  `database_id` in `wrangler.jsonc` at it and deploy.
- **A bad deploy without a migration**: revert the commit on `main` (the push deploys
  the revert), or `npx wrangler rollback` to the previous version.

Practise a restore into a scratch database now and then, so the steps are known to work
before they're needed.

## If something goes wrong

- **A leaked Cloudflare token**: revoke it in the Cloudflare dashboard, make a new one
  with only what the deploy needs (Workers scripts and D1 edit on this account), and
  replace the GitHub secret.
- **Someone who shouldn't be in**: narrow the Access policy (a change applies to
  Splitfoolish too, unless Mahnee gets a policy of its own); their next request is
  refused.
- **Data written wrongly**: restore as above, after exporting what's there now.

## Settings outside the repo

These are kept in Cloudflare and GitHub, not here; check them from time to time:

- Access: who the shared "Anyone with an email" policy lets in (it also guards
  Splitfoolish), and how long a session lasts (24 hours).
- The Cloudflare API token's permissions: no more than the deploy needs.
- `REQUIRE_EXPECTED_ACCOUNT=true` on the Worker, once installed apps send the header, so
  writes from apps too old to say whose they are are refused.
- GitHub: only trusted people can push to `main`, since a push deploys.
