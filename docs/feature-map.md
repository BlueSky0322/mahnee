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
| [Home at a glance](#home-at-a-glance)                           | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Budgets](#budgets)                                             | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Search and changing many](#search-and-changing-many)           | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Repeating bills and month end](#repeating-bills-and-month-end) | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Export](#export)                                               | (none; read when asked)      | `ledger/`, `routes/ledger.ts`  |
| [Import](#import)                                               | `ledger/ledger.ts`           | `ledger/`, `routes/ledger.ts`  |
| [Exchange rates](#exchange-rates)                               | `hooks/useRate.ts`           | `currency/`, `routes/rates.ts` |
| [Offline start and installing](#offline-start-and-installing)   | `offline/`, `pwa/`           | (none; the API is the same)    |
| [Pages, layouts and Back](#pages-layouts-and-back)              | `hooks/useRoute.ts`          | (none)                         |

App paths are under `web/src/`, Worker paths under `worker/`.

## Sign-in, profile and settings

**What it is.** Cloudflare Access signs people in before the app loads. Settings
(`?settings`) says who is signed in (the name, or the email's first part, and the email)
and offers Sign out; its round initial is on Home's header on phones and tablets, and in
the sidebar on computers. The theme switch on Home saves the account's choice of light or
dark. The profile also holds a display name, an accent colour, where exchange rates come
from, and the redesign's settings (week and month start, start screen, Home density, what
Add asks first, the account Add starts on, suggestions, a time on entries, expense colour,
carry-over for new budgets, reminders) with the person's time zone. Nothing on screen
changes those yet; the settings pages come with the redesign. The accent is kept but not
drawn: every accent shows as the design's cobalt until the accent setting is offered.

**Owner.** [profile/ProfileContext.tsx](../web/src/profile/ProfileContext.tsx) loads
the profile, keeps a device copy, and owns every change through
`useProfile().change(show, save)`, which shows the change at once and undoes it if
`save` fails (the caller says what went wrong). `rememberSettings` does the same for a
preference and explains a failure itself.

**Parts.**

- UI: [components/settings/SettingsPage.tsx](../web/src/components/settings/SettingsPage.tsx),
  [components/common/you.ts](../web/src/components/common/you.ts) (the name and initial),
  [components/common/YouLink.tsx](../web/src/components/common/YouLink.tsx) and
  [components/common/ThemeToggle.tsx](../web/src/components/common/ThemeToggle.tsx).
- API: [worker/accounts/auth.ts](../worker/accounts/auth.ts) checks the Access token (or
  the local dev user), [worker/routes/me.ts](../worker/routes/me.ts) serves `/api/me`,
  and [worker/accounts/profiles.ts](../worker/accounts/profiles.ts) stores the profile
  and settings.
- Shared: `Settings`, `DEFAULT_SETTINGS` and the profile shapes in
  [shared/api.ts](../shared/api.ts); what each setting takes in
  [shared/settings.ts](../shared/settings.ts), read by the Worker and the test stand-in;
  the cobalt the app is drawn in (`COBALT_RAMP`) in
  [shared/accents.ts](../shared/accents.ts).

**Invariants.**

- Without both Access values set, the API refuses everyone, unless both are blank and a
  local dev user is set (`getUserEmail` in `accounts/auth.ts`).
- A new settings row takes every value from `DEFAULT_SETTINGS`, so defaults change in
  `shared/api.ts` alone (`accounts/profiles.ts`). A setting or value it doesn't know is
  refused, and nothing in that request is saved. Each setting's column has a CHECK
  holding what `shared/settings.ts` takes (`worker/test/migrations.test.ts`).
- `defaultAccountId` is one of the person's own accounts, not archived, or null for the
  last one used; archiving it puts it back to null. `monthStartPayId` is one of their own
  running monthly incomes, and payday needs one; when that pay stops or turns weekly the
  month goes back to `monthStartDay`, the pay kept. Both follow-ups ride in the same
  batch as the ledger change (`ledger/changes.ts`); the app's profile shows them on its
  next load, so the pieces that draw these settings refresh it after such a change.
- The account and pay a setting names are checked before its save, not in the same
  batch, so an archive or stop landing in between can leave a stale choice saved. What
  uses these settings falls back the same way: an archived default account is read as
  the last one used, and a pay that no longer fits as the month on `monthStartDay`.
- `monthStartDay` is 1 to 28, or 31 (`LAST_DAY_OF_MONTH`) for each month's last day;
  `scheduledReminderDays` is 1 to 7, or null for none; `reminderTime` is any `HH:MM` on
  the person's clock (reminders come from a cron every 15 minutes, so a time between
  slots comes at the next one). These are this change's readings of the boards, which
  draw only "The 1st", "Last day", "1 day before" and "9:00 PM".
- The app sends the device's time zone (`Intl.DateTimeFormat().resolvedOptions()`) once
  a start, after a fresh `/api/me` answer (never from the device copy), when it differs
  from the saved one; a failure is silent and left for the next start. Only a named zone
  the runtime knows, in its own letters, is saved (`isTimeZone`), never an offset. The
  server has no zone for someone until their app has started once since.
- Reminders are on by default, as drawn, but nothing sends one yet. The change that sends
  them must: choose whom to remind from push subscriptions (no subscription, no push,
  whatever the setting; no time zone, skipped); make a subscription only in the
  permission flow, from the person's tap, never on load; and show the reminder rows as
  they really are while permission isn't granted or the device can't receive pushes.
- A profile kept on the device from before a setting existed opens with that setting's
  default (`ProfileContext.tsx`).
- A stale save answer never overwrites a newer change (`ProfileContext.tsx`).
- Theme and accent are also kept in `localStorage` (`sf-appearance`), so the first
  screen paints in the right colours before the profile loads.
- Every stored accent is drawn cobalt ([theme/theme.ts](../web/src/theme/theme.ts));
  [theme/paper-ledger.test.tsx](../web/src/theme/paper-ledger.test.tsx) checks all five.
  Migration 0007 mapped the old accents to the redesign's: green stayed green, every
  other became cobalt. The change that offers the accent setting draws a stored green
  green, and amends that test's green case as the owner's decision, not as a weakened
  test.

**Tests.** [worker/accounts/auth.test.ts](../worker/accounts/auth.test.ts) (tokens,
keys, configuration, 401 versus 500), [App.test.tsx](../web/src/App.test.tsx) (who's
signed in, signed out, unreachable, saving the theme and undoing a failed save),
[profile/time-zone.test.tsx](../web/src/profile/time-zone.test.tsx) (the time zone sent
at start), the profile cases in [worker/test/api.test.ts](../worker/test/api.test.ts), and
[worker/test/migrations.test.ts](../worker/test/migrations.test.ts) (0007 on rows from
before, and every CHECK against what the API takes).

## Accounts

**What it is.** The places a person's money is: cash, bank accounts, cards and
e-wallets, each with its balance, listed on Accounts (`?accounts`) and, until Plan is
rebuilt, under Plan's month. Until the first one
is added, the first run asks where the money is kept (see Home at a glance). Tapping one opens its own page (`?account=<id>`), which goes back up to
Accounts: its name, kind and balance, and its transactions (see Transactions). Add one
from the list; rename it, change its opening balance, or archive it
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
  [components/common/undo-toast.tsx](../web/src/components/common/undo-toast.tsx), the
  design's toast (ink, an underlined Undo, no close button, gone after 6 seconds).
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
- When the first load of the ledger fails with nothing kept on the device, the tab bar or
  sidebar still shows and each screen says so with Try again. A screen opening then reads
  the failure as it stands and doesn't ask again by itself (`retryOnMount: false` in
  `useLedger.ts`), so the places never drop behind a loading state; Try again, the
  connection coming back, the page shown again and a saved change still ask.
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
answers out of order, at desktop and phone sizes),
[FailedLoad.test.tsx](../web/src/components/shell/FailedLoad.test.tsx) (a failed first load
keeping the places, asking no more until Try again), and the accounts cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (every refusal, another person's
account, receipts, all or nothing).

## Categories

**What it is.** What spending and income are sorted into, on their own page in Settings
(`?settings=categories`; the old `?categories` still opens it): a Spending list and an Income list, each top-level category with its
subcategories under it. Add one (at the top level or under another), rename it, put it
higher or lower with its arrows, move it under another or back to the top level, or
archive it (with Undo; archived ones are listed apart and can be brought back). Moves
that aren't allowed can't be picked, and say why. A top-level spending category's sheet
also sets its monthly budget (see Budgets). Everyone starts with the defaults:
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
  moving and archiving, in a `ResponsiveDialog`); the row on
  [components/settings/SettingsPage.tsx](../web/src/components/settings/SettingsPage.tsx).
- API: `addCategory`, `updateCategory` (name, parent, place) and `archiveCategory` in
  [worker/ledger/changes.ts](../worker/ledger/changes.ts); categories are read with the
  accounts in [worker/ledger/read.ts](../worker/ledger/read.ts).
- Shared: `Category` and the change shapes in [shared/api.ts](../shared/api.ts); kinds,
  limits, the defaults (`DEFAULT_CATEGORIES`, fixed ids), what can sit under what
  (`whyNotUnder`, `whyStaysOnTop`) and how siblings are ordered (`siblingsOf`,
  `nextPosition`, `reorder`) in [shared/categories.ts](../shared/categories.ts).
- Colours: [utils/category-colour.ts](../web/src/utils/category-colour.ts) works out each
  category's colour from the list, nothing stored. Top-level spending categories take
  `--c1` to `--c6` in place order (ties by id), archived ones keeping their place, then
  repeat; a subcategory wears its parent's; "Other" (the top-level spending category named
  exactly that, where import puts unsorted spending) is `--line-2` and takes no colour from
  the rest; income, at any level, is `--pos`; an id not in the list is `--line-2`.

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
(an e-wallet top-up, paying off a card), with no category. Add, in the tab bar on phones
and tablets, or New entry (or N) in the sidebar on computers, opens Add on every page that
shows them, while any account is running: the whole screen on phones and tablets, with a
keypad (1-2-3 on top, as drawn), and on computers a dialog, "New entry", whose Amount field
takes the same keys typed or pasted ("Sums work: 8+4.5"). The amount is a sum of numbers
joined by + − ×, worked out in whole cents (`shared/keypad.ts`: × before + and −, each
product rounded to the cent, half up; at most two decimals and nine digits a number; = puts
the total in place; a key that would go past `MAX_TRANSACTION` is refused, and Save and the
amount's live status say "Up to 10,000,000"). Then Expense, Income or Transfer; From (Into,
for income) and For (From, for income): the account's own on its page, else the account
set to use (`defaultAccountId`) while it's running, else the one used last on this device
("last used"), else the first; the category picked, else the kind's used last, else its
first. For a transfer From and To with their balances (To is the account moved to last,
never the one it comes from). The five recent categories of the kind are chips, newest
first, topped up with its top-level ones in order. One field, "Payee or note", fills the
payee (owner decision D10; the note is kept apart and edited on the entry's own sheet).
Today opens the day (2000 up to today, in the person's own time zone; a day left as Today
follows the clock); Repeat sets it to repeat monthly or weekly from that day. Save says what
it will do ("Save RM 12.50", "Move RM 12.50") or why it can't ("Type an amount", "The total
is below zero", "Up to 10,000,000", "Pick a day from 2000 up to today"), and does nothing
until it can. For opens the category list (a page on phones, under the row on computers):
Recent, then the rest, or what's typed found by name, or made new: under the category the
payee was last filed in ("Tealive was in Food", from `GET /api/payee-categories`), as its
own category, or under another picked; one with no room under it, a name an archived one
has, or past `MAX_CATEGORIES`, is not offered. A new category is saved with the entry, first,
in the same change. What's typed is kept as a draft on the device when Add is closed any
way but Save (Close, Back, Esc, Cancel), and opens again as left; an Add with nothing typed
keeps none. With "start with the category" (D9, `startWith`), Add opens on the category list.
An RM 8 coffee with the defaults is: Add, 8, Save. An account's page lists its transactions
newest first, grouped by day, 50 at a time with Load more; tapping one opens it in its own
sheet (EntrySheet, for changing only) to change it, payee and note apart, or Delete it
(with Undo, which adds it again with the same id).
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
category used last, the account a transfer went to last, and each kind's five recent
categories (`recent`, newest first), by id, per person (`localStorage`, let go on signing
out). Add's draft is the screen's own interaction state, kept per person on the device by
[components/entry/add-draft.ts](../web/src/components/entry/add-draft.ts)
(`mahnee:addDraft:<email>`, let go on signing out; read back only when every field is one
Add could have made, and its ids checked against the accounts and categories as listed).

**Parts.**

- UI: [components/entry/AddEntry.tsx](../web/src/components/entry/AddEntry.tsx) (Add,
  its keypad and pickers), [CategoryPicker.tsx](../web/src/components/entry/CategoryPicker.tsx)
  (finding or making the category), [add-text.ts](../web/src/components/entry/add-text.ts)
  (Save's words, the recent chips, the payee's hint);
  [components/entry/EntrySheet.tsx](../web/src/components/entry/EntrySheet.tsx)
  (changing one, and Delete),
  [entry-text.ts](../web/src/components/entry/entry-text.ts) (typed amounts in cents with
  `toCents`, amounts signed for the account shown, and a transfer's "To Visa" or
  "From Maybank"), the account's page in
  [components/accounts/AccountPage.tsx](../web/src/components/accounts/AccountPage.tsx),
  Add and New entry in [components/shell/AppLayout.tsx](../web/src/components/shell/AppLayout.tsx), and
  [components/common/category-name.ts](../web/src/components/common/category-name.ts)
  ("Food › Coffee").
- API: `GET /api/transactions?account=<id>` (transfers into it too) or `?month=2026-11`
  (a transfer once), with `&before=` and
  `&limit=` (`listTransactions` in [worker/ledger/read.ts](../worker/ledger/read.ts));
  `addTransaction`, `updateTransaction` and `removeTransaction` in
  [worker/ledger/changes.ts](../worker/ledger/changes.ts); balances in `listAccounts`
  there.
- Shared: [shared/keypad.ts](../shared/keypad.ts) (Add's calculator: `press`, `typeKeys`,
  `totalCents`, in whole cents with no floating point); `Transaction`, `NewTransaction`,
  `TransactionPage` and the change shapes in [shared/api.ts](../shared/api.ts); kinds,
  limits, `isDay`, `readOptionalText`,
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
[keypad.test.ts](../shared/keypad.test.ts) (typing rules, precedence, half-cent rounding
a floating-point multiply gets wrong, =, Delete, the largest amount, the keyboard),
[last-used.test.ts](../web/src/ledger/last-used.test.ts),
[add-draft.test.ts](../web/src/components/entry/add-draft.test.ts),
[add-text.test.ts](../web/src/components/entry/add-text.test.ts),
[AddEntry.test.tsx](../web/src/components/entry/AddEntry.test.tsx) (the form at each size,
sums, below zero, nothing, the limit, Delete held; From and For, income, transfers and
their balances, one account; which account it opens on; recent chips; the payee only;
Today and Repeat by the person's own clock in Kuala Lumpur, past midnight, days refused;
the draft through Close, Back, Esc, Cancel, a reload, saving, things gone, another person;
a new category from the payee's hint, its limits and the payees out of reach, sent first
in one request, offline; start with the category; refusals by tapping and Enter; Add as a
dialog so N and / do nothing more),
[Entry.test.tsx](../web/src/components/entry/Entry.test.tsx) (offline through a reload;
the account page by day, placeholders, Load more,
editing, spending to income, Delete and Undo, adding on an account's page, an archived
one; transfers: an e-wallet top-up then spending from it, paying a card, To offered,
editing, Delete and Undo, offline through a reload; desktop and phone), and the
transactions cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (balances of each kind, transfers
on both accounts' pages and once in a month, a card paid off, kinds switched, every
refusal, paging with ties, a month, the limit per account, receipts, all or nothing,
defaults with a first transaction).

## Month view

**What it is.** The top of Plan until Plan is rebuilt (Home draws its own figures from the
same totals; see Home at a glance): one month at a
glance, this month unless the address names an earlier one (`?plan&month=2026-10`; the arrows step between months on the same page, never
past this one, and Back returns). What's left (received less spent) is the largest number;
when more was spent than came in it says "Over", in the negative colour, with a line
saying by how much. Spent and Received sit beneath it, then spending by top-level
category, largest first, each with a bar for its share of the month's spending. A
category with subcategories opens to show each one's amount and what was filed under
the category itself; income by category is folded under Received. Every category row
(spending and income), Spent and Received open in place to their last 12 months, ending
at the month shown: one bar a month with its amount, the month shown highlighted, then
the average of the 11 months before it ("Average RM 4.13 a month (previous 11)") and
how the month shown compares ("This month RM 6.87 above average", or "the same as
average"); Spent shows all spending, Received all income after its categories.
Budgets, when the month has any, are listed after Spent and Received (see Budgets).
Placeholders show until the month arrives; an empty month says so. It isn't shown until
the first account is added.

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts), as for transactions. A
month's totals are a query keyed by month (`summaryKey`), fetched from the server
(`fetchSummary`) with a device copy (`summary-v2:<month>`) shown offline. They're kept
as the server summed them, with each saved batch counted in (before the lists take it,
so an edited transaction is taken out as it was), and the changes still to send counted
on top as they're shown (`shownSummary`). Once nothing is left to send they're fetched
again. [ledger/summary.ts](../web/src/ledger/summary.ts) (`applyToSummary`) does the
counting the way the server sums; [ledger/derive.ts](../web/src/ledger/derive.ts)
(`rollUp`) puts subcategories inside their top-level category for showing. Screens read
through `useMonthSummary(month)` in [ledger/useLedger.ts](../web/src/ledger/useLedger.ts).
The 12 months up to the month shown are a query of their own (`trendKey`, fetched with
the card by `fetchTrend`, device copy `trend-v2:<month>`), kept and counted the same way
(`shownTrend`, `applyToTrend`, each change in whichever of the 12 it falls in); screens
read them through `useMonthTrend(month)`. The card never waits on them.

**Parts.**

- UI: [components/home/MonthCard.tsx](../web/src/components/home/MonthCard.tsx) and
  [TwelveMonths.tsx](../web/src/components/home/TwelveMonths.tsx) (a row's 12 months), on
  [components/plan/PlanPage.tsx](../web/src/components/plan/PlanPage.tsx); months in
  [utils/date-input.ts](../web/src/utils/date-input.ts) (`thisMonth`, `addMonths`,
  `monthHeading`).
- API: `GET /api/summary?month=2026-11` (`readSummary` in
  [worker/ledger/summary.ts](../worker/ledger/summary.ts)): one grouped SQL sum.
  `GET /api/summary/trend?month=2026-11` (`readTrend` in
  [worker/ledger/trend.ts](../worker/ledger/trend.ts)): the 12 months ending there, each
  in the month's shape, in one grouped SQL sum over a fixed window.
- Shared: `MonthSummary`, `MonthTrend` and `CategoryTotal` in
  [shared/api.ts](../shared/api.ts); the 12 months, the average and the comparison in
  [shared/trend.ts](../shared/trend.ts);
  `isMonth` in [shared/ledger.ts](../shared/ledger.ts).

**Flow.** The server sums the person's spending and income in the month (by the day a
transaction is on) across every account, grouped by each category's own id, largest
first. The app rolls subcategories up into their parent by the categories it has now, so
a subcategory moved under another category moves its spending with it.

Each category's total also says how many transactions make it (`entries`) and, when it's
one transaction naming a payee, that payee (`payee`, for Plan's "Rent" rather than "1
entry"); the 12 months' rows say the same. A month's totals (not the 12 months) also hold,
for Home (and the rebuilt Plan):

- `spentByDay`: spending by day, oldest first, only days with any (at most 31), for Home's
  calendar. [ledger/day-by-day.ts](../web/src/ledger/day-by-day.ts) (`dayByDay`) lays out
  the period's days against the middle day so far: the median of each day's spending from
  the period's first day to today, a day with nothing counting as 0, an even count taking
  the mean of the two middle days in whole cents rounded half up; a day above it is
  "more", at or below it "less", a day still to come neither.
- `tidyUp { from, entries, categoryIds }`: how many spending transactions from the first
  of the month before (`tidyUpFrom` in [shared/categories.ts](../shared/categories.ts)) to
  the month's last day are in Other (`OTHER_EXPENSE_ID`, the default's fixed id, renamed
  or not) or a category under it, archived ones included, with those categories' ids so
  changes still to send are counted on top. It runs to the month's end, not today: an entry
  dated after this month counts on no month's Home, though an Activity filter with only
  `from` would still list it. A category moved under Other while changes wait counts once
  the totals are fetched again.

A budget's pace is `budgetPace` in [shared/budgets.ts](../shared/budgets.ts): over when
more is spent than is available (carried amount included), "faster than the month" when
spent x days is more than available x day (`periodDay`: day N of M, 0 before the period,
M once it's over), else on track. `periodDay` and `periodDays` take the period's first
and last day, never assuming the 1st, and work in calendar days from the digits, never a
Date in the device's zone; they move to a period module of their own with the month
start day, and nothing else should import them from `budgets.ts`. Callers pass today as the person's own
day, `toDateInput(new Date())` ([utils/date-input.ts](../web/src/utils/date-input.ts)),
never `toISOString()`, and screen tests pin the clock at a time where the local and UTC
days differ.

Home names the budget "running fast" by the largest lead spent x days - available x day
(exact, at most about 6e13), never by comparing two budgets' ratios by cross-multiplying
(about 4e24, past exact whole numbers), the first in the categories' order when two are
level; Home shows Tidy up for this month only. For the rebuilt Plan: its roll-up (`rollUp` in
`derive.ts`) sums `entries` into the top-level category and keeps a payee only when the
category and its subcategories hold one transaction in all. The month start day moves
Tidy up's `from` to the period's start, on the server alone.

**Invariants.**

- Only spending and income count. A transfer is never spending or income, and is left
  out by name in the SQL and in `applyToSummary`.
- The 12 months are the month shown and the 11 before it; the average is over those 11, in
  whole cents rounded half up, and the difference is from the average as shown. Each
  month of the 12 is summed exactly as the month's totals are, so the month shown's bar is
  the card's figure.
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
- Days, entries, payees and Tidy up are summed by the server in the same D1 batch as the
  totals, each one grouped query scoped by the email and bounded (31 days; one row per
  category; one count and at most `MAX_CATEGORIES` ids), counted on top by
  `applyToSummary` the same way, and answered alike by the test stand-in. A category's
  payee is known on top only while it has one entry: one taken out of two leaves none
  named (it reads "1 entry") until the totals are fetched again.
- The device copies are `summary-v2` and `trend-v2`, since copies from before days,
  entries and Tidy up are in an older shape: those (`summary-v1`, `trend-v1`) are never
  read, and stay unused on the device. The service worker keeps no copy of these keys or
  shapes (it knows only the outbox, whose it is, the shell and assets), so it doesn't
  change with them.

**Tests.** [double-count.test.tsx](../web/src/ledger/double-count.test.tsx) (a save whose
answer was lost, with fresh balances and totals fetched before it's sent again, and across
a reload: never counted twice, at any moment),
[summary.test.ts](../web/src/ledger/summary.test.ts) (adding, moving across categories
and months, deleting and Undo, spending to income, transfers, unknown ones; days, entries
and a lone payee, Tidy up's window; the 12 months without days or Tidy up),
[day-by-day.test.ts](../web/src/ledger/day-by-day.test.ts) (the middle day, zeros, even
counts rounded half up, days to come, other periods, two time zones),
[summary-copies.test.tsx](../web/src/ledger/summary-copies.test.tsx) (v2 copies kept,
older ones never read offline),
[summary-stand-in.test.tsx](../web/src/testing/summary-stand-in.test.tsx) (the stand-in
answers as the Worker does, and its 12 months match),
[derive.test.ts](../web/src/ledger/derive.test.ts) (roll-up, unknown parents and
categories), [MonthCard.test.tsx](../web/src/components/home/MonthCard.test.tsx) (left,
spent, received, Food opened to Coffee and Food itself, income under Received, earlier
months and Back, over, placeholders, offline through a reload and once saved, each
change counted at once while an earlier one is being saved; desktop and phone),
[Trends.test.tsx](../web/src/components/home/Trends.test.tsx) (every row, Spent and
Received opened to 12 months, averages, an earlier month, nothing in a year, a read that
fails, answers out of order, closing, offline through a reload and once saved),
[shared/trend.test.ts](../shared/trend.test.ts) (the months, rounding, the comparison),
and the month's totals and last 12 months cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (spending, income, a transfer,
subcategories under their own id, other months and other people, the window's edges, bad
months; days, entries and lone payees, Tidy up's window, Other's subcategories archived or
not, someone else's).

## Home at a glance

**What it is.** The first screen (no address, or `?month=2026-10` for an earlier month):
where the month will land, what was spent and what came in, what needs you, a day-by-day
calendar and the budgets. The full lists live in Activity, Plan and Accounts.

- The month's name between arrows ("Previous month"; "Next month" off on this month), the
  freshness label under it and the round initial on phones and tablets; on a computer
  "November 2026" and a search box, "Search everything" (/ puts the cursor there, Enter
  opens `?activity&q=<words>`). The initial and the theme switch come once the accounts are
  known (it may be the first run, which has its own) or couldn't be loaded ("Couldn't load
  your accounts.", Try again), so Settings and Sign out are always a tap away.
- "Expected at month end": the month-end sum (Repeating bills and month end) with its line,
  "RM 8,157.00 today − RM 189.00 bills + RM 6,800.00 pay", the bills part in the negative
  colour and the pay part in the positive one, each only when something is due; with the
  one account and nothing due, "Maybank Savings today". Below zero it reads "−RM 120.00".
- "Expenses so far" ("None yet", or "Day 10 of 30", with " · Food running fast" for the
  budget furthest ahead of the month) and "Income" ("Salary due Nov 25", the listed income
  item next due, or "No pay scheduled"). On a computer the three sit across the top, in a
  region "November at a glance".
- What's due now, to log or skip (Repeating bills and month end).
- Tidy up, on the due tint, this month only and only when there are any: "2 entries since
  Oct 1, still in Other" (Other's own name), with Sort them opening
  `?activity&category=<OTHER_EXPENSE_ID>&from=<tidyUp.from>&select`.
- Coming up: each listed repeating item's next day after today (one row per item, soonest
  first, at most 3), "TNB electricity · RM 189.00" / "Nov 20 · Maybank Savings", income
  "+RM 6,800.00", a transfer unsigned with "Maybank Savings to Cash"; "All scheduled" opens
  `?plan=scheduled`. It can say "amount to check" for a row and "Added this month: Rent,
  Netflix" under the list (ComingUp's `toCheck` and `added`), which Scheduled fills in;
  Home passes neither yet.
- "Day by day": the month's days in weeks from the Week starts on setting (Monday unless
  set), each a link to `?activity&day=<day>` named as it reads ("November 10, spent RM
  9.00, more than the middle day, TNB electricity due"), against "middle day RM 1.50"
  (`dayByDay`): above it an amber up arrow, at or below it a green down arrow, days to come
  grey, today ringed (`aria-current="date"`), a dot on a day with a bill (amber) or pay
  (green) still to come. Nothing spent this month: "Fills in as you log."
- "Budgets": each budget with "RM 36.00 left" (on a computer "36.00 left"), a bar with a
  marker for how much of the month has gone, and "RM 24.00 of RM 60.00 · faster than the
  month" (on track, faster than the month, or over; amber with a warning icon when faster,
  the negative colour when over). "All of Plan" opens Plan. None: "No budgets yet." with
  "Set a budget" (`?settings=categories`, where budgets are set).
- Getting started, this month while any of its five steps is left and it isn't hidden:
  where the money is (always done), the first expense (spending this month), past months
  (anything last month), rent, bills and pay (a repeating item), a budget (one this month);
  "2 of 5 done", each step left a tap from where it's done (Add opens Add). Hide puts it
  away on this device for the signed-in account (local storage; without it, until the app
  is opened again); it's decided only once who's signed in is known, and never kept
  without an account.
- An earlier month: "Left in October" (received less spent) for the month end, the cards
  without their lines, every day with no dots or ring, budgets without the marker but with
  their words; no Tidy up, Coming up or Getting started.
- With no account: the first run, in place of everything (no tab bar or sidebar): "Where
  do you keep your money?", Bank, E-wallet, Card and Cash, each opening Add account with
  that kind chosen, and how many categories it comes with, worked out from the defaults.

Until their own pages land, Home also keeps the theme switch and the install card.

**Owner.** No state of its own: it reads the ledger (`useWholeLedger`, `useAccounts`), this
month's and last month's totals (`useMonthSummary`) and the person's settings
(`useProfile`), all owned as in Month view, Budgets and Repeating bills; every change it
offers goes through those owners (Add, Log it and Skip). Getting started's Hide is the only
thing it keeps, per device.

**Parts.**

- UI: [components/home/HomePage.tsx](../web/src/components/home/HomePage.tsx) (the layout,
  the answers, Tidy up), [DayByDay.tsx](../web/src/components/home/DayByDay.tsx),
  [HomeBudgets.tsx](../web/src/components/home/HomeBudgets.tsx),
  [ComingUp.tsx](../web/src/components/home/ComingUp.tsx),
  [GettingStarted.tsx](../web/src/components/home/GettingStarted.tsx) with
  [getting-started.ts](../web/src/components/home/getting-started.ts),
  [FirstRun.tsx](../web/src/components/home/FirstRun.tsx),
  [PageLink.tsx](../web/src/components/home/PageLink.tsx) (links to places replace Home in
  history, to Settings push), the words in
  [home-text.ts](../web/src/components/home/home-text.ts); the budget bar is
  [ui/Bar.tsx](../web/src/components/ui/Bar.tsx) (`today` null draws no marker).
- Ledger: `monthEndForecast` (with `billsCents` and `payCents`), `comingUp` and `nextPay` in
  [ledger/forecast.ts](../web/src/ledger/forecast.ts); `budgetLines`; `dayByDay`.
- Shared: `periodDay` and `budgetPace` in [shared/budgets.ts](../shared/budgets.ts);
  `monthEnd` in [shared/recurring.ts](../shared/recurring.ts).

**Invariants.**

- Today is the person's own day (`toDateInput(new Date())`), never UTC's.
- The three answers show together, once the balances and the month's totals are in, with
  placeholders until then; when the totals can't be had (the server failing, no copy on the
  device), the month end shows alone with "Couldn't load this month." and Try again.
