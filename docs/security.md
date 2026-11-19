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
- **What the server keeps about where someone is.** The profile holds the person's time
  zone (`time_zone`, as `Asia/Kuala_Lumpur`), which the app sends from the device each
  time it starts and it differs from the saved one, so the server can tell the person's
  own day (for scheduled entries added at their midnight and reminders at their time). It
  says roughly where they are, so it is kept with the other settings, private to the
  account, and never logged. Only a named zone the runtime knows is saved, never an
  offset or free text. Settings that name a row (the account Add starts on, the pay a
  month starts on) are checked to be the person's own, and foreign keys with the email
  hold the same in the database.

- **The profile picture.** A person's picture (one they chose, or a copy of their
  Google picture) is served at `/api/me/picture`, which names no account: it answers only
  the signed-in account's own, so there's no one else's to ask for. It's sent
  `private, no-cache` with an ETag, so a browser's copy is checked with the server before
  each showing, and `nosniff` with `default-src 'none'`. The server takes only a JPEG, PNG
  or WebP by its bytes (not the type it's sent as), at most 64 KB and 512px a side, and
  refuses anything else (`worker/accounts/pictures.ts`).
- **Google picture.** When the Access token names the person's Google picture (only once
  the owner passes Google's `picture` claim on, see Settings outside the repo), the Worker
  copies it once into the database, after `/api/me` has answered, from
  `https://lh3.googleusercontent.com/` only (the address parsed, so no lookalike host,
  sign-in, port or scheme; no redirects followed; 5 seconds at most; read only up to
  64 KB; checked as an upload is), and again only when the token names a different one.
  One that can't be had isn't asked for again for an hour (per Worker instance). The browser never contacts Google for it, so Google
  doesn't learn when or where the app is opened. The address it came from is kept beside
  it, private to the account. Choosing the initial stops it showing; the copy is kept, to
  go back to.

- **What the server writes on its own (owner decision D8).** A cron trigger runs the
  nightly job every 15 minutes (`worker/ledger/post-scheduled.ts`): it adds each person's
  scheduled entries on their day, through the same checks as the app's own changes
  (`applyChanges`), as that person only, each item's rows read and written with its email.
  It adds nothing for someone with no stored time zone, nothing for an item that asks
  first, and never twice (fixed ids per item and day, receipts, the next-due guard). It is
  not reachable from the API: only the trigger runs it. It logs only an error's name and
  message, never an amount, payee, account or email.
- **Converting a new home currency (owner decision D2).** Changing it queues the person's
  email and the time it changed on the `mahnee-reconvert` queue; each step reads and writes
  only that person's rows, checked against that change (a step for an older one does
  nothing). Its writes go through no change of the person's, so the person's own writes
  wait (503) until it's done. A step that fails is tried again 8 times; then
  `mahnee-reconvert-dlq` gives the person their currency back, nothing converted, so they
  are never left unable to write. One that stalls is started again when the person reads
  their profile, at most 3 times, then given back the same way. It
  logs an error's name and message, or the name of the limit that refused a change, never
  a job (it names the person), an amount or a rate. Both queues are made in Cloudflare
  before the first deploy that names them; a deploy doesn't make them.

- **Reminders by web push (owner decision D6, "Push with details").** A device gets
  reminders only after the person taps Allow notifications and the browser grants it;
  nothing asks on its own. Its push subscription (the browser's endpoint at its push
  service and the keys a message is encrypted to) is kept for the account that sent it,
  through the same sign-in, cross-site and whose-write checks as every write: one made as
  another account is refused and nothing is kept. One device reminds one account: the
  endpoint is the key, so a device subscribed by someone else moves to them. Signing out
  lets the device go (on the server, scoped by the email, and in the browser); a device
  last subscribed by another account is let go in the browser once someone else is
  known to be signed in; one the push service says is gone (404, 410) or bad (400), or
  whose keys can't be encrypted to, is deleted; one refused as unauthorised (401, 403) is
  deleted only at the third refusal in a row, so a broken VAPID setup can't delete every
  device in one run. Endpoints
  are taken only on the browsers' push services (Firebase, Mozilla, Apple, WNS, https, a
  path, no user, port or trailing dot), so the Worker never sends to an address a person
  typed, and a push service's redirect is never followed.
- **A reminder shows only for the account signed in on the device.** Each message carries
  a tag for its account (the first 16 hex characters of the SHA-256 of "mahnee-push:" and
  the email), never the email; the service worker shows it only when the account the app
  last said is signed in there has that tag. Signed out (nobody signed in), or someone
  else signed in, only "Mahnee" / "Open Mahnee to see your reminder." is shown (the browser
  insists on something), so what one sent before the server learned the device was
  let go (signing out offline) says never reaches the next person.
