# Feature map

Where each feature lives, which module owns its state and changes, what it must keep
true, and which tests hold it to that. Read the entry for a feature before extending
it, and update the entry in the same change when its owner, entry points, data flow or
contracts change. Presentation-only changes need no update here.

The data model is in [erd.md](erd.md). How the Worker's routes and modules fit together
is at the top of [worker/app.ts](../worker/app.ts). The rules every change follows are
in [AGENTS.md](../AGENTS.md).

| Feature                                                         | State owner (app)            | Worker                         |
| --------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| [Sign-in, profile and settings](#sign-in-profile-and-settings)  | `profile/ProfileContext.tsx` | `accounts/`, `routes/me.ts`    |
| [Accounts](#accounts)                                           | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Categories](#categories)                                       | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Transactions and quick entry](#transactions-and-quick-entry)   | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Month view](#month-view)                                       | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Search and changing many](#search-and-changing-many)           | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Repeating bills and month end](#repeating-bills-and-month-end) | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Export](#export)                                               | (none; read when asked)      | `ledger/`, `routes/ledger.ts`  |
| [Import](#import)                                               | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Exchange rates](#exchange-rates)                               | `hooks/useRate.ts`           | `currency/`, `routes/rates.ts` |
| [Offline start and installing](#offline-start-and-installing)   | `offline/`, `pwa/`           | (none; the API is the same)    |
| [Pages, layouts and Back](#pages-layouts-and-back)              | `hooks/useRoute.ts`          | (none)                         |

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

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts) keeps the ledger (accounts,
categories and repeating items, one request) in the query cache (`LEDGER_KEY`), with a device copy
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
  (the `Ledger`: accounts and categories, and `alreadySaved` when the read names changes
  in `X-Pending-Changes`) and `POST /api/changes`;
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
for the next. A batch the server saved whose answer was lost stays waiting, so a copy
fetched in that gap may hold it already: each read of the ledger (and of a month's
totals) names the first `MAX_CHANGES` changes waiting (`X-Pending-Changes`; at most 200
ids, about 3.4 KB, as many as one request sends), the server answers which of them it
holds (`alreadySaved`, read in the same D1 batch as the figures), and those are not
applied on top of that copy, nor on the copy kept on the device, nor again on
`confirmed` when their answer finally comes. A read learns which are waiting from the
outbox without its lock, once it's known whose it is, but waits at most 1.5 seconds for
that; changes found waiting later are asked about again (the ledger read once more, and
months' totals refetched when they're found). Once it's known whose the ledger is
(signed in, or offline the last person assumed), what they left in the outbox is picked
up, shown and sent. A batch that
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
  lost is counted once by its id, by the server and in the balances shown
  (`alreadySaved`), even when a fresh copy is fetched before it's sent again.

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
  set aside for the fetch once nothing is left to send, rather than counted again; and
  a change saved whose answer was lost, which the totals hold already (their
  `alreadySaved`), is neither counted on top of them nor counted in again when it's saved.
- Archived categories still count; an amount in a category the app doesn't know is shown
  as "Unknown category" rather than dropped.

**Tests.** [double-count.test.tsx](../web/src/ledger/double-count.test.tsx) (a save whose
answer was lost, with fresh balances and totals fetched before it's sent again, and across
a reload: never counted twice, at any moment),
[summary.test.ts](../web/src/ledger/summary.test.ts) (adding, moving across categories
and months, deleting and Undo, spending to income, transfers, unknown ones),
[derive.test.ts](../web/src/ledger/derive.test.ts) (roll-up, unknown parents and
categories), [MonthCard.test.tsx](../web/src/components/home/MonthCard.test.tsx) (left,
spent, received, Food opened to Coffee and Food itself, income under Received, earlier
months and Back, over, placeholders, offline through a reload and once saved, each
change counted at once while an earlier one is being saved; desktop and phone), and the month's totals cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (spending, income, a transfer,
subcategories under their own id, other months and other people, bad months).

## Search and changing many

**What it is.** Search, a row on Home, opens its own page (`?search`) listing the
person's transactions on every account, newest first, grouped by day, 200 at a time with
Load more. Typing finds the words anywhere in the payee, the note, the category's name or
its parent's (so "food" finds Food › Coffee), ignoring the case of A to Z; words that
read as an amount ("8", "8.50", "1,000") also find that exact amount, and text containing
them ("8" finds RM 8.00, and a note "8 refund", but not RM 8.50 or RM 80). Filters narrow
it by account (transfers into it too), category (a top-level one with its subcategories)
and From and To days, both included. Tapping one opens it in the entry sheet. Select, or
a long press on a row (half a second; the release isn't a tap), ticks several: Select all
loads every page found (stopping past 500), then Change category (a preview: "Move 80
transactions from Other to Food", or "from 3 categories"; spending or income alone, no
transfers) or Delete ("Delete 12 transactions"). More than 500 ticked is refused with a
message. Catching up is this page alone: a date range and Other, Select all, Change
category; there is no review queue.

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts): a search's results are a list
of transactions like an account's, keyed by the search (`searchTransactionsKey`), so a
change shows in them at once, a page fetched while a batch was saved gets it on top, and
they're fetched again once nothing is left to send. Whether a changed transaction still
belongs in them is asked of `matchesSearch` with the categories shown. Screens read them
through `useSearch(query)` in [ledger/useLedger.ts](../web/src/ledger/useLedger.ts), which
also loads the rest for Select all (`loadAll`). A change to many is one `change()`:
`recategoriseTransactions` { ids, categoryId } or `removeTransactions` { ids }, so it's
one request, saved all or nothing, kept in the outbox offline and counted once by its id.
[ledger/apply.ts](../web/src/ledger/apply.ts) (`oneByOne`) makes it into the same change
to each transaction in turn, so balances, lists and months' totals
([summary.ts](../web/src/ledger/summary.ts)) move at once by what each was, and a copy
that holds it already (`alreadySaved`) doesn't count it again. Undo of a move is one
`recategoriseTransactions` per category they came from; Undo of a delete adds each again
with its own id (`addTransaction`), which the outbox may send in several requests.

**Parts.**

- UI: [components/search/SearchPage.tsx](../web/src/components/search/SearchPage.tsx) (the
  filters, results, selecting and the long press),
  [BulkDialogs.tsx](../web/src/components/search/BulkDialogs.tsx) (the previews) and
  [search-text.ts](../web/src/components/search/search-text.ts); the row on
  [HomePage.tsx](../web/src/components/home/HomePage.tsx).
- API: `GET /api/search?q=&account=&category=&from=&to=&before=&limit=`
  (`searchTransactions` in [worker/ledger/read.ts](../worker/ledger/read.ts), one query:
  `instr(lower(...))` on the payee, note and both category names (no pattern, so no
  length limit and no wildcards), or the amount, paged by the same
  cursor as `/api/transactions`); `recategoriseTransactions` and `removeTransactions` in
  [worker/ledger/changes.ts](../worker/ledger/changes.ts) (`readBulk`), each one UPDATE or
  DELETE over the ids.
- Shared: [shared/search.ts](../shared/search.ts) (`readSearch`, `matchesSearch`,
  `searchAmount`, `MAX_SEARCH_TEXT`), which the Worker's SQL mirrors and the test stand-in
  uses; the change shapes in [shared/api.ts](../shared/api.ts); `MAX_BULK_TRANSACTIONS`
  in [shared/ledger.ts](../shared/ledger.ts).

**Invariants.**

- Only the signed-in person's transactions are found; someone else's account or category
  as a filter is answered as one that doesn't exist (404). Words are at most
  `MAX_SEARCH_TEXT` characters; days are real calendar days.
- A change to many names 1 to `MAX_BULK_TRANSACTIONS` (500) transactions, each once,
  every one the person's (else 404), and is saved all or nothing with the rest of its
  batch. A move's category is the person's, listed, and of every transaction's kind
  (409); a transfer is never given one (400). The app refuses more than 500 before
  making the change; the Worker is the authority.
- 500 ids are about 9 KB, inside one request (`MAX_CHANGES_BYTES`).

**Tests.** [Search.test.tsx](../web/src/components/search/Search.test.tsx) (from Home and
back, words, categories and amounts, the filters, catching up from `?search` alone;
desktop and phone), [BulkEdit.test.tsx](../web/src/components/search/BulkEdit.test.tsx)
(Select, a long press, moving from one and from several categories, deleting, Undo of
each, one transaction, 501 refused and 500 in one change, balances and the month moved at
once and counted once when the answer is lost),
[apply.test.ts](../web/src/ledger/apply.test.ts) (balances, lists and months' totals for
both changes), and the searching and changing-many cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (every match and filter, paging,
someone else's, refusals with their messages, a resend counted once, 500 at once).

## Repeating bills and month end

**What it is.** Bills and income that repeat, monthly on a day of the month (on a shorter
month's last day past its end) or weekly on a weekday. Set one up with Repeat (Monthly or
Weekly) under More in the entry sheet, adding or changing a transaction: it repeats on that
transaction's day of the month or weekday, and its first due date is the next one after
that day (so one set up from an old transaction has the occurrences since due at once,
each to log or skip). Each one due (its next due date today or before, the person's own
day) is at the top of Home, "Due: Rent RM 1,200.00 from Maybank" (income "into Maybank",
a transfer "from Maybank to Visa"; with no payee, its category's name), with Log it, which
records it as a transaction on the day it was due and moves it on to its next date, and
Skip, which moves it on recording nothing; each has Undo. Nothing is recorded until one is
tapped, so balances never show money that didn't move. While anything repeats, Home shows
one total, "Expected at month end: RM 2,340.00": today's balances of every listed account
(a card's owed amount counts against them), less the bills still due this month, plus the
income still due. Still due is every occurrence of a listed item on a listed account not yet
logged or skipped, from its next due date (overdue and today's too) up to and including the
month's last day; transfers change nothing whatever their ends. So Log it leaves the total
as it was (the money moves from still due into the balance) and Skip raises it. Below zero
it says by how much in words ("RM 1,100.00 below zero"). Tapping it lists today's balances
and each occurrence still due, by day (the first 100, then how many more), and every
repeating item; tapping one opens its sheet to change what it records and when, or Stop
repeating (Undo brings it back). A stopped item is listed nowhere, so once the last one
stops the total goes and only Undo brings it back.

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts): repeating items are part of the
ledger (`Ledger.recurring`), read with the balances in one request, so the total's two
halves always come from one copy, and the never-count-twice rule (`alreadySaved`) covers a
log with no second read. Every change goes through `change()`:
`addRecurring`, `updateRecurring`, `archiveRecurring`, `logRecurring` { id, due, transaction }
and `skipRecurring` { id, due }. [ledger/apply.ts](../web/src/ledger/apply.ts) makes a log
into its transaction and the move to the next date (`oneByOne`), and leaves out a log a copy
holds already (its item moved on past `due`), so the balance and the date move together,
once. `isDueOn` keeps a second tap from logging twice. Transactions saved lately are
remembered (`recentlySaved`) so deleting a logged one (Undo) moves the balance at once,
though no list on screen holds it. [ledger/forecast.ts](../web/src/ledger/forecast.ts)
works out the total (`monthEndForecast`) and what's due now (`dueNow`) from the ledger as
shown, read through `useWholeLedger()`.

**Parts.**

- UI: [components/home/DueItems.tsx](../web/src/components/home/DueItems.tsx),
  [MonthEnd.tsx](../web/src/components/home/MonthEnd.tsx) (the total, its list and the
  items), [RecurringSheet.tsx](../web/src/components/home/RecurringSheet.tsx) and
  [recurring-text.ts](../web/src/components/home/recurring-text.ts) on
  [HomePage.tsx](../web/src/components/home/HomePage.tsx); Repeat in
  [EntrySheet.tsx](../web/src/components/entry/EntrySheet.tsx).
- API: read with the accounts (`readLedger` in
  [worker/ledger/read.ts](../worker/ledger/read.ts); `recurring` only for someone who has
  any); the five changes in [worker/ledger/changes.ts](../worker/ledger/changes.ts).
- Shared: `Recurring` and the change shapes in [shared/api.ts](../shared/api.ts); schedules,
  `nextAfter`, `fallsOn`, `onOrAfter`, `dayFor`, `monthEnd` and `MAX_RECURRING` in
  [shared/recurring.ts](../shared/recurring.ts), which the Worker, the app and the test
  stand-in use alike.

**Invariants.**

- What an item records is checked as a transaction's is: a listed account (and for a
  transfer another listed one), a listed category of its kind, an amount of 1 cent to
  `MAX_TRANSACTION`, a payee of at most `MAX_PAYEE`. Its start is a day a transaction can be
  on (up to tomorrow in UTC). Its kind never changes.
- `next_due` always falls on its schedule, and is moved at most a year ahead
  (`MAX_DUE_AHEAD_DAYS`). A new schedule or day comes with the next due
  date, worked out by the app as the first it falls on from the old one.
- A log's transaction is checked as any added one and dated the day it was due; it's saved
  with the move to the next date in one batch, only from the occurrence named (else 409
  "That was logged or skipped already"), so two devices never log one twice. A stopped item,
  or one on an archived account, is never logged or skipped.
- At most `MAX_RECURRING` (200) per person, stopped ones included, checked again as each row
  is saved. The total stays exact: at most 200 items due at most weekly since 2000 at most
  `MAX_TRANSACTION_CENTS` add about 2.8e14 to balances of at most 5e15.
- Someone else's item, account or category is answered as one that doesn't exist (404).

**Tests.** [forecast.test.ts](../web/src/ledger/forecast.test.ts) (when each schedule falls,
the total with bills, income, cards, transfers, stopped and archived, overdue and today's,
the month's last day, exactly zero, the exactness bound; due now; each change made before
the server has it, a log steady and a skip raising the total, applied twice),
[Recurring.test.tsx](../web/src/components/home/Recurring.test.tsx) (due at the top in
words, the total and its list, below zero and zero, Log it, Skip and Undo, overdue weekly,
a lost answer across a reload, set up from adding and changing a transaction and from an
old one, changing and stopping, a refusal put back, a double tap, offline, the person's own
day in Kuala Lumpur; desktop and phone), and the repeating cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (setting up, each schedule, logging
and skipping once, refusals with their messages, someone else's, all or nothing, the limit).

## Export

**What it is.** Taking everything out, so leaving the app never means leaving part of
the history behind. Export, on Home under Categories, opens a dialog that says what the
file holds before it's downloaded ("1,284 transactions from 3 Jan 2026 to 5 Nov 2026, 6
accounts, 23 categories", counted by the server), and Download saves it as
`mahnee-2026-11-05.csv`: first each account's opening balance (Kind "Opening balance",
dated the day the account was added, in UTC, signed, so what's owed on a card is
negative), in the person's order, then every transaction, oldest first, one line each.
Columns: Date, Kind (Opening balance, Spent, Received, Transfer), Account, To account,
Amount, Currency, Category, Parent category, Payee, Note, Id (the account's id on an
opening line). Every balance can be worked out again from the file. Archived accounts
(and accounts with no transactions) and categories are in it like any other, with the
names they have now. On phones and tablets the share sheet opens where the device has one for
files (Save to Files on an iPhone), else it downloads. Offline the button says "Connect
to download"; changes still waiting on the device are counted ("3 changes still being
saved won't be in the file yet") and the count is taken again as they're saved.

**Owner.** No feature state: nothing else shows the counts or the file, so
[components/home/ExportDialog.tsx](../web/src/components/home/ExportDialog.tsx) asks
for them itself (`api.getExportSummary`, `api.getExport`), counting afresh each time it
opens and as waiting changes are saved (`useUnsaved`).

**Parts.**

- UI: [ExportDialog.tsx](../web/src/components/home/ExportDialog.tsx) and the row on
  [HomePage.tsx](../web/src/components/home/HomePage.tsx);
  [utils/deliver-file.ts](../web/src/utils/deliver-file.ts) saves the file (or shares it);
  `dayText` in [utils/date-input.ts](../web/src/utils/date-input.ts).
- API: `GET /api/export` (`exportTransactions`) and `GET /api/export/summary`
  (`readExportSummary`) in [worker/ledger/export.ts](../worker/ledger/export.ts).
- Shared: `ExportSummary` in [shared/api.ts](../shared/api.ts); the columns, kinds,
  amounts, quoting and file name in [shared/export.ts](../shared/export.ts), which the
  Worker and the test stand-in both write lines with.

**Flow.** The Worker reads the person's accounts and category names, answers at once
with the header line and the opening balances, then reads transactions `EXPORT_PAGE_SIZE` at a time, oldest first
by day, time saved and id, carrying on after the last one read, and sends each page as
it's read (a `ReadableStream`). The app reads the whole answer before saving it.

**Invariants.**

- Only the signed-in person's rows; every query names their email.
- Every account's opening balance and every transaction, archived accounts' too. A failure part way stops the download with
  an error, which the app reports, so a cut-off file is never saved as the whole one.
- Amounts are written from whole cents by their digits ("1234.50", "-320.00"), never
  through floating point, and are written as numbers: never prefixed, so a negative
  opening balance stays a number. A text cell starting with `=`, `+`, `-`, `@`, a tab or
  a carriage return gets a `'` in front, so a spreadsheet never runs it as a formula; a
  text cell holding a comma, a quote or a line break is quoted.
- UTF-8 with a byte-order mark, so Excel reads "RM" and non-Latin names right. Lines end
  in CRLF.
- The answer is `Cache-Control: no-store`, and nothing in it is logged or kept by the
  Worker or the service worker (which leaves `/api` alone).
- Bounded by `MAX_ACCOUNTS` x `MAX_TRANSACTIONS_PER_ACCOUNT` rows. A very long history
  is still subject to the Worker's per-request limits (CPU time, and D1 queries per
  request: one per `EXPORT_PAGE_SIZE` transactions).

**Tests.** The export cases in [worker/test/api.test.ts](../worker/test/api.test.ts)
(the exact file: opening balances, a card's negative one and an account with no
transactions among them, then spending, income, a transfer, a subcategory, a renamed and
an archived account, quoting, the formula guard, another person left out; the header alone
for someone with nothing; paging past 2,000 rows on one day and time; the counts and
days), [shared/export.test.ts](../shared/export.test.ts) (a negative amount stays a
number while text starting with "-" is guarded; the UTC day), and [Export.test.tsx](../web/src/components/home/Export.test.tsx) (counts and
days, downloading with today's name and the server's bytes, nothing logged yet, offline
and changes still being saved, a failed download saving nothing; desktop and phone).

## Import

**What it is.** Bringing in a CSV file, on its own page (`?import`, from the Import row
on Home under Export). Pick the account and the file; for a bank's file, say which column
is the date, the amount (one column, below zero or in brackets for money out) or money in
and money out, the payee and the note. The mapping is remembered per account on this
device. Preview shows every row before anything is saved: money out as spending, money in
as income, each in the category its payee was last filed under (`GET
/api/payee-categories`; when that fails online the page says so), else Other or Other income, changeable per row. Dates are read day first, as the page says. A row with the
same account, day, amount (money in and money out differ) and payee (trimmed, ignoring
case; empty only matches empty) as a saved or waiting one says "Looks already saved" and
is left unticked; it can be ticked anyway. A row it can't read, or that can't go where it
says (an archived account), says why and can't be ticked; a payee or note cut to fit says
so. Mahnee's own export (known by its header) needs no mapping: its accounts are found by
name and those missing added (the file doesn't say their kinds, so each is asked), its
categories by kind, name and parent and added when missing (one matched only archived
falls back to Other), and an existing account's different opening balance is listed,
unticked, and changes only if ticked. Export then import into a fresh account, then
export again, gives the same file but for ids and the days accounts were added. A file of
more than `MAX_IMPORT_ROWS` (5,000) rows is refused before the preview; the preview shows
100 rows at a time. After a bank file the account's page opens; after an export, Home.

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts): Import makes every change
with `change()` (accounts, opening balances, categories, then transactions in the file's
order), so it shows at once, works offline and goes through the outbox in batches of
`MAX_CHANGES` / `MAX_CHANGES_BYTES` (5,000 rows is about 27 requests, sent one at a time;
a 429 is kept and tried again), each change counted once by its id. `transactionsSince`
there reads an account's transactions back to the file's first day (200 a page), with
what was saved meanwhile and the changes still to send on top; offline, the pages this
device has and the changes still to send. What the page works out before saving is its
own: [components/import/import-plan.ts](../web/src/components/import/import-plan.ts)
(`planBankFile`, `planExport`, `markSaved`, `importChanges`), and
[remembered-mapping.ts](../web/src/components/import/remembered-mapping.ts) keeps the
column names per email and account (`localStorage`, let go on signing out).

**Parts.**

- UI: [components/import/ImportPage.tsx](../web/src/components/import/ImportPage.tsx)
  and the row on [HomePage.tsx](../web/src/components/home/HomePage.tsx).
- API: `GET /api/payee-categories?account=` (`readPayeeCategories` in
  [worker/ledger/payees.ts](../worker/ledger/payees.ts)): one query, the latest category
  per kind and `lower(payee)`, that account's first, newest first, at most
  `MAX_PAYEE_CATEGORIES`.
- Shared: [shared/csv-import.ts](../shared/csv-import.ts) reads the file (`parseCsv`,
  quoted cells and a byte-order mark), days (DD/MM/YYYY, YYYY-MM-DD, D MMM YYYY), amounts
  in whole cents (commas, RM, brackets), bank rows by mapping, export lines (undoing the
  export's formula guard), and which rows look already saved (`looksSaved`); `PayeeCategory`
  in [shared/api.ts](../shared/api.ts).

**Invariants.**

- Nothing is saved until Import, and then only the rows ticked; every change is checked
  by the Worker as any other.
- New transaction ids are never the file's: one random prefix per import and a rising
  count, so same-day rows keep the file's order.
- A row is a duplicate of at most one saved or waiting transaction, so two alike in a file
  are both new against one saved, and importing the same file twice adds nothing.
- Amounts are read by their digits into whole cents, at most `MAX_TRANSACTION`.

**Tests.** [shared/csv-import.test.ts](../shared/csv-import.test.ts) (cells, days,
amounts, bank rows and what's wrong with them, export lines read back as written, the
duplicate rule, the limit), [Import.test.tsx](../web/src/components/import/Import.test.tsx)
(mapping and remembering it, money in and out, already saved and ticked anyway, the
same file twice, categories from payees, shortened text, 5,001 refused, 5,000 on a phone
with a lost answer counted once, offline, the export round trip, opening balances; desktop
and phone), and the payee categories cases in
[worker/test/api.test.ts](../worker/test/api.test.ts).

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
showing what this device last loaded with the changes made since on top. While Home's
balances or month come from that copy (offline, or the server hasn't answered yet), a
small line under the title says how old they are ("Updated 2 hours ago"); fresh from the
server it says nothing. Changes made
offline are kept on the device and saved once the connection is back, even with the
app closed. The offline notice says so, with how many are waiting; it offers Sign in
when the session ran out, and warns when the device can't keep changes.

**Owner.**

- [offline/cache.ts](../web/src/offline/cache.ts): device copies tagged with the
  signed-in account and the time each was kept (`readCacheEntry`), and the marks the
  service worker and sign-in leave on the page.
- [ledger/ledger.ts](../web/src/ledger/ledger.ts): which of the ledger and months'
  totals are shown from the device copy, and when the server last confirmed each
  (`dataAge`, read through `useDataAge` and shown by
  [components/home/Staleness.tsx](../web/src/components/home/Staleness.tsx)); a fresh
  answer clears it, and months shown from the device are fetched again once the ledger
  comes fresh.
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
[start.test.tsx](../web/src/offline/start.test.tsx) (starting from the device's copy, with
how old it is, and once Access asks to sign in again),
[Staleness.test.tsx](../web/src/components/home/Staleness.test.tsx) (nothing said when
fresh, "Updated 2 hours ago" offline and while the server hasn't answered),
[first-read.test.tsx](../web/src/offline/first-read.test.tsx) (the first read of the
balances goes while the server is slow to say who's signed in, and never waits for good
when signed out),
[storage.test.ts](../web/src/offline/storage.test.ts),
[launch-screen.test.ts](../web/src/pwa/launch-screen.test.ts) and
[web/build/precache.test.ts](../web/build/precache.test.ts).

## Pages, layouts and Back

**What it is.** Which page shows, the layouts for phones, tablets and computers, and
what Back does. There are five pages so far: the home page, with the month and the
accounts on it (an earlier month as `?month=2026-10`), the categories page
(`?categories`), the search page (`?search`), the import page (`?import`) and an
account's page (`?account=<id>`), each of which goes back up to Home.

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
