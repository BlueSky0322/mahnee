# Feature map

Where each feature lives, which module owns its state and changes, what it must keep
true, and which tests hold it to that. Read the entry for a feature before extending
it, and update the entry in the same change when its owner, entry points, data flow or
contracts change. Presentation-only changes need no update here.

The data model is in [erd.md](erd.md). How the Worker's routes and modules fit together
is at the top of [worker/app.ts](../worker/app.ts). The rules every change follows are
in [AGENTS.md](../AGENTS.md).

| Feature                                                        | State owner (app)            | Worker                         |
| -------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| [Sign-in, profile and settings](#sign-in-profile-and-settings) | `profile/ProfileContext.tsx` | `accounts/`, `routes/me.ts`    |
| [Accounts](#accounts)                                          | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Categories](#categories)                                      | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Transactions and quick entry](#transactions-and-quick-entry)  | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Month view](#month-view)                                      | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Exchange rates](#exchange-rates)                              | `hooks/useRate.ts`           | `currency/`, `routes/rates.ts` |
| [Offline start and installing](#offline-start-and-installing)  | `offline/`, `pwa/`           | (none; the API is the same)    |
| [Pages, layouts and Back](#pages-layouts-and-back)             | `hooks/useRoute.ts`          | (none)                         |

App paths are under `web/src/`, Worker paths under `worker/`.

## Sign-in, profile and settings

**What it is.** Cloudflare Access signs people in before the app loads. The home page
says who is signed in and offers Sign out; the theme switch saves the account's choice
of light or dark. The profile also holds a display name, an accent colour and where
exchange rates come from, which nothing on screen changes yet.

**Owner.** [profile/ProfileContext.tsx](../web/src/profile/ProfileContext.tsx) loads
the profile, keeps a device copy, and owns every change through
`useProfile().change(show, save)`, which shows the change at once and undoes it if
`save` fails (the caller says what went wrong). `rememberSettings` does the same for a
preference and explains a failure itself.

**Parts.**

- UI: [components/home/HomePage.tsx](../web/src/components/home/HomePage.tsx) and
  [components/common/ThemeToggle.tsx](../web/src/components/common/ThemeToggle.tsx).
- API: [worker/accounts/auth.ts](../worker/accounts/auth.ts) checks the Access token (or
  the local dev user), [worker/routes/me.ts](../worker/routes/me.ts) serves `/api/me`,
  and [worker/accounts/profiles.ts](../worker/accounts/profiles.ts) stores the profile
  and settings.
- Shared: `Settings`, `DEFAULT_SETTINGS` and the profile shapes in
  [shared/api.ts](../shared/api.ts); the accent colours in
  [shared/accents.ts](../shared/accents.ts).

**Invariants.**

- Without both Access values set, the API refuses everyone, unless both are blank and a
  local dev user is set (`getUserEmail` in `accounts/auth.ts`).
- A new settings row takes every value from `DEFAULT_SETTINGS`, so defaults change in
  `shared/api.ts` alone (`accounts/profiles.ts`). A setting or value it doesn't know is
  refused, and nothing in that request is saved.
- A stale save answer never overwrites a newer change (`ProfileContext.tsx`).
- Theme and accent are also kept in `localStorage` (`sf-appearance`), so the first
  screen paints in the right colours before the profile loads.

**Tests.** [worker/accounts/auth.test.ts](../worker/accounts/auth.test.ts) (tokens,
keys, configuration, 401 versus 500), [App.test.tsx](../web/src/App.test.tsx) (who's
signed in, signed out, unreachable, saving the theme and undoing a failed save), and the
profile cases in [worker/test/api.test.ts](../worker/test/api.test.ts).

## Accounts

**What it is.** The places a person's money is: cash, bank accounts, cards and
e-wallets, each with its balance, listed on the home page. Tapping one opens its own
page (`?account=<id>`): its name, kind and balance, and its transactions (see
Transactions). Add one from Home; rename it, change its opening balance, or archive it
(with Undo; archived ones are listed apart and can be brought back) from Edit on its
page. A card's balance is what's owed on it. Its kind is fixed once added. Worker folder
`accounts/` is sign-in, not these: the ledger is `ledger/`.

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts) keeps the ledger (accounts
and categories, one request) in the query cache (`LEDGER_KEY`), with a device copy
(`ledger-v1`) shown while the first fresh one loads and offline. `change(...changes)`
is the only way the ledger changes: it shows the changes at once
([ledger/apply.ts](../web/src/ledger/apply.ts)), then hands them to
[ledger/save-queue.ts](../web/src/ledger/save-queue.ts), which keeps them in the
person's outbox on the device ([offline/outbox.ts](../web/src/offline/outbox.ts)) and
sends them in order, one request at a time, in batches of at most `MAX_CHANGES` and
`MAX_CHANGES_BYTES`, each change with its own id (`cid`). Screens read through
`useAccounts()` and `useUnsaved()` (how many are waiting) in
[ledger/useLedger.ts](../web/src/ledger/useLedger.ts).

**Parts.**

- UI: [components/accounts/AccountList.tsx](../web/src/components/accounts/AccountList.tsx)
  (the list, placeholders, empty state and archived ones),
  [AccountPage.tsx](../web/src/components/accounts/AccountPage.tsx) (one account's page)
  and [AccountForm.tsx](../web/src/components/accounts/AccountForm.tsx) (adding and
  changing one, in a `ResponsiveDialog`);
  [account-text.ts](../web/src/components/accounts/account-text.ts) reads balances out
  and opening balances in; Undo is
  [components/common/undo-toast.tsx](../web/src/components/common/undo-toast.tsx).
- API: [worker/routes/ledger.ts](../worker/routes/ledger.ts) serves `GET /api/accounts`
  (the `Ledger`: accounts and categories) and `POST /api/changes`;
  [worker/ledger/read.ts](../worker/ledger/read.ts) lists the accounts with balances,
  [changes.ts](../worker/ledger/changes.ts) checks and saves a batch, and
  [receipts.ts](../worker/ledger/receipts.ts) keeps one receipt per change id.
- Shared: `Account`, `Ledger`, `LedgerChange`, `ChangesBody` and the batch limits in
  [shared/api.ts](../shared/api.ts); kinds, limits and the name and opening-balance
  checks in [shared/ledger.ts](../shared/ledger.ts).

**Flow.** A change shows at once, joins the queue and is written to the outbox. Nothing
is sent while a batch is on its way; what's made meanwhile goes in the next one. Each
saved batch is crossed off the outbox; once nothing is left to send, the ledger is
fetched again. A copy fetched (or read from the device) while changes are still to send
has them applied on top; one that was on its way while a batch was saved is set aside
for the next. Once it's known whose the ledger is (signed in, or offline the last
person assumed), what they left in the outbox is picked up, shown and sent. A batch that
got no answer, or a 429 or 5xx, is kept and tried again after 3 seconds, doubling to a
minute; offline it waits for the connection, and a 401 or `account_mismatch` waits for
the person to be back (the connection returning, the page shown again or restored),
since a timer would only fail. A refused batch (any other 4xx) is put back to what the
server last had, the server's explanation is shown (`showError`), and it and everything
queued after it are dropped from the outbox, since they were made on top of it. While
the page is hidden, batches go with `keepalive`. With the app closed, the service
worker's background sync sends the outbox (see Offline start).

**Invariants.**

- Every query names the signed-in email; accounts are keyed by email and id, so an id of
  someone else's is answered exactly as a missing one (404) and never collides with one
  of theirs.
- A batch is checked in order against the person's accounts and categories with the
  batch's earlier changes, and saved all or nothing in one D1 batch with its receipts.
- A change id saved before with the same change is answered as saved and not applied
  again; with a different change it's refused (409). Receipts last 90 days
  (`RECEIPT_DAYS`).
- At most `MAX_ACCOUNTS` accounts, archived ones included, checked again as the row is
  saved (the position is NULL past it, which the table refuses), so two batches at once
  can't pass it. Names are 1 to `MAX_ACCOUNT_NAME` characters once trimmed; an opening
  balance is whole cents within `MAX_TRANSACTION` either way. A balance is the opening
  balance plus income less spending, worked out by the server in one grouped sum, never
  stored.
- The app checks a change with the same shared rules before making it; the Worker is the
  authority.
- A change leaves the outbox only once the server has saved it (or refused it), and is
  sent by one sender at a time (the outbox lock); one sent again after its answer was
  lost is counted once by its id.

**Tests.** [apply.test.ts](../web/src/ledger/apply.test.ts),
[save-queue.test.ts](../web/src/ledger/save-queue.test.ts) (order, kept on the device
until saved and crossed off per batch, a refusal dropping the rest, picked up after a
reload, another person's never picked up, retries and waits for each kind of failure),
[outbox.test.ts](../web/src/offline/outbox.test.ts) (batching by count and bytes),
[delivery.test.tsx](../web/src/offline/delivery.test.tsx) (offline, a reload, a lost
answer, a refusal once back, Undo offline, signed out, storage full, hidden pages,
signing out, another person signing in),
[Accounts.test.tsx](../web/src/components/accounts/Accounts.test.tsx) (adding,
cards, renaming and archiving from an account's page, Undo, refusals put back, a failing server tried again,
answers out of order, at desktop and phone sizes), and the accounts cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (every refusal, another person's
account, receipts, all or nothing).

## Categories

**What it is.** What spending and income are sorted into, on their own page (`?categories`,
reached from Home): a Spending list and an Income list, each top-level category with its
subcategories under it. Add one (at the top level or under another), rename it, put it
higher or lower with its arrows, move it under another or back to the top level, or
archive it (with Undo; archived ones are listed apart and can be brought back). Moves
that aren't allowed can't be picked, and say why. Everyone starts with the defaults:
Food, Transport, Groceries, Bills, Shopping, Health, Fun and Other for spending, Salary
and Other income for income. Transactions will name a category once they land.

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts), the same as accounts: every
change goes through `change()`, so it shows at once, is kept in the outbox, works offline
and is put back if refused. [ledger/apply.ts](../web/src/ledger/apply.ts) makes category
changes the way the server does; [ledger/category-tree.ts](../web/src/ledger/category-tree.ts)
arranges them as listed. Screens read through `useCategories()` in
[ledger/useLedger.ts](../web/src/ledger/useLedger.ts).

**Parts.**

- UI: [components/categories/CategoriesPage.tsx](../web/src/components/categories/CategoriesPage.tsx)
  (the two lists, arrows, placeholders and archived ones) and
  [CategoryForm.tsx](../web/src/components/categories/CategoryForm.tsx) (adding, renaming,
  moving and archiving, in a `ResponsiveDialog`); the link on
  [components/home/HomePage.tsx](../web/src/components/home/HomePage.tsx).
- API: `addCategory`, `updateCategory` (name, parent, place) and `archiveCategory` in
  [worker/ledger/changes.ts](../worker/ledger/changes.ts); categories are read with the
  accounts in [worker/ledger/read.ts](../worker/ledger/read.ts).
- Shared: `Category` and the change shapes in [shared/api.ts](../shared/api.ts); kinds,
  limits, the defaults (`DEFAULT_CATEGORIES`, fixed ids), what can sit under what
  (`whyNotUnder`, `whyStaysOnTop`) and how siblings are ordered (`siblingsOf`,
  `nextPosition`, `reorder`) in [shared/categories.ts](../shared/categories.ts).

**Flow.** Nothing is saved for a person until their first change of any kind (an account
added, say), which saves the defaults first, in the same D1 batch, with an insert that does
nothing once they have any. Until then `GET /api/accounts` answers no categories, and the
app shows the defaults in their place (`categoriesOrDefaults`, which the Worker uses too),
so a change to a default made before then names a row the same batch saves. Moving one
puts it last among its new siblings; a place (`position`) puts it there among its
siblings, counted without it, and numbers them afresh from 0. The arrows step past the
listed category beside it, whatever archived ones lie between.

**Invariants.**

- One level deep: a subcategory's parent is a top-level, listed (not archived) category of
  the same kind, and a category with subcategories (archived ones too) stays at the top
  level. The app and the Worker ask the same rule; the database holds it too, with
  triggers, so two saves at once can't get round it, and a composite foreign key keeps a
  parent among the person's own categories.
- At most `MAX_CATEGORIES` per person and `MAX_SUBCATEGORIES` under one category,
  archived ones included, checked again as each row is saved (its position is NULL past
  either, which the table refuses). Names are 1 to `MAX_CATEGORY_NAME` characters once
  trimmed. A category's kind never changes.
- Archived, never deleted, so a person with none saved has never saved a change. A
  subcategory of an archived category is out of the list with it and comes back with it.
- Someone else's category id is answered exactly as a missing one (404).

**Tests.** [apply.test.ts](../web/src/ledger/apply.test.ts) (adding, moving, placing,
archiving, applied twice), [category-tree.test.ts](../web/src/ledger/category-tree.test.ts),
[Categories.test.tsx](../web/src/components/categories/Categories.test.tsx) (opening from
Home with the defaults, adding a subcategory, renaming, moving, the arrows, moves that
can't be picked and why, archiving and Undo, bringing back, a refusal put back, offline
through a reload, at desktop and phone sizes), and the categories cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (the defaults with the first
change, every refusal, limits, someone else's, receipts, all or nothing with accounts,
and the database's own guard).

## Transactions and quick entry

**What it is.** Money spent from an account, or that came into one, each in a category
of its kind; and transfers, money moved from one of the person's accounts to another
(an e-wallet top-up, paying off a card), with no category. Add, floating over Home and
each account's page, opens the entry sheet: the amount first (focused, the phone's
number keyboard), Spent, Received or Transfer, the account and category used last on
this device (the account's own on its page; else the first), for a transfer From and To
(To is the account moved to last, never the one it comes from),
the day (today, in the person's own time zone), and a payee and note under More. An RM 8
coffee with the defaults is: Add, 8, Save. An account's page lists its transactions
newest first, grouped by day, 50 at a time with Load more; tapping one opens it in the
same sheet to change it, or Delete it (with Undo, which adds it again with the same id).
A transfer shows on both its accounts' pages, as "To Visa" (−) on the one it left and
"From Maybank" (+) on the one it reached. Any kind can become another if what that kind
needs goes with it: a category of its kind for spending and income, the account it goes
to (and no category) for a transfer.

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts), as for accounts: every
change goes through `change()` and the outbox, so entry works offline. Lists of
transactions are infinite queries keyed by account (`accountTransactionsKey`) or month
(`monthTransactionsKey`, which no screen lists yet), kept as the server has them: each
batch is added once saved, a page fetched while one was saved gets it on top
(`savedLog`), and the changes still to send are put on top as they're shown
(`shownPages`), so a page never has to be put back. An account's first page is kept on
the device (`transactions-v1:<id>`) and shown from there offline.
[ledger/apply.ts](../web/src/ledger/apply.ts) moves balances by what each change does to
a transaction (`Lookup` gives it as it was) and puts each one on the page its day falls
in (`applyToPages`). Screens read through `useAccountTransactions(accountId)` in
[ledger/useLedger.ts](../web/src/ledger/useLedger.ts).
[ledger/last-used.ts](../web/src/ledger/last-used.ts) keeps the account and each kind's
category used last, and the account a transfer went to last, by id, per person
(`localStorage`, let go on signing out).

**Parts.**

- UI: [components/entry/EntrySheet.tsx](../web/src/components/entry/EntrySheet.tsx)
  (the sheet, adding and changing, Delete),
  [entry-text.ts](../web/src/components/entry/entry-text.ts) (typed amounts in cents with
  `toCents`, amounts signed for the account shown, and a transfer's "To Visa" or
  "From Maybank"), the account's page in
  [components/accounts/AccountPage.tsx](../web/src/components/accounts/AccountPage.tsx),
  the Add on [HomePage.tsx](../web/src/components/home/HomePage.tsx), and
  [components/common/category-name.ts](../web/src/components/common/category-name.ts)
  ("Food › Coffee").
- API: `GET /api/transactions?account=<id>` (transfers into it too) or `?month=2026-11`
  (a transfer once), with `&before=` and
  `&limit=` (`listTransactions` in [worker/ledger/read.ts](../worker/ledger/read.ts));
  `addTransaction`, `updateTransaction` and `removeTransaction` in
  [worker/ledger/changes.ts](../worker/ledger/changes.ts); balances in `listAccounts`
  there.
- Shared: `Transaction`, `NewTransaction`, `TransactionPage` and the change shapes in
  [shared/api.ts](../shared/api.ts); kinds, limits, `isDay`, `readOptionalText`,
  `whyNotInCategory`, `whyNotOnAccount`, `whyNotBetween`, `isOnAccount` (an account's
  list) and `balanceEffect` (how a transaction moves each account's balance, used by the
  app's optimistic balances and the test stand-in) in [shared/ledger.ts](../shared/ledger.ts).

**Flow.** Save checks the amount, day and category with the shared rules, makes the
change (shown at once: the list and the balances), remembers the account and category,
and the save queue sends it. A first-ever batch that names a default category saves the
defaults first. Pages come newest first by day, then by when saved, then id; the
`nextBefore` cursor carries on after the last one, so ties are never skipped or shown
twice.

**Invariants.**

- An account's balance is its opening balance plus its income and transfers in, less its
  spending and transfers out; on a card, spending grows what's owed and a transfer to it
  (paying it) shrinks it.
- A transfer is never spending or income: it has no category, and anything that sums
  spending or income counts only `expense` and `income` rows. It goes between two
  different listed accounts of the person's (`whyNotBetween`); `to_account_id` is set
  only on transfers.
- A transaction goes on a listed account of the person's, in a listed category of the
  person's whose kind matches (spending in spending ones), with an amount of 1 cent to
  `MAX_TRANSACTION`, a day from 2000 to tomorrow in UTC (`isDay`), and a payee and note
  trimmed to at most `MAX_PAYEE` and `MAX_NOTE` (empty is none). The kind and category
  are checked as a pair whenever either changes, and the kind and the account it goes to
  whenever the kind or either account changes. The app asks the same rules; the
  Worker is the authority.
- At most `MAX_TRANSACTIONS_PER_ACCOUNT` on one account, every kind counted and a
  transfer on both its accounts, checked again inside the INSERT or move for each
  account it newly lands on (the account is NULL past it, which the table refuses), so
  two batches at once can't pass it.
- Someone else's account, category or transaction is answered as one that doesn't exist
  (404), in reading and in changes.
- Deleting really deletes the row; nothing else refers to a transaction.

**Tests.** [apply.test.ts](../web/src/ledger/apply.test.ts) (balances for each change,
transfers on both accounts, pages: where a new one goes, moved out and in, a transfer in
both accounts' lists, edited days, applied twice),
[Entry.test.tsx](../web/src/components/entry/Entry.test.tsx) (RM 8 coffee in two steps,
income, last used remembered through a reload, subcategories, what's wrong, a refusal
put back, offline through a reload; the account page by day, placeholders, Load more,
editing, spending to income, Delete and Undo, adding on an account's page, an archived
one; transfers: an e-wallet top-up then spending from it, paying a card, To offered,
editing, Delete and Undo, offline through a reload; desktop and phone), and the
transactions cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (balances of each kind, transfers
on both accounts' pages and once in a month, a card paid off, kinds switched, every
refusal, paging with ties, a month, the limit per account, receipts, all or nothing,
defaults with a first transaction).

## Month view

**What it is.** The top of Home: one month at a glance, this month unless the address
names an earlier one (`?month=2026-10`; the arrows step between months, never past
this one, and Back returns). What's left (received less spent) is the largest number;
when more was spent than came in it says "Over", in the negative colour, with a line
saying by how much. Spent and Received sit beneath it, then spending by top-level
category, largest first, each with a bar for its share of the month's spending. A
category with subcategories opens to show each one's amount and what was filed under
the category itself; income by category is folded under Received. Placeholders show
until the month arrives; an empty month says so. It isn't shown until the first account
is added.

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts), as for transactions. A
month's totals are a query keyed by month (`summaryKey`), fetched from the server
(`fetchSummary`) with a device copy (`summary-v1:<month>`) shown offline. They're kept
as the server summed them, with each saved batch counted in (before the lists take it,
so an edited transaction is taken out as it was), and the changes still to send counted
on top as they're shown (`shownSummary`). Once nothing is left to send they're fetched
again. [ledger/summary.ts](../web/src/ledger/summary.ts) (`applyToSummary`) does the
counting the way the server sums; [ledger/derive.ts](../web/src/ledger/derive.ts)
(`rollUp`) puts subcategories inside their top-level category for showing. Screens read
through `useMonthSummary(month)` in [ledger/useLedger.ts](../web/src/ledger/useLedger.ts).

**Parts.**

- UI: [components/home/MonthCard.tsx](../web/src/components/home/MonthCard.tsx), on
  [HomePage.tsx](../web/src/components/home/HomePage.tsx); months in
  [utils/date-input.ts](../web/src/utils/date-input.ts) (`thisMonth`, `addMonths`,
  `monthHeading`).
- API: `GET /api/summary?month=2026-11` (`readSummary` in
  [worker/ledger/summary.ts](../worker/ledger/summary.ts)): one grouped SQL sum.
- Shared: `MonthSummary` and `CategoryTotal` in [shared/api.ts](../shared/api.ts);
  `isMonth` in [shared/ledger.ts](../shared/ledger.ts).

**Flow.** The server sums the person's spending and income in the month (by the day a
transaction is on) across every account, grouped by each category's own id, largest
first. The app rolls subcategories up into their parent by the categories it has now, so
a subcategory moved under another category moves its spending with it.

**Invariants.**

- Only spending and income count. A transfer is never spending or income, and is left
  out by name in the SQL and in `applyToSummary`.
- Every total is exact: at most `MAX_ACCOUNTS` x `MAX_TRANSACTIONS_PER_ACCOUNT` x
  `MAX_TRANSACTION_CENTS` (5e15 cents) per person, under what a number holds exactly;
  each list has at most one row per category (`MAX_CATEGORIES`). Left is received less
  spent, in cents.
- Scoped to the signed-in person's own transactions; a month is 2000-01 or later.
- A change is counted once: a month's totals fetched while a batch was being saved are
  set aside for the fetch once nothing is left to send, rather than counted again.
- Archived categories still count; an amount in a category the app doesn't know is shown
  as "Unknown category" rather than dropped.

**Tests.** [summary.test.ts](../web/src/ledger/summary.test.ts) (adding, moving across
categories and months, deleting and Undo, spending to income, transfers, unknown ones),
[derive.test.ts](../web/src/ledger/derive.test.ts) (roll-up, unknown parents and
categories), [MonthCard.test.tsx](../web/src/components/home/MonthCard.test.tsx) (left,
spent, received, Food opened to Coffee and Food itself, income under Received, earlier
months and Back, over, placeholders, offline through a reload and once saved; desktop
and phone), and the month's totals cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (spending, income, a transfer,
subcategories under their own id, other months and other people, bad months).

## Exchange rates

**What it is.** Today's rate from one currency into another, or the rate on an earlier
day, for previews. Nothing on screen asks for one yet; `useRate` is there for the first
feature that converts.

**Owner.** [hooks/useRate.ts](../web/src/hooks/useRate.ts) fetches and shares a rate
through the query cache, keyed by the pair, the account's rate source and the day.

**Parts.**

- API: [worker/routes/rates.ts](../worker/routes/rates.ts) serves `/api/rates`, and
  [worker/currency/exchange-rates.ts](../worker/currency/exchange-rates.ts) fetches from
  Wise (with a `WISE_TOKEN`) and the European Central Bank (through Frankfurter), the
  account's preferred one first, kept in Cloudflare's cache for 4 hours.
- Shared: [shared/rates.ts](../shared/rates.ts) converts in whole cents (`toCents`,
  `convertCents`) and states the limits (`MAX_AMOUNT`, `MAX_AMOUNT_CENTS`, `MIN_RATE`,
  `MAX_RATE`).

**Invariants.**

- A conversion is one multiplication and one rounding, in cents, the same in the app's
  preview and on the server.
- An amount asked about is at most `MAX_AMOUNT`; a rate outside `MIN_RATE` to `MAX_RATE`
  is never used.
- An earlier day's rate is the ECB's for that day (the working day before, on a
  weekend), else Wise's; a service that is down is an error, never quietly today's rate.

**Tests.** [worker/currency/exchange-rates.test.ts](../worker/currency/exchange-rates.test.ts)
(sources, fallbacks, caching, earlier days) and the rate cases in
[worker/test/api.test.ts](../worker/test/api.test.ts).

## Offline start and installing

**What it is.** The app installs as an app and opens offline or on a bad connection,
showing what this device last loaded with the changes made since on top. Changes made
offline are kept on the device and saved once the connection is back, even with the
app closed. The offline notice says so, with how many are waiting; it offers Sign in
when the session ran out, and warns when the device can't keep changes.

**Owner.**

- [offline/cache.ts](../web/src/offline/cache.ts): device copies tagged with the
  signed-in account, and the marks the service worker and sign-in leave on the page.
- [offline/outbox.ts](../web/src/offline/outbox.ts): each person's changes not yet saved
  (`outbox:<email>`), the lock the app and the service worker share
  (`mahnee-outbox:<email>`, Web Locks or turns within the page), how a queue is split into
  requests, and which failures are kept. The ledger's save queue sends from it.
- [offline/storage-health.ts](../web/src/offline/storage-health.ts): whether the last
  write to the outbox was kept, for the notice
  ([components/shell/OfflineNotice.tsx](../web/src/components/shell/OfflineNotice.tsx)).
- [offline/storage.ts](../web/src/offline/storage.ts): once the app is installed, asks
  the browser (once per device) not to clear what's kept when space runs low.
- [pwa/install.ts](../web/src/pwa/install.ts): the browser's install prompt, kept for
  the home page's Get the app card
  ([components/common/InstallApp.tsx](../web/src/components/common/InstallApp.tsx)).

**Parts.** [web/public/sw.js](../web/public/sw.js) keeps the page, the built files, the
manifest and icons, and web fonts. It never keeps anything from `/api`. On background
sync (`mahnee-outbox`, registered by the app when a send fails or it's offline) it sends
the signed-in account's outbox under the same lock, as that account. It can't import
app code, so the names and limits it shares with `offline/cache.ts`, `offline/outbox.ts`
and `shared/api.ts` are copied in it, each naming its twin. The build
writes `precache.json`, every built file the app needs offline
([web/build/precache.ts](../web/build/precache.ts)).

Opening the app: [web/index.html](../web/index.html) paints a first screen before the
app's code loads, in the theme this device saved or the phone's own on Auto, with the
logo drawing itself; [pwa/launch-screen.ts](../web/src/pwa/launch-screen.ts) fades it
out once the app is up and keeps the status bar following the theme. iPhones show plain
launch screens in the theme's background, made at build time
([web/build/launch-images.ts](../web/build/launch-images.ts)).

**Flow.** A page load waits up to 3 seconds for the network; offline, slower, or a 5xx
or non-page answer, and the kept page opens instead, marked as opened from the device.
When Cloudflare Access asks to sign in again (a redirect) and a page is kept, the kept
page opens marked as signed out (`OPENED_SIGNED_OUT`): the last account's saved profile
shows, and the notice offers Sign in once there's a connection. Sign in goes to the
same page marked with `SIGN_IN_PARAM`, which the service worker leaves to the browser so
Access answers; the mark comes off the address once back (`dropSignInMark`). With
nothing kept yet, a sign-in redirect goes to the browser. A 4xx goes to the browser too,
and `/cdn-cgi/` (Access) is never handled. Opened from the device, the profile waits 2
seconds on `/api/me` (or not at all if it fails with a 5xx), then shows the last
account's saved copy ([ProfileContext](../web/src/profile/ProfileContext.tsx)).

**Invariants.**

- Nothing kept on the device is shown before the signed-in account is known, and one
  account never sees another's. The last account is only assumed offline, or when the
  page was opened from the device; if the server then names someone else, their copies
  are dropped (their unsaved changes kept for them, unread and unsent) and the app
  reloads. Signing out drops everything kept for the account, its unsaved changes too,
  after asking when any are waiting
  ([components/home/useConfirmSignOut.tsx](../web/src/components/home/useConfirmSignOut.tsx)).
- The app and the service worker read a failed send the same way: no answer, a non-JSON
  answer, 401, 429, 5xx and `account_mismatch` are kept; any other 4xx drops the rest.
- Every write names the account it was made as (`X-Expected-Account`, from `writeAs` in
  [api.ts](../web/src/api.ts)). The server refuses one for another account (409
  `account_mismatch`) before it changes anything. With `REQUIRE_EXPECTED_ACCOUNT=true` a
  write that names no account is refused (503 `client_update_required`).
- The kept page is only replaced once every file it and `precache.json` name is kept,
  so a stopped update leaves the old page whole. Built files of the newest two pages are
  kept, for a tab still open on the older one.
- The manifest and the icons it names are kept beside the page and answered from there
  when the network fails or Access answers in their place, so a page opened from the
  device still installs properly (`INSTALL_FILES` in `sw.js`).

**Tests.** [cache.test.ts](../web/src/offline/cache.test.ts),
[shell.test.ts](../web/src/offline/shell.test.ts) (slow, failing and redirected page
loads, stopped updates, which files are kept),
[sw.test.ts](../web/src/offline/sw.test.ts) (web fonts, the API left alone, background
sync against what the app keeps, and the app and service worker reading every answer
alike), [outbox.test.ts](../web/src/offline/outbox.test.ts) (the shared keys and lock,
another account's changes kept through sign-in and sign-out),
[start.test.tsx](../web/src/offline/start.test.tsx) (starting from the device's copy,
and once Access asks to sign in again),
[storage.test.ts](../web/src/offline/storage.test.ts),
[launch-screen.test.ts](../web/src/pwa/launch-screen.test.ts) and
[web/build/precache.test.ts](../web/build/precache.test.ts).

## Pages, layouts and Back

**What it is.** Which page shows, the layouts for phones, tablets and computers, and
what Back does. There are three pages so far: the home page, with the month and the
accounts on it (an earlier month as `?month=2026-10`), the categories page
(`?categories`) and an account's page (`?account=<id>`), both of which go back up to
Home.

**Owner.**

- [hooks/useRoute.ts](../web/src/hooks/useRoute.ts): pages come from the query string
  through `navigate()`, and the last page reopens on a fresh start (on this month: a
  month in the address is never reopened, `TRANSIENT`). A page opened from
  another goes back up with `goUp`: Back when it came from there, else straight there in
  its own place. Each page the app gains adds its view to `Route`.
- [hooks/useBreakpoints.ts](../web/src/hooks/useBreakpoints.ts): `useIsMobile` (under
  768px) and `useIsDesktop` (1024px and up).
- [hooks/useBackDismiss.ts](../web/src/hooks/useBackDismiss.ts): Back closes the top
  sheet on phones.

**Parts.**

- [components/shell/AppLayout.tsx](../web/src/components/shell/AppLayout.tsx): the page,
  with the offline and new-version notices over it.
- [ResponsiveDialog](../web/src/components/ui/ResponsiveDialog.tsx): a sheet on phones,
  a dialog elsewhere.
- [Skeleton](../web/src/components/ui/Skeleton.tsx): the shimmering placeholders a page
  shows until its data arrives.

**Invariants.**

- Sheets and dialogs never push history entries themselves; they open through
  `ResponsiveDialog` or `useBackDismiss`, so Back closes the top one first.
- Until a page's data arrives it shows placeholders the size of what will replace them,
  never an empty or zero state that then changes.

**Tests.** [App.test.tsx](../web/src/App.test.tsx), with phone cases
(`{ size: 'phone' }`), and
[isolation.test.tsx](../web/src/testing/isolation.test.tsx) (each screen test starts
from nothing).