- **What a reminder says, and who sees it.** Each message is encrypted to the one device
  (RFC 8291, aes128gcm) and signed as the app (VAPID, RFC 8292, `sub` the app's own
  address), with WebCrypto alone; the browser's push service carries it but can't read it.
  The text names the scheduled item and its amount ("TNB RM 189.00 is added tomorrow"), and
  is visible on a locked phone, by the owner's choice: anyone who can see the phone's lock
  screen can read it. The daily reminder names nothing ("Nothing added today").
- **What the server sends on its own.** The same cron trigger as the nightly job runs the
  reminders (`worker/push/reminders.ts`) after it: each person with a device, a time zone
  and a reminder on, at their "Remind me at" time on their own clock (not more than two
  hours late), each reminder at most once a day a device: claimed for that day just before
  it is sent, so overlapping runs or one stopped halfway never send it twice (a run
  stopped between the claim and the send loses that reminder for the day, by design). It reads only those people's settings, whether they
  saved an entry that day (not one from Scheduled), and their running items due on the day
  the reminder is for. It is not reachable from the API. No payload, endpoint or
  subscription key is logged; only an error's name and message.
- **The VAPID keys.** The public key is config (`VAPID_PUBLIC_KEY` in `wrangler.jsonc`
  vars); the private key is the Worker secret `VAPID_PRIVATE_KEY` (a P-256 JWK), never in
  the repo, and refused at use unless it is the public key's pair. Without both, nothing is
  sent and subscribing is refused. `PUSH_TEST_ORIGIN` takes one more origin as a push
  service and is set only by the tests; never set it on the deployed Worker.

## Limits that bound abuse

- The nightly job: at most 200 items read and 200 entries added a run, at most 31 of one
  item (`shared/scheduled.ts`), for at most 40 people and 100 saves; the rest wait for the
  next run, 15 minutes later. A person whose save fails outright is left for the next run
  and the others still go. An item refused for a lasting reason other than an archived
  account or category (an account holding its most transactions, say) keeps its place,
  oldest due first, and takes part of each run until it's changed: about seven such weekly
  items could fill a run. Checked by hand, not by the job.