- Money is whole cents: the month-end parts are sums of whole-cent amounts (bounded as in
  Repeating bills and month end); "running fast" compares exact whole numbers.
- Coming up and the calendar list only listed items on listed accounts, as the month-end
  sum counts them; transfers are in Coming up but never in the sum or the dots.

**Tests.** [Home.test.tsx](../web/src/components/home/Home.test.tsx) (each part, in Kuala
Lumpur just after midnight so a UTC day would be wrong: the sum and its line, the arrows,
the cards, Tidy up's address, the calendar with Monday and Sunday weeks and Activity a tap
away, the budgets, Coming up stopping at three, a transfer, the search, an earlier month,
the first day with Getting started, each step, Hide across a reload, the first run adding
an account of the kind picked, Hide with a slow profile and per account, the initial when
the accounts fail, what's due on Home this month only; desktop and phone),
[getting-started.test.ts](../web/src/components/home/getting-started.test.ts) (Hide kept
per account, never without one),
[home-text.test.ts](../web/src/components/home/home-text.test.ts) (the words, "running
fast" exact and its tie-break, day names, weeks),
[ComingUp.test.tsx](../web/src/components/home/ComingUp.test.tsx) (rows, amounts to check,
added this month), and [forecast.test.ts](../web/src/ledger/forecast.test.ts) (bills and pay,
coming up).

## Budgets

**What it is.** An optional monthly amount on a top-level spending category, its
subcategories counting toward it. Set, changed or taken away (amount emptied) from the
category's own sheet, opened from its row on the Categories page ("Monthly budget", and a
"Carry over" switch, off to start); the row then says "RM 300.00 a month". The amount
applies from this month on, the same every month until changed; earlier months keep what
they had. Home lists each budgeted category with what's left and how it goes against the
month (see Home at a glance). Plan's month card lists each budgeted category, in the categories' order,
as "RM 120.00 left of RM 300.00", or "RM 40.00 over" in the negative colour, with a bar
for what's spent. With Carry over on, last month's leftover is added to this month's
amount, or what it overspent taken away, shown as "incl. RM 30.00 carried over" ("incl.
−RM 20.00 carried over"), and the "of" figure includes it.

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts): `setBudget` goes through
`change()` and the outbox like every change, so it shows at once, works offline and is put
back if refused. Budgets ride in a month's totals (`MonthSummary.budgets`), so they're
kept, counted once and refreshed exactly as the totals are (see Month view).
[ledger/summary.ts](../web/src/ledger/summary.ts) shows a `setBudget` in the months it
applies to; [ledger/budgets.ts](../web/src/ledger/budgets.ts) (`budgetLines`) works out
what's left from the spending as shown, subcategories rolled up by the categories as they
are now. The sum itself (`budgetFigures`) and the month-to-month chain (`monthBudgets`) are
[shared/budgets.ts](../shared/budgets.ts), used by the Worker, the app and the test
stand-in alike.

**Parts.**

- UI: the "Budgets" list in
  [components/home/MonthCard.tsx](../web/src/components/home/MonthCard.tsx); the fields in
  [components/categories/CategoryForm.tsx](../web/src/components/categories/CategoryForm.tsx)
  and the row's amount in
  [CategoriesPage.tsx](../web/src/components/categories/CategoriesPage.tsx) (both read
  this month's totals); `readBudget` in
  [category-text.ts](../web/src/components/categories/category-text.ts).
- API: `setBudget` in [worker/ledger/changes.ts](../worker/ledger/changes.ts); the budgets
  of `GET /api/summary` in [worker/ledger/summary.ts](../worker/ledger/summary.ts); table
  `budgets` ([migrations/0005_budgets.sql](../migrations/0005_budgets.sql)).
- Shared: `MonthBudget` and the change shape in [shared/api.ts](../shared/api.ts); the
  rule, limits and sums in [shared/budgets.ts](../shared/budgets.ts), with a budget's pace
  against the month (`budgetPace`, `periodDay`; see Month view).

**Flow.** `setBudget { categoryId, fromMonth, amountCents | null, carryOver }` saves a row
for that category and month (null: none from then on, kept as its own row so earlier
months keep theirs) and removes the category's rows for later months. The app always
sends this month. A month's totals read the person's budget rows up to that month on
categories at the top level now and, when there are any, their spending by month and
top-level category before it, from the first budget on, in the same D1 batch as the
totals; `monthBudgets` walks month by month from the first budget, each month's leftover
(amount, plus what it carried, less its spending) going into the next while Carry over is
on. The answer gives each budget's amount, Carry over and what last month left
(`lastMonthLeftCents`); the app works out carried (`carryOver ? lastMonthLeft : 0`),
available (amount + carried) and left (available less this month's spending) with the same
`budgetFigures`. A budget set shows at once in the months it applies to, keeping what last
month left; a change to an earlier month's spending moves this month's carried figure
only when the totals are next fetched, once nothing is left to send (as other months'
totals do), which is expected, not a fault.

**Invariants.**

- Only on a top-level spending category of the person's: someone else's or a missing one
  is 404; a subcategory, an income category, or setting (not taking away) one on an
  archived category is 409. The database's trigger holds owner, top level and spending
  too, not archived, so a budget can be taken away from an archived category.
- A budgeted category moved under another keeps its rows but its budget is set aside (not
  listed, its spending counting toward its new parent) until it's back at the top level;
  while it's a subcategory its budget can't be set or taken away. One on an archived
  category isn't shown.
- An amount is whole cents from 1 to `MAX_BUDGET_CENTS`; a month from 2000 up to this one
  (by tomorrow in UTC). A month after that (still to come) is answered with no budgets,
  and its budgets and their spending aren't read, so a chain runs from the first budget
  (January 2000 at the earliest) to this month at most: about 330 months in 2027, each
  step at most `MAX_BUDGET_CENTS` (309 months at the largest budget to October 2025 is
  3.09e11 cents), and spending is bounded as in Month view. Every figure is exact. The
  spending read is one grouped query scoped by the email, run only for a person with
  budgets, at most one row per month and category up to this month.
- Setting the same budget again comes out the same, on the server (a receipt) and on
  screen, and spending in the month moves what's left once (`alreadySaved`, as for the
  totals).

**Tests.** [shared/budgets.test.ts](../shared/budgets.test.ts) (the sum, the chain, taken
away, order, the longest chain exact; day N of M and the pace, on track, faster and over,
in other periods and two time zones),
[ledger/budgets.test.ts](../web/src/ledger/budgets.test.ts) (left, over, exactly spent,
carried both ways, order, archived and moved, set before saving, applied twice),
[Budgets.test.tsx](../web/src/components/home/Budgets.test.tsx) (the card's lines, over in
words and colour, carry over, earlier months, setting, changing and taking away from the
sheet, what can't be typed, a refusal put back, saving the sheet leaving it alone, offline,
a lost answer never counted twice; desktop and phone), and the budgets cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (until changed, the chain, taken
away, order and moved categories, bounds, every refusal, sent again, the database's own
guard).

## Search and changing many

**What it is.** Activity (`?activity`, one of the places; the old `?search` still opens
it) is the one list of every entry, this month's on every account unless its filters say
otherwise, newest first, 200 at a time with Load more. Typing finds the words anywhere in
the payee, the note, the category's name or its parent's (so "food" finds Food › Coffee),
ignoring the case of A to Z; words that read as an amount ("8", "8.50", "1,000") also find
that exact amount, and text containing them ("8" finds RM 8.00, and a note "8 refund", but
not RM 8.50 or RM 80). Four chips narrow it: the account (transfers into it too), the
category (a top-level one with its subcategories), the days (This month, Last month, All
months, or From and To, both included) and the kind (All kinds, Expenses, Income,
Transfers, Expenses and income). "12 found · RM 43.18 spent" (and "· RM x received"
when income is found) counts everything found, loaded or not. Amounts say which way:
spending "−8.50" in ink, income "+50.00" green, a transfer "100.00" grey with no sign.

On phones and tablets the list is grouped by day, each day with its total (received less
spent; none for a day of transfers alone); tapping one opens it in a sheet to change or
delete. Select, or a long press on a row (half a second; the release isn't a tap), starts
selecting (`&select`, with no tab bar): rows have tick boxes, "Select all N" ticks
everything found (loading every page, stopping past 500), and the foot says what's ticked
("3 entries · RM 30.90 · all Kedai") with Delete N and Change category. On a computer
it's a register (Date, Payee and note, Category, Account, Amount), every row with a tick
box, and the open row (the first until another is picked) is changed beside it; J and K
move the open row, X ticks it, C changes the category of what's ticked (or of the open
row), and a row's category opens Change category for it alone. Esc closes the top dialog;
with a row always open, there's no pane to close.

Change category lists the kind's categories (each top-level one with its subcategories,
searchable), says what moves ("RM 30.90 from Other to Food") and what it does to that
category's budget this month ("Food budget: RM 312.50 → RM 291.75 left", "Groceries has no
budget"), then "Move 3 to Food". Only the entries dated in the budget month Home shows (the
calendar month until a month start day is set) move the budget, and none already in it:
a budget is a month's, so an October entry moved to Food changes October's Food, not the
one shown. Spending or income
alone, no transfers. Delete N takes them out at once, with Undo. More than 500 ticked is
refused with a message. With nothing yet it says "No transactions yet" with Log your first
one and Import a bank's CSV; with nothing found, 'No "bolt" in Transport this month. 2 in
other months.' with Clear filters (the chips, not the words or the days) and Search all
months. Offline with nothing loaded: "Connect to search" (results aren't kept on the
device). Catching up is this page alone (Tidy up links to Other since a day, selecting);
there is no review queue.

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts): a search's results are a list
of transactions like an account's, keyed by the search (`searchTransactionsKey`), so a
change shows in them at once, a page fetched while a batch was saved gets it on top, and
they're fetched again once nothing is left to send. Whether a changed transaction still
belongs in them is asked of `matchesSearch` with the categories shown. Screens read them
through `useSearch(query)` in [ledger/useLedger.ts](../web/src/ledger/useLedger.ts), which
also loads the rest for Select all (`loadAll`) and works out the figures
([ledger/search-totals.ts](../web/src/ledger/search-totals.ts)): the rows as shown (changes
still to send included) plus what the server says matches beyond the last page loaded
(`rest`, and `restOfLastDay` for that page's last day), so nothing is counted twice and no
`alreadySaved` is needed. An add still to send that falls beyond the last row loaded,
while more are to come, isn't shown (`applyToPages`), and counts once the server holds it.
Edits made elsewhere to entries beyond the last row loaded show once the list is fetched
again. A change to many is one `change()`: `recategoriseTransactions` { ids, categoryId }
or `removeTransactions` { ids }, so it's one request, saved all or nothing, kept in the
outbox offline and counted once by its id. [ledger/apply.ts](../web/src/ledger/apply.ts)
(`oneByOne`) makes it into the same change to each transaction in turn, so balances, lists
and months' totals ([summary.ts](../web/src/ledger/summary.ts)) move at once by what each
was, and a copy that holds it already (`alreadySaved`) doesn't count it again. Undo of a
move is one `recategoriseTransactions` per category they came from; Undo of a delete adds
each again with its own id (`addTransaction`), which the outbox may send in several
requests. The filters live in the address
([components/activity/address.ts](../web/src/components/activity/address.ts)), not in state.

**Parts.**

- UI: [components/activity/ActivityPage.tsx](../web/src/components/activity/ActivityPage.tsx)
  (the page, the day list, the register, selecting and the long press, the keys),
  [Filters.tsx](../web/src/components/activity/Filters.tsx) (the chips and their lists),
  [ChangeCategory.tsx](../web/src/components/activity/ChangeCategory.tsx),
  [EntryEditor.tsx](../web/src/components/activity/EntryEditor.tsx) (one entry, in the pane
  or the phone's sheet: amount, which way, category or To, account, day, payee, note;
  Delete with Undo), [activity-text.ts](../web/src/components/activity/activity-text.ts)
  (the words and signs) and [address.ts](../web/src/components/activity/address.ts).
  "Log your first one" opens the shell's new entry
  ([shell/add-entry.ts](../web/src/components/shell/add-entry.ts)).
- API: `GET /api/search?q=&account=&category=&from=&to=&kind=&before=&limit=`
  (`searchTransactions` in [worker/ledger/read.ts](../worker/ledger/read.ts): `instr(lower(...))`
  on the payee, note and both category names (no pattern, so no length limit and no
  wildcards), or the amount, paged by the same cursor as `/api/transactions`). Every page
  answers `rest` and `restOfLastDay` (one aggregate, only when there's more); the first page
  of a search for days answers `elsewhere`, how many match outside them (one aggregate).
  Each is built from the same conditions as the page, email first.
  `recategoriseTransactions` and `removeTransactions` in
  [worker/ledger/changes.ts](../worker/ledger/changes.ts) (`readBulk`), each one UPDATE or
  DELETE over the ids.
- Shared: [shared/search.ts](../shared/search.ts) (`readSearch`, `matchesSearch`,
  `searchAmount`, `MAX_SEARCH_TEXT`, the kind filter), which the Worker's SQL mirrors and
  the test stand-in uses; `SearchPage` and `SearchTotals` and the change shapes in
  [shared/api.ts](../shared/api.ts); `MAX_BULK_TRANSACTIONS` in
  [shared/ledger.ts](../shared/ledger.ts).

**Invariants.**

- Only the signed-in person's transactions are found and counted; someone else's account
  or category as a filter is answered as one that doesn't exist (404). Words are at most
  `MAX_SEARCH_TEXT` characters; days are real calendar days; kinds are known and each named
  once (400 "Give kinds from expense, income and transfer").
- Every figure is exact and bounded: one aggregate row per page, sums under 5e15 cents by
  `MAX_ACCOUNTS` x `MAX_TRANSACTIONS_PER_ACCOUNT` x `MAX_TRANSACTION_CENTS`.
- A change to many names 1 to `MAX_BULK_TRANSACTIONS` (500) transactions, each once,
  every one the person's (else 404), and is saved all or nothing with the rest of its
  batch. A move's category is the person's, listed, and of every transaction's kind
  (409); a transfer is never given one (400). The app refuses more than 500 before
  making the change; the Worker is the authority.
- 500 ids are about 9 KB, inside one request (`MAX_CHANGES_BYTES`).

**Tests.** [Activity.test.tsx](../web/src/components/activity/Activity.test.tsx) (the page
on a phone, a tablet and a computer, figures counting what isn't loaded, an add beyond
what's loaded counted once, years, each filter and the words, the addresses other pages
link to, stale and bad addresses, nothing yet, nothing found, a failure, offline, changing
and deleting one), [ChangingMany.test.tsx](../web/src/components/activity/ChangingMany.test.tsx)
(ticking, the move sheet and its budget effect, from several categories, refusals, delete
at once with Undo, Undo's few seconds, 501 refused and 500 in one change, the long press,
Tidy up's flow on one page, offline, counted once when the answer is lost),
[ActivityKeys.test.tsx](../web/src/components/activity/ActivityKeys.test.tsx),
[activity-text.test.ts](../web/src/components/activity/activity-text.test.ts),
[amount-colours.test.tsx](../web/src/components/activity/amount-colours.test.tsx),
[search-totals.test.ts](../web/src/ledger/search-totals.test.ts),
[shared/search.test.ts](../shared/search.test.ts),
[search-stand-in.test.tsx](../web/src/testing/search-stand-in.test.tsx),
[apply.test.ts](../web/src/ledger/apply.test.ts) (balances, lists and months' totals for
both changes), and the searching and changing-many cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (every match and filter and kind,
paging with ties, the rest and the rest of a day under every filter, elsewhere, someone
else's never counted, refusals with their messages, a resend counted once, 500 at once).

## Repeating bills and month end

**What it is.** Bills and income that repeat, monthly on a day of the month (on a shorter
month's last day past its end) or weekly on a weekday. Set one up with Repeat (Monthly or
Weekly) in Add, or under More on a transaction's own sheet when changing it: it repeats on that
transaction's day of the month or weekday, and its first due date is the next one after
the person's own today, so one set up from an old transaction never has the occurrences
since due (they're taken as handled); one already set up keeps asking about each it missed,
as those may be real unpaid bills. Each one due (its next due date today or before, the person's own
day) is on Home under the two cards, and at the top of Plan until Scheduled is built, "Due: Rent RM 1,200.00 from Maybank" (income "into Maybank",
a transfer "from Maybank to Visa"; with no payee, its category's name), with Log it, which
records it as a transaction on the day it was due and moves it on to its next date, and
Skip, which moves it on recording nothing; each has Undo. Nothing is recorded until one is
tapped, so balances never show money that didn't move. Plan shows
one total while anything repeats, "Expected at month end: RM 2,340.00" (Home's month-end
figure is the same sum; see Home at a glance): today's balances of every listed account
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
  [recurring-text.ts](../web/src/components/home/recurring-text.ts), what's due on
  [HomePage.tsx](../web/src/components/home/HomePage.tsx) and, with the month-end total, on
  [PlanPage.tsx](../web/src/components/plan/PlanPage.tsx); Repeat in [AddEntry.tsx](../web/src/components/entry/AddEntry.tsx) and
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
- Its first due date comes with it from the app (`nextDue`: the next after the person's own
  today, or an imported one's) and is checked as a moved one is, on its schedule and within a
  year, but never against today, so a change sent days later from an offline device still
  applies. Without it (an app from before) it's the next after its start.
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
old one (first due after today, monthly and weekly, a day that falls today, shown at once,
set up offline, by the person's own day in Kuala Lumpur and Los Angeles), one set up before
still asking about each it missed, changing and stopping, a refusal put back, a double tap, offline, the person's own
day in Kuala Lumpur; desktop and phone), and the repeating cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (setting up, with its first due date
given or not and each refusal of one, each schedule, logging and skipping once, refusals with their messages, someone else's, all or nothing, the limit).

## Export

**What it is.** Taking everything out, so leaving the app never means leaving part of
the history behind. Export, on Home under Categories, opens a dialog that says what the
file holds before it's downloaded ("1,284 transactions from 3 Jan 2026 to 5 Nov 2026, 6
accounts, 23 categories", counted by the server), and Download saves it as
`mahnee-2026-11-05.csv`: first each account's opening balance (Kind "Opening balance",
dated the day the account was added, in UTC, signed, so what's owed on a card is
negative), in the person's order, then each bill or income still repeating, in the order
set up, then every transaction, oldest first, one line each. Columns: Date, Kind (Opening
balance, Spent, Received, Transfer, Repeating spent, Repeating received, Repeating
transfer), Account, To account, Amount, Currency, Category, Parent category, Payee, Note, Id
(the account's id on an opening line, the item's on a repeating one). A repeating line is
dated its next due date, its amount unsigned like a transaction's, and its Note says how
often it falls ("Monthly, day 15", or "Weekly, day 3" with Monday as 1); stopped ones are
left out. Every balance can be worked out again from the file, and importing it sets the
repeating items up again. The dialog's counts are of transactions, accounts and categories. Archived accounts
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

- UI: [ExportDialog.tsx](../web/src/components/home/ExportDialog.tsx), opened from Settings ›
  Import and export ([components/settings/DataPage.tsx](../web/src/components/settings/DataPage.tsx));
  [utils/deliver-file.ts](../web/src/utils/deliver-file.ts) saves the file (or shares it);
  `dayText` in [utils/date-input.ts](../web/src/utils/date-input.ts).
- API: `GET /api/export` (`exportTransactions`) and `GET /api/export/summary`
  (`readExportSummary`) in [worker/ledger/export.ts](../worker/ledger/export.ts).
- Shared: `ExportSummary` in [shared/api.ts](../shared/api.ts); the columns, kinds,
  amounts, quoting and file name in [shared/export.ts](../shared/export.ts), which the
  Worker and the test stand-in both write lines with.

**Flow.** The Worker reads the person's accounts and category names, answers at once
with the header line, the opening balances and the repeating items still running (read
with the names, at most `MAX_RECURRING`), then reads transactions `EXPORT_PAGE_SIZE` at a time, oldest first
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
- Bounded by `MAX_ACCOUNTS` x `MAX_TRANSACTIONS_PER_ACCOUNT` rows, and at most
  `MAX_RECURRING` repeating lines. A very long history
  is still subject to the Worker's per-request limits (CPU time, and D1 queries per
  request: one per `EXPORT_PAGE_SIZE` transactions).

**Tests.** The export cases in [worker/test/api.test.ts](../worker/test/api.test.ts)
(the exact file: opening balances, a card's negative one and an account with no
transactions among them, then spending, income, a transfer, a subcategory, a renamed and
an archived account, quoting, the formula guard, another person left out; the repeating
items still running, in the order set up, at most 200; the header alone
for someone with nothing; paging past 2,000 rows on one day and time; the counts and
days), [shared/export.test.ts](../shared/export.test.ts) (a negative amount stays a
number while text starting with "-" is guarded; the UTC day; repeating lines, stopped ones
left out, read back as written), and [Export.test.tsx](../web/src/components/home/Export.test.tsx) (counts and
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
unticked, and changes only if ticked. Its repeating lines set those items up again, on an
account the person has or the file adds (any other is said on its row), their categories
found or added as a transaction's, first due on the file's next due date or, when that has
passed, the next one after the person's own today; set up that day. One with the same
account, kind, amount, schedule, day and payee (trimmed, ignoring case) as one still running
looks already saved and is left unticked, each running one answering for one line; stopped
ones never count, and the category and where a transfer goes aren't compared. Past 200
items, stopped ones included, a line says so. The Import button then says how many of each
("Import 2 transactions and 2 repeating items"). Export then import into a fresh account, then
export again, gives the same file but for ids and the days accounts were added. A file of
more than `MAX_IMPORT_ROWS` (5,000) rows is refused before the preview; the preview shows
100 rows at a time. After a bank file the account's page opens; after an export, Home.

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts): Import makes every change
with `change()` (accounts, opening balances, categories, transactions in the file's
order, then repeating items, each `addRecurring` with its first due date), so it shows at once, works offline and goes through the outbox in batches of
`MAX_CHANGES` / `MAX_CHANGES_BYTES` (5,000 rows is about 27 requests, sent one at a time;
a 429 is kept and tried again), each change counted once by its id. `transactionsSince`
there reads an account's transactions back to the file's first day (200 a page), with
what was saved meanwhile and the changes still to send on top; offline, the pages this
device has and the changes still to send. `loadedLedger` there waits for the accounts and
categories when an export is picked before they've loaded. What the page works out before
saving is its own: [components/import/import-plan.ts](../web/src/components/import/import-plan.ts)
(`planBankFile`, `planExport`, `markSaved`, `importChanges`), and
[remembered-mapping.ts](../web/src/components/import/remembered-mapping.ts) keeps the
column names per email and account (`localStorage`, let go on signing out).

**Parts.**

- UI: [components/import/ImportPage.tsx](../web/src/components/import/ImportPage.tsx)
  (`?import`, going back up to Settings › Import and export), and its row on
  [components/settings/DataPage.tsx](../web/src/components/settings/DataPage.tsx).
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
- The database has a place for each import (`imports`, and `transactions.import_id`;
  docs/erd.md) for recent imports and Undo on every device, which nothing writes yet. An
  import is recorded before its transactions name it (a trigger refuses an import that
  isn't the person's own), and letting one go keeps its transactions.

**Tests.** [shared/csv-import.test.ts](../shared/csv-import.test.ts) (cells, days,
amounts, bank rows and what's wrong with them, export lines read back as written,
repeating lines and what's wrong with them, the duplicate rule, the limit), [Import.test.tsx](../web/src/components/import/Import.test.tsx)
(mapping and remembering it, money in and out, already saved and ticked anyway, the
same file twice, categories from payees, shortened text, 5,001 refused, 5,000 on a phone
with a lost answer counted once, offline, the export round trip, opening balances, an
export picked before the accounts load; repeating items: the round trip, a next due kept
or moved on by the person's own day, what counts as already there, two alike, what each
names, the limit of 200, a line it can't read; desktop and phone), and the payee categories cases in
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
showing what this device last loaded with the changes made since on top. How fresh the
figures are is always said, by a freshness label: "Up to date" (a green dot) once the
server has confirmed them and nothing waits; "From this device, 3 h old" (amber) while the
balances or the month come from that copy (offline, or the server hasn't answered yet);
"Offline · 2 changes waiting to save" while changes wait without a connection. This
replaces the old rule that fresh from the server it said nothing (the redesign's
"Freshness, always labelled"). The design doesn't draw these, so they're the run's
defaults: "Offline" (offline, nothing waiting, figures fetched earlier), "Saving 2
changes" (online, the server answering, changes on their way), "Signed out · 2 changes
waiting to save", and "From this device" alone when the copy's time isn't known. Ages read
"less than a minute", "5 min", "3 h", "2 d", rounded down, and keep counting while shown.
The label sits under Home's title on phones and tablets, beside "Mahnee" in a computer's
sidebar, and at the foot of Settings ("Mahnee · Up to date"); on a phone's or tablet's
other pages, and at the foot of Settings' own pages there, it shows only when it isn't
"Up to date", so changes waiting are never out of sight (Settings' own pages show it always
on a computer, as the settings boards draw). It judges the balances and Home's open month,
or this month off Home; nothing shows until the balances first load, and Home keeps its
line meanwhile. Changes made offline are kept on the device and saved once the connection
is back, even with the app closed. The offline notice says so on the due tint ("Offline.
Your changes are kept on this phone.", "this device" from 768px, "this computer" from
1024px, by width as the layout goes; the tablet word is the run's); how many wait is the
label's to say. It offers Sign in when the session ran out, and warns when the device can't
keep changes, those two with how many are waiting.

**Owner.**

- [offline/cache.ts](../web/src/offline/cache.ts): device copies tagged with the
  signed-in account and the time each was kept (`readCacheEntry`), and the marks the
  service worker and sign-in leave on the page.
- [ledger/ledger.ts](../web/src/ledger/ledger.ts): which of the ledger and months'
  totals are shown from the device copy, and when the server last confirmed each
  (`dataAge`, read through `useDataAge` and shown by
  [components/common/Freshness.tsx](../web/src/components/common/Freshness.tsx), whose
  words come from [freshness-text.ts](../web/src/components/common/freshness-text.ts)
  with the outbox's count, `useUnsaved`); a fresh
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
  ([components/common/useConfirmSignOut.tsx](../web/src/components/common/useConfirmSignOut.tsx)).
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
[Freshness.test.tsx](../web/src/components/common/Freshness.test.tsx) (every label where
it's drawn at each size, ages, which label wins, the offline notice's words, and the undo
toast: announced, Undo its only button, gone after 6 seconds; refusals keep their close
button), [freshness-text.test.ts](../web/src/components/common/freshness-text.test.ts)
(age edges and the order of the labels),
[first-read.test.tsx](../web/src/offline/first-read.test.tsx) (the first read of the
balances goes while the server is slow to say who's signed in, and never waits for good
when signed out),
[storage.test.ts](../web/src/offline/storage.test.ts),
[launch-screen.test.ts](../web/src/pwa/launch-screen.test.ts) and
[web/build/precache.test.ts](../web/build/precache.test.ts).

## Pages, layouts and Back

**What it is.** Which page shows, the layouts for phones, tablets and computers, and
what Back does. Four places are always a tap away: Home, Activity, Plan and Accounts, in
a tab bar at the bottom on phones and tablets (with Add in the middle) and in a sidebar
on computers (with Mahnee, New entry and, at its foot, Settings). Moving between places
takes the page's place in history, so Back never walks through them. An account's page
keeps the places, with Accounts marked; Settings, its sections and Import cover them,
and so does the first run, before there is an account, and a phone or tablet selecting on
Activity (`&select`), which then has no freshness strip either: its own bar is at the foot. For now Plan is the month as Home showed it before
it was at a glance (what's due now, the month card, the month-end total and the accounts),
until Plan and Scheduled are rebuilt, and Accounts is the list of accounts. Home is at a
glance (see Home at a glance).

**Addresses.** Later pieces link to these; each is a query string read by `readRoute`.

| Page                      | Address                                                                                                                    | Now                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Home                      | none, or `?month=2026-10` for an earlier month                                                                             | live                                                               |
| Activity                  | `?activity`, with `&q=`, `&account=`, `&category=`, `&kind=`, `&from=`, `&to=`, `&day=2026-11-10`, `&dates=all`, `&select` | live; see below                                                    |
| Plan                      | `?plan`, with `&month=2026-10`                                                                                             | live                                                               |
| Scheduled                 | `?plan=scheduled`                                                                                                          | opens Plan                                                         |
| A category over 12 months | `?plan&category=<id>`                                                                                                      | opens Plan                                                         |
| Accounts                  | `?accounts`                                                                                                                | live                                                               |
| One account               | `?account=<id>`                                                                                                            | live                                                               |
| Settings                  | `?settings`, and `?settings=account`, `money`, `adding`, `look`, `budgets`, `categories`, `data`                           | the index, `categories` and `data` live; the others open the index |
| Importing a file          | `?import`                                                                                                                  | live, opened from `?settings=data`                                 |

Activity's filters (components/activity/address.ts): plain `?activity` is this month on
every account. `&q=` is the words; `&account=` an account (transfers into it too);
`&category=` a category (a top-level one with its subcategories); `&kind=` one of
`expense`, `income`, `transfer`, or two joined by a comma (`expense,income` is "Expenses and
income"); `&day=` one day (Home's calendar: `?activity&day=2026-11-10`); `&from=` and
`&to=` days, both included, either alone ("Since Oct 1"); `&dates=all` every month; and
`&select` opens a phone or tablet selecting (Tidy up:
`?activity&category=<OTHER_EXPENSE_ID>&from=<tidyUp.from>&select`). A day wins over from
and to, and those over all months. A part that makes no sense (a day that isn't one, a
kind not known, an account or category the person doesn't have) is dropped, and the
address is put right in place; each filter is written back in that order, only when not
at its default. `select` is never reopened on a fresh start.

A page named first wins over the parameters after it: `?activity&account=<id>` is
Activity, and `account` is its filter. Older addresses are replaced in place, keeping the
rest of the address: `?search` becomes `?activity`, `?categories` becomes
`?settings=categories`. So `search` and `categories` are reserved: no page or parameter
may use either name for anything else (Activity's filters included).

**Owner.**

- [hooks/useRoute.ts](../web/src/hooks/useRoute.ts): pages come from the query string
  through `navigate()` (`{ replace: true }` for the places), and the last page reopens on a
  fresh start (on this month: a month in the address is never reopened, `TRANSIENT`). A
  page opened from another goes back up with `goUp`: Back when it came from there, else
  straight there in its own place. `closeSettings` goes back to the page Settings was
  opened over, or Home. Each page the app gains adds its view to `Route`, and `placeOf`
  says which place it belongs to.
- [hooks/useShortcuts.ts](../web/src/hooks/useShortcuts.ts): keys on a keyboard. N opens a
  new entry and / puts the cursor in the page's search, or opens Activity's (on pages with
  the places); Esc closes Settings, and goes up from its sections; on a computer, Activity
  adds J, K, X and C. None fires while typing in a field (but Esc), with Ctrl, Cmd or Alt
  held, or while a dialog is open; Esc does nothing on Import, so a file being looked over
  is kept. Typing is a text-like field (text, search, number, a day or time, email, phone,
  address, password), a longer text, a list to pick from or editable text; a tick box, a
  choice of several (radio) or a button lets the keys through. (For piece 7: a full-screen
  Add on a phone with radios for From/For or Which way and no `role="dialog"` would let N
  and / through from a focused radio; it should be a dialog, or say so.)
- [hooks/useBreakpoints.ts](../web/src/hooks/useBreakpoints.ts): `useIsMobile` (under
  768px) and `useIsDesktop` (1024px and up).
- [hooks/useBackDismiss.ts](../web/src/hooks/useBackDismiss.ts): Back closes the top
  sheet on phones.

**Parts.**

- [components/shell/AppLayout.tsx](../web/src/components/shell/AppLayout.tsx): the page in
  its one `main` region, the places around it
  ([TabBar.tsx](../web/src/components/shell/TabBar.tsx),
  [Sidebar.tsx](../web/src/components/shell/Sidebar.tsx), the list in
  [places.ts](../web/src/components/shell/places.ts)), Add, and
  the offline and new-version notices over it. While the tab bar shows, `--tabbar-h` is its
  height (0 otherwise), which the page's end, the notices and the undo messages keep clear
  of.
- [ResponsiveDialog](../web/src/components/ui/ResponsiveDialog.tsx): a sheet on phones,
  a dialog elsewhere.
- [Skeleton](../web/src/components/ui/Skeleton.tsx): the shimmering placeholders a page
  shows until its data arrives.
- The look, "Paper ledger": the colours, light and dark, under the design's own names
  (`--ground`, `--ink-3`, `--accent`, ...) in [theme/tokens.css](../web/src/theme/tokens.css),
  dark under Mantine's colour scheme; Geist and Geist Mono from Google Fonts; Mantine's
  buttons, fields, segmented controls and sheets restyled there and in
  [theme/theme.ts](../web/src/theme/theme.ts). The parts screens are built from are in
  `components/ui/`: `Chip`, `Bar` (a budget bar with a today marker), `Badge`, `CountBadge`
  and `NewTag`, `Tile`, `ListRow` and `IconButton`. The first screen and the iPhone launch
  images use the same grounds ([web/build/launch-images.ts](../web/build/launch-images.ts),
  `index.html`).

**Invariants.**

- Sheets and dialogs never push history entries themselves; they open through
  `ResponsiveDialog` or `useBackDismiss`, so Back closes the top one first.
- Moving between places replaces the page in history; only sub-pages (an account,
  Settings and its sections, Import) push, and go back up with `goUp` or
  `closeSettings`.
- One Add: the tab bar's or the sidebar's, shown once the accounts are known, unusable
  while every account is archived; on a running account's page it opens on that account.
  (The archived account's page used to offer no Add; it keeps the shell's now.)
- Until a page's data arrives it shows placeholders the size of what will replace them,
  never an empty or zero state that then changes.
- Every CSS variable the app uses is defined (in `tokens.css`, the app's own styles and
  code, or Mantine's), and the earlier look's `--sf-` colour names are gone; only
  `--sf-safe-bottom` and `--sf-keyboard`, which aren't colours, keep that prefix.

**Tests.** [App.test.tsx](../web/src/App.test.tsx), with phone cases
(`{ size: 'phone' }`), [Shell.test.tsx](../web/src/components/shell/Shell.test.tsx) (the
tab bar, sidebar, Add, history, landmarks, pages without the places),
[routes.test.tsx](../web/src/hooks/routes.test.tsx) (each address and the old ones),
[shortcuts.test.tsx](../web/src/hooks/shortcuts.test.tsx),
[Settings.test.tsx](../web/src/components/settings/Settings.test.tsx), and
[isolation.test.tsx](../web/src/testing/isolation.test.tsx) (each screen test starts
from nothing). The look: [theme/paper-ledger.test.tsx](../web/src/theme/paper-ledger.test.tsx)
(every colour light and dark, the ground, Geist, filled primary buttons whatever accent is
saved), [theme/tokens-used.test.ts](../web/src/theme/tokens-used.test.ts),
[components/ui/parts.test.tsx](../web/src/components/ui/parts.test.tsx) and
[build/paper-ledger-launch.test.ts](../web/build/paper-ledger-launch.test.ts); tests read
colours through the cascade with [testing/css.ts](../web/src/testing/css.ts).