- Reminders: at most 10 devices an account, at most 50 devices looked at a run (two pushes
  each at most, six at once) and the first four scheduled items due a person with how many
  in all; the rest wait for the next run. A push service gets 5 seconds; one that can't
  take a message now is tried again after 15 minutes, then 30, 60, at most 120, and a
  device whose reminders fail outright doesn't stop the others. A message is at most
  4096 bytes, as push services take; a subscription request is a JSON body like any other.

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
  parameters (never put into the SQL; with `instr`, so no character is a wildcard), within the person's own rows. What a search
  counts beyond a page (how many, and what they spent and received) is one aggregate of the
  person's own rows under the same conditions, the email first. Search results
  are not kept on the device. A month's totals (`/api/summary`) are one
  grouped sum of the person's own, at most one row per category. Its budgets add one
  read of the person's budget rows and, only when they have any, one grouped sum of
  their spending by month and top-level category since the first budget: at most one
  row per month since 2000 and category, up to this month. A month still to come (after
  tomorrow's in UTC) gets no budgets and reads none, so the month-by-month walk is
  bounded by the months since 2000. A budget is whole cents from 1 to
  `MAX_BUDGET_CENTS` (`shared/budgets.ts`), set from a month no later than this one.
- The 12 months up to a month (`/api/summary/trend`): one grouped sum of the person's own
  spending and income over a fixed window, the checked month and the 11 before it, at
  most one row per month, kind and category (12 x 2 x `MAX_CATEGORIES`); never a read per
  month. Kept on the device per month, like a month's totals.
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
  at most `MAX_ACCOUNTS` x `MAX_TRANSACTIONS_PER_ACCOUNT` of them, and at most
  `MAX_RECURRING` repeating items, read in one query.
- `GET /api/payee-categories` answers each of the person's own payees with the category
  it was last filed under, at most `MAX_PAYEE_CATEGORIES`; someone else's account is
  answered as one that doesn't exist.
- Exchange rates are fetched by the Worker, never the browser, from Wise and Frankfurter,
  with a 4-second time limit; the request names only the two currencies and the day.
  Converting a person's amounts asks for one rate per currency and day of theirs, never
  their amounts, and a step asks at most 200 days' rates.

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
- The place a fresh start opens on (Look and start's "Open the app on": Home, Activity or
  Plan) is kept in `localStorage` with the account's email (`mahnee:startScreen`), used only
  while that account is the one last signed in here, and cleared on signing out or when
  another account signs in. It holds no figures or names. The theme and accent are kept
  per device in `sf-appearance`, as before.
- Hiding Home's Getting started is kept in `localStorage` as a flag alone
  (`getting-started-hidden:<email>`, no figures or names), under the account's email; it
  isn't cleared on signing out, since it holds nothing about the person's money.
- What's typed in Add and closed without saving is kept as a draft in `localStorage`
  (`mahnee:addDraft:<email>`): the amount or sum, the payee, which way it went, the account
  and category picked, a new category's name, the day and the repeat. It's kept under the
  account's email and read back only by that account, until it's saved or the account signs
  out (another account signing in clears it too). Close, Back, Esc and Cancel all keep it;
  an Add with nothing typed keeps none. Like the rest of what's kept, whoever holds an
  unlocked device can read it.
- Travel sense keeps, per account in `localStorage` (`mahnee:travel:<email>`), today's
  date, the currency Add opens in today and the currencies of the last two entries added
  today: codes alone, no amounts or names; cleared on signing out. The device's time zone
  is read on the device and never sent for it. The last exchange rate seen for each pair
  is kept with the account's other copies, so offline Add can still estimate.
- Unsaved changes are sent only as the account they were made as (`X-Expected-Account`),
  by the app or, while it's closed, by the service worker's background sync, which sends
  only the outbox of the account the app last said is signed in. The server refuses one
  sent while someone else is signed in, and it's kept.
- The service worker keeps the app's own files and web fonts, and from the API only the
  profile picture: one copy per account, in a cache named with the account's email
  (`mahnee-pictures-v1:<email>`), kept only when the server said whose it is
  (`X-Image-Viewer`) and shown from there only offline or while the server fails, and
  only to the account the app last said is signed in. Online, the server is asked every
  time. A 404 forgets the signed-in account's copy alone, and signing out deletes every
  account's. It reads the app's
  IndexedDB only to send the outbox and to know who's signed in.
  It shows a reminder as it comes and keeps nothing of it; a tap opens only the app's own
  pages.
- Which account this device was last subscribed for reminders is kept in `localStorage`
  (`mahnee:pushOwner`, an email), to let the device go when someone else signs in here;
  removed on signing out.
- Once an Access session runs out, the app opens with the last account's kept profile
  and offers to sign in. Whoever holds the device can read what was kept until someone
  signs in or signs out: an unlocked shared device is a risk, as with any app that opens
  offline.
- The export file holds the person's whole financial history: every transaction and the
  bills still repeating, with amounts, payees, notes and account names. The app doesn't store it anywhere: the
  Worker writes it as it's asked for, answers it with `Cache-Control: no-store`, and
  logs none of it; the service worker keeps nothing from `/api` but the picture. Once
  downloaded or shared it is wherever the person saved it, outside the app's care.
- An imported file is read in the browser and never sent anywhere whole: only the
  changes the person ticks go to the server, as any other change. The column mapping
  remembered per account keeps column names only, in `localStorage` under the account's
  email, let go on signing out. Each import is recorded on the server by its file's name,
  the account it went into and two counts, for Recent imports on every device; never the
  file. Undo deletes its entries for good, scoped by the person's email and the import's id.
- A file of some dates holds only those days' transactions and says so; the "Last
  downloaded" day is kept on the device per email, nothing more.
- Errors are logged by name and message only, never with what a person typed.

## Secrets and where they live

| What                                            | Where                              | Used for                           |
| ----------------------------------------------- | ---------------------------------- | ---------------------------------- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secrets             | Migrations and deploys from `main` |
| Access team domain and audience                 | `wrangler.jsonc` vars (not secret) | Checking sign-in tokens            |
| `WISE_TOKEN` (optional)                         | Worker secret                      | Live rates from Wise               |
| `VAPID_PUBLIC_KEY`                              | `wrangler.jsonc` vars (not secret) | Devices subscribing for reminders  |
| `VAPID_PRIVATE_KEY` (a P-256 JWK)               | Worker secret                      | Signing each reminder (VAPID)      |

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
- **A leaked VAPID private key**: make a new pair, set the secret and the public key
  together and deploy. Every device's subscription was made with the old key, so each has
  to allow notifications again (Settings, Budgets and reminders); delete the old rows
  (`DELETE FROM push_subscriptions`) so none is sent to with the new key.
- **Someone who shouldn't be in**: narrow the Access policy (a change applies to
  Splitfoolish too, unless Mahnee gets a policy of its own); their next request is
  refused.
- **Data written wrongly**: restore as above, after exporting what's there now.

## Settings outside the repo

These are kept in Cloudflare and GitHub, not here; check them from time to time:

- Access: who the shared "Anyone with an email" policy lets in (it also guards
  Splitfoolish), and how long a session lasts (24 hours).
- The Cloudflare API token's permissions: no more than the deploy needs.
- To show a Google picture by default: in Zero Trust, Integrations, Identity providers,
  edit Google and add `picture` under OIDC Claims, then Save and Test (the test's
  `oidc_fields` should show `picture`). Access then puts it in the token's `custom`
  claims, read on the next sign-in. Without it, everyone starts with the initial and can
  choose a photo.
- `REQUIRE_EXPECTED_ACCOUNT=true` on the Worker, once installed apps send the header, so
  writes from apps too old to say whose they are are refused.
- GitHub: only trusted people can push to `main`, since a push deploys.
