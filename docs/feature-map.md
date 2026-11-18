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
(`?settings`) is reached from the round initial on Home's header (phones and tablets) or
the sidebar (computers). On phones and tablets its index has a search ("Search
settings"), who's signed in (opening My account), the App sections (Money, Adding
entries, Look and start, Budgets and reminders) each with a line saying what it's set to
("MYR · month from the 1st", "Amount first · suggestions on", "Match phone · opens on
Home", "Carry over on · daily at 9:00 PM"), then Your data (Categories, "8 expense, 2
income"; Import and export, "Last import Nov 2"), Sign out and "Mahnee · Up to date";
each section is its own page at `?settings=<section>`, going back up to the index. On a
computer Settings covers the page: the sections down the left (search with Ctrl K, My
account, the App sections, Categories, Import and export, Sign out, the freshness line)
and the open one beside them, My account first; moving between them replaces history,
and Close or Esc goes back to the page it was opened over. My account
(`?settings=account`) has the name and email with Change name (a dialog; empty goes back
to the email's first part), "This phone" or "This computer" saying "Saved" with the
freshness label, and Install the app where the browser can install it (the only place it's
offered; Home no longer has a card). Search (`components/settings/settings-search.ts`, a
static index; no server) finds a setting by its name, its line, or words not on it
("the month end" finds Main currency), name matches first, quoting what was found with the
match marked; a result, or Enter for the first, opens `?settings=<section>&setting=<key>`
with that setting in view and the keyboard on it. Money
([settings/MoneyPage.tsx](../web/src/components/settings/MoneyPage.tsx)) sets when the
month starts (see Month view, The month start day) and when the week starts (Home's
calendar); its Main currency stays read-only until a home currency can be chosen, and
Other currencies is hidden. Adding entries
(`?settings=adding`): Start with (Amount or Category, what Add opens on), Account to use
("Last used", or one of the accounts in use, picked from a list; one archived since reads
as Last used), Suggest as you type (Add's payee field offers the payees used before, from
`GET /api/payee-categories`, each once, the latest writing first, at most 200; notes aren't
listed, Add has no note field) and Ask for a time (see Transactions). Look and start
(`?settings=look`): Theme (Light, Dark, "Match phone", "Match device" on a computer),
Accent (Cobalt, Green, Plum, Rust, Graphite), Expenses and income (spending in ink or red
wherever entries are listed; income always green), Home shows (Essentials or Everything,
see Home at a glance) and Open the app on (Home, Activity or Plan, see Pages). Budgets and
reminders (`?settings=budgets`): "Carry over, for new budgets" (a switch; a budget set
where there was none starts with it, see Budgets), then the reminder rows read-only until
reminders are sent (piece 16). Each control saves at once through `rememberSettings`, put
back with a message if it can't be saved. The profile also holds a display name and where
exchange rates come from, with the person's time zone.
The reminder line on the index shows the stored setting; reminders are sent only once
piece 16 lands.

**Owner.** [profile/ProfileContext.tsx](../web/src/profile/ProfileContext.tsx) loads
the profile, keeps a device copy, and owns every change through
`useProfile().change(show, save)`, which shows the change at once and undoes it if
`save` fails (the caller says what went wrong). `rememberSettings` does the same for a
preference and explains a failure itself.

**Parts.**

- UI: [components/settings/SettingsPage.tsx](../web/src/components/settings/SettingsPage.tsx)
  (the index, a computer's layout, `SectionHeader`),
  [MyAccount.tsx](../web/src/components/settings/MyAccount.tsx),
  [SectionPage.tsx](../web/src/components/settings/SectionPage.tsx) (the read-only
  sections), [SettingsSearch.tsx](../web/src/components/settings/SettingsSearch.tsx) with
  [settings-search.ts](../web/src/components/settings/settings-search.ts) (the index) and
  [setting-in-view.ts](../web/src/components/settings/setting-in-view.ts),
  [settings-text.ts](../web/src/components/settings/settings-text.ts) (summaries and
  values), [common/use-install-action.tsx](../web/src/components/common/use-install-action.tsx),
  [components/common/you.ts](../web/src/components/common/you.ts) (the name and initial),
  [components/common/YouLink.tsx](../web/src/components/common/YouLink.tsx),
  [AddingPage.tsx](../web/src/components/settings/AddingPage.tsx),
  [LookPage.tsx](../web/src/components/settings/LookPage.tsx),
  [BudgetsPage.tsx](../web/src/components/settings/BudgetsPage.tsx) and
  [setting-parts.tsx](../web/src/components/settings/setting-parts.tsx) (a setting's row,
  a segmented choice, a switch); [theme/appearance.ts](../web/src/theme/appearance.ts)
  marks the accent and the colour of spending on the page (`data-accent`,
  `data-expenses`) and gives Mantine the accent.
- API: [worker/accounts/auth.ts](../worker/accounts/auth.ts) checks the Access token (or
  the local dev user), [worker/routes/me.ts](../worker/routes/me.ts) serves `/api/me`,
  and [worker/accounts/profiles.ts](../worker/accounts/profiles.ts) stores the profile
  and settings.
- Shared: `Settings`, `DEFAULT_SETTINGS` and the profile shapes in
  [shared/api.ts](../shared/api.ts); what each setting takes in
  [shared/settings.ts](../shared/settings.ts), read by the Worker and the test stand-in;
  each accent's shades (`ACCENT_RAMPS`) in [shared/accents.ts](../shared/accents.ts), and the
  same shades as `--accent` and `--accent-tint` per accent in
  [theme/tokens.css](../web/src/theme/tokens.css).

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
- Each stored accent is drawn in its own colour ([theme/theme.ts](../web/src/theme/theme.ts),
  tokens.css); [theme/paper-ledger.test.tsx](../web/src/theme/paper-ledger.test.tsx) checks
  all five. The light shades are the design's swatches; the boards give a dark shade for
  cobalt only, so the others' dark shades and every tint are worked out in
  `shared/accents.ts`, each tint keeping the accent's words on it at 4.5:1 or more
  (settings/LookPage.test.tsx). Migration 0007 mapped the old accents to the redesign's:
  green stayed green, every other became cobalt. One kept on a device from before is drawn
  as cobalt.
- A setting's row keeps its key (`data-setting`) whatever its control, so a search result
  opens with it in view.

**Tests.** [settings/AddingPage.test.tsx](../web/src/components/settings/AddingPage.test.tsx)
(each control as drawn and its effect on Add, Last used and an archived choice, the chosen
account over the last used, suggestions once each, off reading nothing, a failed save),
[settings/LookPage.test.tsx](../web/src/components/settings/LookPage.test.tsx) (theme,
each accent and its tint on both themes, expenses in red on Activity and an account page,
Home shows and Open the app on saved, no theme switch on Home),
[settings/BudgetsPage.test.tsx](../web/src/components/settings/BudgetsPage.test.tsx)
(carry over for new budgets, on the category's sheet and Plan's field),
[settings/Settings.test.tsx](../web/src/components/settings/Settings.test.tsx)
(the index and its summaries, each section and back, My account with Change name and a
refusal, saved and waiting offline, install where offered and never on Home, a computer's
layout, Close and moving between sections, search, clear, nothing found, Ctrl K and
Enter), [settings-search.test.ts](../web/src/components/settings/settings-search.test.ts),
[settings-text.test.ts](../web/src/components/settings/settings-text.test.ts),
[worker/accounts/auth.test.ts](../worker/accounts/auth.test.ts) (tokens,
keys, configuration, 401 versus 500), [App.test.tsx](../web/src/App.test.tsx) (who's
signed in, signed out, unreachable, saving the theme and undoing a failed save),
[profile/time-zone.test.tsx](../web/src/profile/time-zone.test.tsx) (the time zone sent
at start), the profile cases in [worker/test/api.test.ts](../worker/test/api.test.ts), and
[worker/test/migrations.test.ts](../worker/test/migrations.test.ts) (0007 on rows from
before, and every CHECK against what the API takes).

## Accounts

**What it is.** The places a person's money is: cash, bank accounts, cards and
e-wallets, each with its balance, listed on Accounts (`?accounts`, R-Accounts). Until the first one is
added, the first run asks where the money is kept (see Home at a glance). Accounts opens with "All together" (every running account's
balance, less what's owed on cards), what's in accounts and what's owed (a part left out
when there's no account of its kind), then "Cash, banks and e-wallets" and "Cards", each
with its total, and the archived ones behind "Archived · N", each with the day it was
archived ("E-wallet · archived Aug 14"; just "archived" for one archived before the day was
kept). Archived accounts count in no total. List amounts have no RM; a card's says owed (or
in credit). On a phone or tablet a row opens the account's own page (`?account=<id>`,
R-Account), which goes back up to Accounts: its kind, name and balance, Add here, Transfer
and Search (Activity on it, every month: `?activity&account=<id>&dates=all`), and its
entries by day, each signed by what it did to this account (transfers too), titled by the
other account, the payee, the note or the category, in that order. An archived one says
"Hidden when adding entries" with Unarchive in place of the actions (R-Account-Archived).
On a computer the two are one page (R-Desk-Accounts): the list on the left and the account
on the right (the one in the address, else the first running one), with what it started
at, Add here, Transfer and Edit, "Search this account" and "Any date" (kept on the page, not
in the address, fresh for each account; through `GET /api/search` with `account=`, 200 a
page with Load more), and a register whose "Balance after" is worked back from the balance
shown through the loaded rows, newest first, so it's left out while searching or narrowed
to some days. Picking an account there takes the page's place in history. "Show 50 more"
loads the next page. Add here and Transfer open Add with this account in From (Transfer on
Transfer), over a kept draft's account, the rest of the draft kept. Add one from the list;
rename it, change its opening balance, or archive it (with Undo) from Edit; Unarchive brings
it back in one tap, with nothing to undo. A card's balance is what's owed on it. Its kind is
fixed once added. Worker folder `accounts/` is sign-in, not these: the ledger is `ledger/`.

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

- UI: [components/accounts/AccountsPage.tsx](../web/src/components/accounts/AccountsPage.tsx)
  (one page at a time, or the two side by side on a computer),
  [AccountsList.tsx](../web/src/components/accounts/AccountsList.tsx) (the totals, the
  groups, placeholders, empty state and archived ones),
  [AccountPage.tsx](../web/src/components/accounts/AccountPage.tsx) (one account's page on a
  phone or tablet), [AccountPane.tsx](../web/src/components/accounts/AccountPane.tsx) (the
  account beside the list, with its register, search and "Any date"),
  [account-actions.ts](../web/src/components/accounts/account-actions.ts) (Add here,
  Transfer, Search and Unarchive) and
  [AccountForm.tsx](../web/src/components/accounts/AccountForm.tsx) (adding and
  changing one, in a `ResponsiveDialog`);
  [account-text.ts](../web/src/components/accounts/account-text.ts) reads balances, totals,
  the archived day and entries out and opening balances in;
  [common/EntryTile.tsx](../web/src/components/common/EntryTile.tsx) is an entry's tile, as
  Activity draws it. The old list under Home's (then Plan's) month is gone; Accounts is the
  one list of balances. Undo is
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
  balance is whole cents within `MAX_TRANSACTION` either way; typed as a sum in the form,
  it's worked out by Add's keypad rules (`readTypedSum`), never in floating point. A balance is the opening
  balance plus income less spending, worked out by the server in one grouped sum, never
  stored.
- The totals on Accounts are summed in the app in whole cents over the running accounts:
  at most `MAX_ACCOUNTS` balances, each bounded by `MAX_TRANSACTIONS_PER_ACCOUNT` x
  `MAX_TRANSACTION_CENTS`, so every total stays a safe integer.
- The archived day (`archivedAt`) is the server's, set when an archive is saved and kept
  while the account stays archived, null once it's back; the app shows the device's time
  at once and the server's from the next read. A copy of the ledger kept from before it has
  none (the field is optional). Export and import carry no archived day.
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
cards, renaming and archiving from an account's page, Unarchive, Undo, refusals put back, a
failing server tried again, answers out of order, at desktop and phone sizes),
[AccountsPages.test.tsx](../web/src/components/accounts/AccountsPages.test.tsx) (the totals
and groups, the archived ones and their day, each account's page and pane, Add here,
Transfer, Search, Unarchive, the register with Balance after, its search and "Any date",
Show 50 more, at phone, tablet and desktop sizes),
[account-text.test.ts](../web/src/components/accounts/account-text.test.ts) (totals at
their largest, the words, signs and balances after),
[FailedLoad.test.tsx](../web/src/components/shell/FailedLoad.test.tsx) (a failed first load
keeping the places, asking no more until Try again), and the accounts cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (every refusal, another person's
account, receipts, all or nothing, the archived day) and
[worker/test/migrations.test.ts](../worker/test/migrations.test.ts) (0008).

## Categories

**What it is.** What spending and income are sorted into, on their own page in Settings
(`?settings=categories`; the old `?categories` still opens it; R-Categories): Expenses and
Income, each top-level category with its colour, its budget this month ("RM 800 a month",
cents only when it has some) and its subcategories as chips in a list named "Under Food".
"+" (named "Add a subcategory under Food") opens a field in place, "New under Food",
whose button ("Add Bubble tea under Food") or Enter adds it, with "Counts toward Food's
budget" under a spending one; the field at the foot of each kind ("New expense category",
"New income category") adds a top-level one on Enter. Tapping a name or chip opens its
sheet to rename it, move it under another or back to the top level, archive it (with
Undo) or set its budget (see Budgets). Reorder shows arrows to put one higher or lower
among the ones beside it, and Done puts them away. Archived (only when some are; at the
top on a computer) lists the archived ones apart, to bring back. Moves that aren't allowed
can't be picked, and say why. Everyone starts with the defaults: Food, Transport,
Groceries, Bills, Shopping, Health, Fun and Other for spending, Salary and Other income for
income.

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts), the same as accounts: every
change goes through `change()`, so it shows at once, is kept in the outbox, works offline
and is put back if refused. [ledger/apply.ts](../web/src/ledger/apply.ts) makes category
changes the way the server does; [ledger/category-tree.ts](../web/src/ledger/category-tree.ts)
arranges them as listed. Screens read through `useCategories()` in
[ledger/useLedger.ts](../web/src/ledger/useLedger.ts).

**Parts.**

- UI: [components/categories/CategoriesPage.tsx](../web/src/components/categories/CategoriesPage.tsx)
  (the two lists, chips, adding in place, Reorder's arrows, placeholders and archived
  ones) and [CategoryForm.tsx](../web/src/components/categories/CategoryForm.tsx)
  (renaming, moving, archiving and the budget, in a `ResponsiveDialog`); the row on
  [components/settings/SettingsPage.tsx](../web/src/components/settings/SettingsPage.tsx).
- API: `addCategory`, `updateCategory` (name, parent, place) and `archiveCategory` in
  [worker/ledger/changes.ts](../worker/ledger/changes.ts); categories are read with the
  accounts in [worker/ledger/read.ts](../worker/ledger/read.ts).
- Shared: `Category` and the change shapes in [shared/api.ts](../shared/api.ts); kinds,
  limits, the defaults (`DEFAULT_CATEGORIES`, fixed ids), what can sit under what
  (`whyNotUnder`, `whyStaysOnTop`) and how siblings are ordered (`siblingsOf`,
  `nextPosition`, `reorder`) in [shared/categories.ts](../shared/categories.ts).
- Colours: [utils/category-colour.ts](../web/src/utils/category-colour.ts) works out each
  category's colour, nothing stored. The starting spending categories wear the design's
  own (by their fixed ids, so renamed or moved they keep it: Groceries `--c1`, Shopping
  `--c2`, Food `--c3`, Bills and Health `--c4`, Transport `--c5`, Fun `--c6`); one a person
  adds takes one of `--c1` to `--c6` from a hash of its id, so no colour moves when others
  are added, moved or archived; a subcategory wears its parent's; "Other" (the top-level spending category named
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
Settings with the defaults, budgets in whole ringgit, adding a subcategory in place and a
top-level one from its field, renaming, moving, Reorder's arrows, moves that
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
With Suggest as you type on, the payee field lists the payees used before (Settings ›
Adding entries). With Ask for a time on (owner decision D20, `askForTime`), the day reads
"Today, 8:12 PM": the time Add opened, changeable under it ("Time"), saved as it's shown.
An entry's time (`time`, "08:12" on the person's clock, or none) shows after its line
("Food · Wallet · 8:12 PM", the register's day "Nov 10, 8:12 PM", the open entry's day),
can be changed where the entry is edited (the Time field shows when the setting is on or
the entry has one), and orders entries within a day: the latest time first, those with
none after, then as saved. Off, entries have no time, as before; ones with a time keep it.
A page loaded before entries had times names where it carries on from the old way, which
the server refuses (400): Load more then reads the list again from the top, the rows kept
on screen, and carries on (`loadNext` in ledger/useLedger.ts; ledger/load-more.test.tsx).
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
  `totalCents`, in whole cents with no floating point; `readTypedSum` reads an account's
  opening balance typed as a sum the same way); `Transaction`, `NewTransaction`,
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

**What it is.** Plan (`?plan`, one of the places; R-Plan, R-Desk-Plan, R-Empty-Plan,
R-Category): the month's budgets, where the money went and what came in (Home draws its own
figures from the same totals; see Home at a glance). This month unless the address names an
earlier one (`?plan&month=2026-10`; the arrows step between months, never past this one,
and Back returns). "Plan" heads it, with the month ("Nov 2026"; on a computer "November
2026 · day 10 of 30") and its two halves, Budgets and Scheduled (`?plan=scheduled`; see
Scheduled).

- Budgets (phone and tablet): "Budgets Day 10 of 30" with "Budget" (Categories, where a
  budget is set on a phone); each budget "RM 584.78 left" (or "RM 40.00 over"), a bar named
  "Food: 27% spent" with a marker for how much of the month has gone (this month only),
  "RM 215.22 of RM 800.00" with " · faster than the month" or " · over" (amber or red), and
  "Carry over on", or "incl. RM 50.00 carried over" when something carried. None this
  month: "No budgets yet", "A monthly amount per category, with a bar for what's left." and
  "Set a budget".
- "Where it went" with the month's spending, a bar of each category's share ("Share of
  expenses: Bills 44%, Groceries 26%, ..."; whole percents rounded half up, "under 1%" for
  a share that rounds to nothing), then each top-level category, largest first, its share
  and what makes it up: its subcategories with their amounts and what was filed on it
  itself ("Dining out 60.00, Coffee 15.00, Food 9.00"), or its one entry's payee ("Rent"),
  or "1 entry" / "6 entries". Each opens the category over 12 months. Nothing spent:
  "Nothing spent in November yet." (an earlier month without "yet").
- "Income": what came in, and "Salary due Nov 25" (the listed income item next due), or
  "Nothing in yet." with "Schedule your pay" when none is listed; then "Income by
  category", largest first, each with its share and what makes it up as Where it went's
  rows. Each opens the income category over 12 months (a page on a phone, the right pane
  on a computer, where the one open is marked).
- On a computer: "Expenses by category" ("RM 2,753.10 spent", "Edit categories"), a table of
  every category spent in (largest first) and every other listed top-level spending category
  ("Nothing this month"): Category (its subcategories' names, payee or entries, " · carries
  over"), Spent, "Budget, with today marked" (the bar, or "Set a budget" this month), Left
  ("584.78", "40.00 over"). The category chosen (the first row unless the address names one,
  `?plan&category=<id>`, which picking a row replaces) is open on the right, with its
  budget changed in place this month: "Monthly budget" (saved on Enter or on leaving the
  field when changed; emptied, it's taken away; what can't be a budget says why and sends
  nothing) and a "Carry over" switch (sent at once, the amount kept; off without a budget).
  With no budgets and nothing spent, the same cards as a phone.
- A category over 12 months (a page of its own on phones and tablets, with Back "Plan" and
  no tab bar; the right pane on a computer): its name, what was spent in the month (an
  income category: what came in, "Received in November · ..."; never a budget), "Spent
  in November · RM 156.24 under your usual RM 371.46" (the usual is the average of the 11
  months before; "over", or "the same as your usual"), its last 12 months as bars named
  "Food, last 12 months, November lowest since August" (lowest or highest "in 12 months"
  when no month before reaches it, else since the latest month that does; nothing when
  level with the month before), each read out "Nov 2026, RM 84.00", with "avg 371.46";
  "Inside Food" (each subcategory, then "Just Food"; with entries on a phone); its budget
  ("RM 584.78 left of 800.00", "RM 10.00 over 20.00"); and "See all 14 in Activity" /
  "See 14 entries" (`?activity&category=<id>`, an earlier month's days added).
- Every expense or all income over 12 months, opened from Home's "Expenses so far" and
  "Income" (`?plan&category=expenses` or `income`, after `&month=` for an earlier month;
  `hooks/useRoute.ts` names them, a category's id can't be either, and any other text
  opens no category): a page of its own on phones and tablets with Back "Home" (to Home at
  that month) and no tab bar; the right pane on a computer, where the arrows keep it open.
  "All expenses" or "All income", the month's total, "Spent in November · RM 11.87 over
  your usual RM 4.13" ("Received in" for income), and the 12 months as bars named "All
  expenses, last 12 months, ..." as a category's are. Money moved between accounts is
  neither.

Placeholders show until the month arrives; when it can't be had, "Couldn't load this
month." with Try again, and the 12 months likewise. Left and Over for the month went with
the old month card (Home's month end takes its place; see the changelog).

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts), as for transactions; Plan keeps
no state of its own but what's typed, and changes budgets through `setBudget` (Budgets). A
month's totals are a query keyed by month (`summaryKey`), fetched from the server
(`fetchSummary`) with a device copy (`summary-v3:<month>`) shown offline. They're kept
as the server summed them, with each saved batch counted in (before the lists take it,
so an edited transaction is taken out as it was), and the changes still to send counted
on top as they're shown (`shownSummary`). Once nothing is left to send they're fetched
again. [ledger/summary.ts](../web/src/ledger/summary.ts) (`applyToSummary`) does the
counting the way the server sums; [ledger/derive.ts](../web/src/ledger/derive.ts)
(`rollUp`) puts subcategories inside their top-level category for showing. Screens read
through `useMonthSummary(month)` in [ledger/useLedger.ts](../web/src/ledger/useLedger.ts).
The 12 months up to the month shown are a query of their own (`trendKey`, fetched by
`fetchTrend`, device copy `trend-v3:<month>`), kept and counted the same way
(`shownTrend`, `applyToTrend`, each change in whichever of the 12 it falls in); screens
read them through `useMonthTrend(month)`. The month's figures never wait on them.

**Parts.**

- UI: [components/plan/PlanPage.tsx](../web/src/components/plan/PlanPage.tsx) (the header,
  halves, budgets, Where it went, Income, the computer's table),
  [CategoryView.tsx](../web/src/components/plan/CategoryView.tsx) (a category over 12
  months, page or pane, with the budget field),
  [BudgetBar.tsx](../web/src/components/plan/BudgetBar.tsx), the words in
  [plan-text.ts](../web/src/components/plan/plan-text.ts), the addresses in
  [plan-address.ts](../web/src/components/plan/plan-address.ts), the month and day N of M in
  [plan-month.ts](../web/src/components/plan/plan-month.ts) (the person's month through
  `useMonths`, and `periodDay`); months in
  [utils/date-input.ts](../web/src/utils/date-input.ts) (`thisMonth`, `addMonths`,
  `monthHeading`, `monthLabel`).
- API: `GET /api/summary?month=2026-11` (`readSummary` in
  [worker/ledger/summary.ts](../worker/ledger/summary.ts)): one grouped SQL sum.
  `GET /api/summary/trend?month=2026-11` (`readTrend` in
  [worker/ledger/trend.ts](../worker/ledger/trend.ts)): the 12 months ending there, each
  in the month's shape, in one grouped SQL sum over a fixed window. Both read the
  person's month start first (`readMonthStart` in
  [worker/ledger/month-start.ts](../worker/ledger/month-start.ts)) and group earlier
  months by `periodMonthSql` ([worker/ledger/period-sql.ts](../worker/ledger/period-sql.ts)).
- Shared: `MonthSummary`, `MonthTrend` and `CategoryTotal` in
  [shared/api.ts](../shared/api.ts); the person's month in
  [shared/period.ts](../shared/period.ts); the 12 months, the average and the comparison in
  [shared/trend.ts](../shared/trend.ts);
  `isMonth` in [shared/ledger.ts](../shared/ledger.ts).
- App: the person's month in [ledger/month-start.ts](../web/src/ledger/month-start.ts)
  (`useMonths`, `useMonthStart`; and `useForgetMonthsWhenTheStartChanges`, called by the
  shell), and `forgetMonthTotals` in [ledger/ledger.ts](../web/src/ledger/ledger.ts).

**Flow.** The server sums the person's spending and income in the month (by the day a
transaction is on) across every account, grouped by each category's own id, largest
first. The app rolls subcategories up into their parent by the categories it has now, so
a subcategory moved under another category moves its spending with it.

Each category's total also says how many transactions make it (`entries`) and, when it's
one transaction naming a payee, that payee (`payee`, for Plan's "Rent" rather than "1
entry"); the 12 months' rows say the same. A month's totals (not the 12 months) also hold,
for Home and Plan:

- `spentByDay`: spending by day, oldest first, only days with any (at most 31), for Home's
  calendar. [ledger/day-by-day.ts](../web/src/ledger/day-by-day.ts) (`dayByDay`) lays out
  the period's days against the middle day so far: the median of each day's spending from
  the period's first day to today, a day with nothing counting as 0, an even count taking
  the mean of the two middle days in whole cents rounded half up; a day above it is
  "more", at or below it "less", a day still to come neither.
- `tidyUp { from, entries, categoryIds }`: how many spending transactions from the first
  day of the month before (`tidyUpFrom` in [shared/categories.ts](../shared/categories.ts))
  to the month's last day are in Other (`OTHER_EXPENSE_ID`, the default's fixed id, renamed
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
Date in the device's zone; they live in [shared/period.ts](../shared/period.ts) with the
month start day. Callers pass today as the person's own
day, `toDateInput(new Date())` ([utils/date-input.ts](../web/src/utils/date-input.ts)),
never `toISOString()`, and screen tests pin the clock at a time where the local and UTC
days differ.

Home names the budget "running fast" by the largest lead spent x days - available x day
(exact, at most about 6e13), never by comparing two budgets' ratios by cross-multiplying
(about 4e24, past exact whole numbers), the first in the categories' order when two are
level; Home shows Tidy up for this month only. Plan's roll-up (`rollUpEntries` in
`derive.ts`, beside `rollUp`) sums `entries` into the top-level category and keeps a payee
only when the category and its subcategories hold one transaction in all. Each share and
each bar's percent is worked in whole numbers (BigInt), so it is exact at 5e15 cents.

### The month start day

Every monthly figure runs over the person's month (owner decision D7): Home's month, its
days, Day N of M, Tidy up, the month end and budgets; budgets' carry-over; Plan and a
category's 12 months; Activity's and an account's This month and Last month; Change
category's budget line; a new budget's first month; and which month the freshness label
judges. Export's "This year" stays the calendar year, and so does the Worker's unused
`GET /api/transactions?month=` list (no screen asks for it).

- The month starts on a day (`monthStartDay` 1 to 28, or 31 for each month's last day) or
  on payday (`monthStartPayId`): the day of the month a running monthly income is due, 1
  to 31. A start past a month's last day starts that month on its last day, so a period
  is 28 to 31 days. A pay that stops or isn't monthly income falls back to the day
  (`monthStartDayOf`), as the server's settings already do.
- A period is named for the month holding most of its days: from the 15th or before, the
  month it starts in; from the 16th, the month it ends in ("November" is October 25 to
  November 24). That rule names every month once and skips none; for a start on the 15th
  in a 28-day February (14 and 14) and on the 16th (16 and 15, or 15 and 15) it settles
  what a count of days can't (`shared/period.test.ts` checks four years of every start).
- The Worker reads the start on every read (`readMonthStart`) and sums the period's days;
  a month's totals and each of the 12 months say which (`firstDay`, `lastDay`), and the app
  counts changes still to send by those days. Nothing stored is rewritten: changing the
  start re-buckets every figure when it's next read. Budgets keep their `fromMonth`, now
  the name of a period; a budget can be set up to the period holding tomorrow in UTC.
- The app works the month out the same way from the profile and the repeating items
  (`useMonths`): which month today is in, and an earlier one's days. Home's Day N of M and
  calendar use the days the totals were summed over once they're in. `?month=` names an
  earlier month; one naming this month or a later one (up to next calendar month, the
  latest a month can be named) is cleaned to Home's own address.
- Device copies: when the start changes on this page (a save on Money, or the pay it starts
  on moved or stopped), every `summary-v3:` and `trend-v3:` copy of the signed-in account
  is deleted and the totals shown are dropped and fetched again; Money's save does it again
  once the save is through or undone. Another account's copies stay.
- Money's "Month starts on" is a sheet on phones and a dialog on computers holding a draft
  ("A date" with the days and "Last day of the month", or "Payday" with the pay picked
  from Scheduled's running monthly incomes), with this month's days as a preview; Done
  saves it through `useProfile().rememberSettings` (undone with a message on failure),
  Cancel, Back and Esc keep nothing. With no pay scheduled, Payday says so and Done keeps
  the date. Week starts on saves as it's picked.

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
- The device copies are `summary-v3` and `trend-v3`, since copies from before the days
  they were summed over (`summary-v2`, `trend-v2`) or before days, entries and Tidy up
  (`-v1`) are in an older shape: those are never read, and stay unused on the device. The service worker keeps no copy of these keys or
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
categories; entries and a lone payee), [Plan.test.tsx](../web/src/components/plan/Plan.test.tsx)
(Kuala Lumpur just after midnight: the header and halves, budgets with carry-over, faster
and over, Where it went with a transfer left out, Income, the computer's table and pane,
setting, changing and taking away a budget there, refusals, the limit, nothing sent when
unchanged, offline, earlier months and Back, empty months, placeholders, a month that
fails, each change counted while an earlier one saves, offline through a reload, what's
left never counted twice, the Scheduled half; desktop, tablet and phone),
[Trends.test.tsx](../web/src/components/plan/Trends.test.tsx) (Home's two cards opening
every expense and all income over 12 months, a transfer never counted, an earlier month
and Back to Home, a month with no income, a year with nothing, offline in two months
through a reload, 12 months failing, answers out of order; income by category largest
first, each opening its own 12 months, a page or the pane with no budget),
[CategoryPage.test.tsx](../web/src/components/plan/CategoryPage.test.tsx) (the month
against the usual, 12 months and their window, Inside, the budget, Activity a tap away,
over and none, an empty month and none at all, Back at an earlier month, not found, 12
months failing, answers out of order, offline in two months through a reload),
[plan-text.test.ts](../web/src/components/plan/plan-text.test.ts) (shares exact at the
largest totals, subtitles, the usual, lowest and highest since, budget words and percents),
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
  opens `?activity&q=<words>`). The initial comes once the accounts are
  known (it may be the first run, which has its own) or couldn't be loaded ("Couldn't load
  your accounts.", Try again), so Settings and Sign out are always a tap away.
- "Expected at month end": the month-end sum (Repeating bills and month end) with its line,
  "RM 8,157.00 today − RM 189.00 bills + RM 6,800.00 pay", the bills part in the negative
  colour and the pay part in the positive one, each only when something is due; with the
  one account and nothing due, "Maybank Savings today". Below zero it reads "−RM 120.00".
- "Expenses so far" ("None yet", or "Day 10 of 30", with " · Food running fast" for the
  budget furthest ahead of the month) and "Income" ("Salary due Nov 25", the listed income
  item next due, or "No pay scheduled"), each opening every expense or all income over 12
  months, ending at the month shown (see Plan). On a computer the three sit across the
  top, in a region "November at a glance".
- What's due now, to log or skip: only items that ask first (Scheduled).
- Tidy up, on the due tint, this month only and only when there are any: "2 entries since
  Oct 1, still in Other" (Other's own name), with Sort them opening
  `?activity&category=<OTHER_EXPENSE_ID>&from=<tidyUp.from>&select`.
- Coming up: first each entry Scheduled added this month whose amount is still to check
  (every one, from the month's `fromScheduled`), "Water · RM 30.15" / "Nov 5 · amount to
  check", a link to `?activity&day=<day>` where it's confirmed; then each listed repeating
  item's next day after today (one row per item, soonest first, at most 3), "TNB
  electricity · RM 189.00" / "Nov 20 · Maybank Savings" (or "Nov 20 · amount to check" for
  an item whose amount changes), income "+RM 6,800.00", a transfer unsigned with "Maybank
  Savings to Cash"; under the list "Added this month: Rent, Netflix", each item Scheduled
  added to this month by name, in the order of its first; "All scheduled" opens
  `?plan=scheduled`.
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

Home shows (Look and start, owner decision D13): "Everything" is all of the above;
"Essentials" is the month-end figure (or what an earlier month left), what's due now (Log
it / Skip), Tidy up, Getting started on a first day, and Coming up with the next scheduled
item and any whose amount is to check (`essentialRows` in home-text.ts); the two cards,
the calendar and the budgets are left out, on every size. The theme is chosen in Settings ›
Look and start; installing the app is offered on Settings › My account only.

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
- Shared: `budgetPace` in [shared/budgets.ts](../shared/budgets.ts); `periodDay` in
  [shared/period.ts](../shared/period.ts); the month end is the last day of the person's
  month (Month view, The month start day).

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
"Carry over" switch, which starts as "Carry over, for new budgets" in Settings says, on
unless turned off), or Plan's own field on a computer (a new budget there carries over as
that setting says too); the row then says "RM 300.00 a month". The amount
applies from this month on, the same every month until changed; earlier months keep what
they had. Home lists each budgeted category with what's left and how it goes against the
month (see Home at a glance). Plan lists each budgeted category, in the categories' order,
on a phone as "RM 120.00 left" and "RM 180.00 of RM 300.00" ("RM 40.00 over" in the
negative colour), with a bar for what's spent; on a computer in its table, where this
month's budget is also set, changed or taken away in the category's pane, through the same
`setBudget` (see Month view). With Carry over on, last month's leftover is added to this
month's amount, or what it overspent taken away, shown as "incl. RM 30.00 carried over"
("incl. −RM 20.00 carried over"), and the "of" figure includes it.

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

- UI: Plan's budgets and the pane's "Monthly budget" and "Carry over" in
  [components/plan/](../web/src/components/plan/PlanPage.tsx) (see Month view); the fields in
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
  against the month (`budgetPace`; `periodDay` in shared/period.ts; see Month view). A
  budget's month is the person's (The month start day).

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
[Budgets.test.tsx](../web/src/components/home/Budgets.test.tsx) (Plan's lines and table rows,
over in words and colour, carry over, earlier months, setting, changing and taking away from the
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
Transfers, Expenses and income); `&scheduled` (Scheduled's "See them") keeps only entries
added from Scheduled, with a pressed "From Scheduled" chip that takes it off. "12 found · RM 43.18 spent" (and "· RM x received"
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
person's month, from their month start day) move the budget, and none already in it:
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
- API: `GET /api/search?q=&account=&category=&from=&to=&kind=&scheduled=1&before=&limit=`
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

**What it is.** Bills, income and transfers that repeat ("Scheduled"), monthly on a day of
the month (on a shorter month's last day past its end) or weekly on a weekday, each added
on its day by the server (owner decision D8, "Add on the day"). Set one up on Plan ›
Scheduled (Schedule something, a common one, or Schedule one under a card's note), with
Repeat (Monthly or Weekly) in Add, or under More on a transaction's own sheet when
changing it (its first due date the next one after the person's own today).

- **Added on its day.** A cron trigger runs every 15 minutes (`wrangler.jsonc`
  `triggers.crons`, `*/15 * * * *`, shared with reminders later). Each run works out each
  stored time zone's day from the run's scheduled time and adds every occurrence whose day
  has begun where its person is: an entry dated that day, "from Scheduled", and "amount to
  check" when the item's amount changes. Missed runs are caught up from the item's next due
  date, oldest first, at most 31 occurrences of one item and 200 entries a run; the rest
  come in the runs after. Someone with no stored time zone is left until the app sends one.
- **Asks first (D19, "Ask once, then automatic").** An item that was overdue when 0009 ran,
  or is saved, moved back (Undo of Log it or Skip) or brought back (stopped, or its account
  archived) with its next due date on or before the person's own today, asks first: it
  stays on Home, "Due: Rent RM 1,200.00 from Maybank" (income "into Maybank", a transfer
  "from Maybank to Visa"; with no payee, its category's name), with Log it, which records it
  on the day it was due (from Scheduled) and moves it on, and Skip, which moves it on
  recording nothing; each has Undo. It stops asking once logged or skipped past today, and
  from then on is added on its day. Nothing is guessed about a bill that may not have been
  paid.
- **Amounts that change.** "Each time: Same amount / It changes". An entry added at an
  amount that changes reads "amount to check" in Activity, on its account's page and first
  in Home's Coming up; opening it says "Added at RM 189.00 from Scheduled, for you to
  check" with the amount ready to type; Save confirms it as it is, or at the amount the
  bill came to, which on the item's latest entry becomes the item's amount next time.
- **Undo.** An entry from Scheduled is deleted as any entry is, with Undo (it comes back
  still from Scheduled, still to check); its occurrence stays done, never added again.
  Stop scheduling has Undo.
- **Scheduled** (`?plan=scheduled`; R-Bills, R-Desk-Bills, R-Empty-Bills): Expenses and
  Income, each with what it comes to in the person's month ("RM 1,443.90 a month": a monthly
  item once, a weekly one each time it falls in the month), and Transfers ("not an
  expense"), in the order set up; each row its tile, name (income by its category; a
  transfer "Top-up to Touch 'n Go"), day ("1st · Maybank Savings", "20th · amount
  changes"; on a computer "1st of the month" and "Next Nov 20 · amount changes about"),
  signed amount and "Next Dec 1" (one asking first "Was due Nov 1"). A listed card owed
  with no running transfer into it: "Visa Platinum: RM 14,130.38 owed by Dec 3, no payment
  scheduled." (owed today plus its scheduled spending up to its last charge in the next 30
  days, by that day; "owed, no payment scheduled." with none ahead) with Schedule one. "3
  added this month · See them" (entries from Scheduled in the person's month) opens
  `?activity&scheduled`. Nothing scheduled: "Rent, bills and pay, added on their day.",
  Schedule something and the common ones (Rent, Salary, Phone bill, Netflix, Car loan),
  each filling in a new schedule.
- **The sheet** (named after the item; "New schedule" for a new one): Name, Amount ("last
  time" when it changes), Amount each time, From (income Into; a transfer From and To),
  For, Repeats ("Monthly on the 3rd", "Weekly on Mondays"), then for an item "Next" ("Dec 3
  · added automatically from Visa Platinum", "Nov 20 · added at RM 189.00, for you to
  check") and Stop scheduling, or for a new one What it is and First on (the first after
  today on its repeat). A new schedule or day falls first on or after the one it was next
  due on.
- **Month end.** Home's hero, "Expected at month end", is today's balances of every listed
  account (a card's owed amount counts against them), less the bills still due this
  month, plus the income still due (see Home at a glance). Still due is every occurrence
  of a listed item on a listed account not yet added, logged or skipped, from its next due
  date up to the month's last day; transfers change nothing.

**Owner.** [ledger/ledger.ts](../web/src/ledger/ledger.ts): repeating items are part of the
ledger (`Ledger.recurring`, with `amountVaries` and the server's `askFirst`), read with the
balances in one request, so the total's two halves always come from one copy, and the
never-count-twice rule (`alreadySaved`) covers a log with no second read. Every change goes
through `change()`: `addRecurring`, `updateRecurring`, `archiveRecurring`, `logRecurring` {
id, due, transaction } and `skipRecurring` { id, due }; a confirmed amount is an
`updateTransaction` with `toCheck: false` (or the new amount), with the item's
`updateRecurring` in the same change. [ledger/apply.ts](../web/src/ledger/apply.ts) makes a
log into its transaction and the move to the next date (`oneByOne`), and a confirmation
into an entry with nothing to check. [ledger/summary.ts](../web/src/ledger/summary.ts)
counts entries from Scheduled on top of the month's totals (`fromScheduled`).
[ledger/forecast.ts](../web/src/ledger/forecast.ts) works out the total
(`monthEndForecast`) and what's due now (`dueNow`: asking first only). **Boundary
exception, owner decision D8:** the nightly job writes entries on the server, outside the
app's owner, through the same `applyChanges` path and checks as the app's changes; the app
sees them on its next read.

**Parts.**

- UI: [components/plan/ScheduledView.tsx](../web/src/components/plan/ScheduledView.tsx),
  [ScheduleSheet.tsx](../web/src/components/plan/ScheduleSheet.tsx) and
  [scheduled-text.ts](../web/src/components/plan/scheduled-text.ts) on
  [PlanPage.tsx](../web/src/components/plan/PlanPage.tsx);
  [components/home/DueItems.tsx](../web/src/components/home/DueItems.tsx) and
  [recurring-text.ts](../web/src/components/home/recurring-text.ts) and Coming up on
  [HomePage.tsx](../web/src/components/home/HomePage.tsx); "from Scheduled" in rows
  ([common/scheduled-note.ts](../web/src/components/common/scheduled-note.ts)) and
  confirming in [activity/EntryEditor.tsx](../web/src/components/activity/EntryEditor.tsx)
  and [entry/EntrySheet.tsx](../web/src/components/entry/EntrySheet.tsx); Repeat in
  [AddEntry.tsx](../web/src/components/entry/AddEntry.tsx) and EntrySheet.
- API: read with the accounts (`readLedger` in
  [worker/ledger/read.ts](../worker/ledger/read.ts); `recurring` only for someone who has
  any; each entry's `scheduled` only on one from Scheduled); the changes in
  [worker/ledger/changes.ts](../worker/ledger/changes.ts); the month's `fromScheduled` in
  [summary.ts](../worker/ledger/summary.ts); `?scheduled=1` on `/api/search`; the job in
  [worker/ledger/post-scheduled.ts](../worker/ledger/post-scheduled.ts), run by the
  `scheduled` handler in [worker/index.ts](../worker/index.ts).
- Shared: `Recurring`, `ScheduledMark`, `ScheduledInMonth` and the change shapes in
  [shared/api.ts](../shared/api.ts); schedules, `nextAfter`, `fallsOn`, `onOrAfter`,
  `dayFor`, `monthEnd` and `MAX_RECURRING` in [shared/recurring.ts](../shared/recurring.ts);
  `dayIn`, `dueThrough`, `monthlyCents`, `MAX_POSTED_PER_ITEM` and `MAX_POSTED_PER_RUN` in
  [shared/scheduled.ts](../shared/scheduled.ts), which the Worker, the app and the test
  stand-in use alike.

**Invariants.**

- What an item records is checked as a transaction's is: a listed account (and for a
  transfer another listed one), a listed category of its kind, an amount of 1 cent to
  `MAX_TRANSACTION`, a payee of at most `MAX_PAYEE`. Its kind never changes.
- Its first due date comes with it from the app (`nextDue`) and is checked as a moved one
  is, on its schedule and within a year, but never against today.
- An occurrence is added once: the job's change id and transaction id are the first 16 hex
  characters of SHA-256 of `sched:<item>:<day>`, so a run repeated, retried or overlapping
  is stopped by the receipt, the next due guard or the transaction's own id; an entry
  deleted is never added again. A log's transaction is saved with the move to the next
  date in one batch, only from the occurrence named (else 409 "That was logged or skipped
  already").
- The job never reads an item that can't be added (its account, its transfer's other
  account or its category archived), so those take nothing from a run; anything else
  refused is left, without holding back the person's other items or anyone else's. Each
  run reads at most 200 items and adds at most 200 entries, each exact in cents, for at most
  40 people and 100 saves; a person whose save fails outright is left for the next run and
  the others still go, and the run then fails so the trigger shows it. Bringing an account
  or category back makes its overdue items ask first. It logs
  only an error's name and message.
- `to_check` is set only by the job, on an item whose amount changes; the app clears it
  (`toCheck: false`, or a new amount), never sets it. An entry's mark names one of the
  person's own items.
- At most `MAX_RECURRING` (200) per person, stopped ones included. The total stays exact:
  at most 200 items due at most weekly since 2000 at most `MAX_TRANSACTION_CENTS` add about
  2.8e14 to balances of at most 5e15.
- Someone else's item, account or category is answered as one that doesn't exist (404).

**Tests.** [worker/test/scheduled.test.ts](../worker/test/scheduled.test.ts) (the job fired
at fixed instants: midnight in Kuala Lumpur, Kathmandu and Los Angeles across the end of
summer time, a zone changed, once only across repeats, overlaps, deletes and Undo, missed
runs, 31 and 200 a run, refused items taking none of it, no zone, stopped and archived,
asking first, amounts to check, the month's entries from the 25th, the search filter, and
the cron entry), [worker/test/migrations.test.ts](../worker/test/migrations.test.ts) (0009),
[shared/scheduled.test.ts](../shared/scheduled.test.ts),
[forecast.test.ts](../web/src/ledger/forecast.test.ts),
[scheduled-summary.test.ts](../web/src/ledger/scheduled-summary.test.ts),
[Scheduled.test.tsx](../web/src/components/plan/Scheduled.test.tsx) (groups and totals, the
person's month, card notes, added this month, empty and common ones, the sheet, new ones
weekly, offline and refused, stop with Undo),
[scheduled-home.test.tsx](../web/src/components/home/scheduled-home.test.tsx),
[from-scheduled.test.tsx](../web/src/components/activity/from-scheduled.test.tsx),
[Recurring.test.tsx](../web/src/components/home/Recurring.test.tsx) (Log it, Skip and Undo
for items that ask first, the total on Home, set up from a transaction, the person's own
day), and the repeating cases in [worker/test/api.test.ts](../worker/test/api.test.ts).

## Export

**What it is.** Taking everything out, so leaving the app never means leaving part of
the history behind. Export is the second half of Settings › Import and export
(`?settings=data`; R-Set-Data, R-Desk-Data). "Which entries": Everything (the default),
This year (the calendar year, whatever the month start) or Pick dates (From and To, both
included; the wrong way round says "Pick a From day on or before the To day" and can't be
downloaded). It says what the file holds before it's downloaded, counted by the server:
on phones "1,284 entries · 6 accounts · since Jan 3, 2026", on a computer Entries, From
"<first> to <last>", Accounts and Categories ("23, archived ones too" for everything; a
file of some dates counts the accounts and categories its entries use); "Nothing to export
yet" with nothing logged. Download CSV saves it as `mahnee-2026-11-05.csv` (some dates:
`mahnee-2026-01-01-to-2026-12-31.csv`), and a computer then says "Last downloaded Nov 16"
(this device, per person; someone else signed in on the open page doesn't see it). Everything holds: first each account's opening balance (Kind
"Opening balance",
dated the day the account was added, in UTC, signed, so what's owed on a card is
negative), in the person's order, then each bill or income still repeating, in the order
set up, then every transaction, oldest first, one line each. A file of some dates (D11)
holds, after the header, a line saying so ("Only these dates", its Note "Entries from
2026-01-01 to 2026-12-31 only. It can't restore balances on its own."), then only those
days' transactions: no opening balances and no repeating items, and an import reads it
as transactions only. Columns: Date, Time (an entry's time of day, empty for none and on
opening and repeating lines; owner decision D20), Kind (Opening
balance, Spent, Received, Transfer, Repeating spent, Repeating received, Repeating
transfer), Account, To account, Amount, Currency, Category, Parent category, Payee, Note, Id
(the account's id on an opening line, the item's on a repeating one). A repeating line is
dated its next due date, its amount unsigned like a transaction's, and its Note says how
often it falls ("Monthly, day 15", or "Weekly, day 3" with Monday as 1); stopped ones are
left out. Every balance can be worked out again from the file, and importing it sets the
repeating items up again. Import reads columns by the file's header, so a file made before
times (no Time column) reads as it did, and a time it can't read says "Can't read the time". Archived accounts
(and accounts with no transactions) and categories are in it like any other, with the
names they have now. On phones and tablets the share sheet opens where the device has one for
files (Save to Files on an iPhone), else it downloads. Offline the button says "Connect
to download"; changes still waiting on the device are counted ("3 changes still being
saved won't be in the file yet") and the count is taken again as they're saved.

**Owner.** No feature state: nothing else shows the counts or the file, so
[components/settings/DataPage.tsx](../web/src/components/settings/DataPage.tsx) asks
for them itself (`api.getExportSummary(range)`, `api.getExport(range)`), counting afresh
for each choice and as waiting changes are saved (`useUnsaved`).

**Parts.**

- UI: the Export card of [components/settings/DataPage.tsx](../web/src/components/settings/DataPage.tsx);
  [utils/deliver-file.ts](../web/src/utils/deliver-file.ts) saves the file (or shares it);
  `dayText` in [utils/date-input.ts](../web/src/utils/date-input.ts).
- API: `GET /api/export` (`exportTransactions`) and `GET /api/export/summary`
  (`readExportSummary`) in [worker/ledger/export.ts](../worker/ledger/export.ts), each
  with `?from=&to=` for some dates (both or neither, calendar days from 2000, from on or
  before to; else 400 "Give from and to as days, from on or before to"; `readExportRange`).
- Shared: `ExportSummary` in [shared/api.ts](../shared/api.ts); the columns, kinds,
  amounts, quoting, file name and the line of a file of some dates (`rangeCells`,
  `RANGE_KIND`) in [shared/export.ts](../shared/export.ts), which the Worker and the test
  stand-in both write lines with; `readExportRange` in
  [shared/csv-import.ts](../shared/csv-import.ts) reads that line back.

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
left out, read back as written), the ranged cases there (only those days, the note line, no opening or repeating lines,
the counts, each refusal, someone else's left out), and
[settings/DataPage.test.tsx](../web/src/components/settings/DataPage.test.tsx) (counts and
days, downloading with today's name and the server's bytes, Last downloaded and not for the next person, this year and
picked dates with the note line and the name, the wrong way round, nothing logged yet,
offline and changes still being saved, a failed download saving nothing; desktop and
phone).

## Import

**What it is.** Bringing in a CSV file. It starts on Settings › Import and export
(`?settings=data`): "Choose a file" (phones) or "Import a file" and a drop zone, "Or drop
a CSV here" (computers), which opens the import page (`?import`) with that file
([components/import/handed-file.ts](../web/src/components/import/handed-file.ts), taken once, and let go on signing out so it never opens for the next person); the page keeps its own picker for another file.
Its head shows the steps ("1 File", "2 Columns", "3 Check"; a computer's "✓ File and
account", "✓ Columns", "3 Check"), the file and account ("maybank-oct.csv into Maybank
Savings"; a computer's "Import maybank-oct.csv") and, once checked, "42 lines from Oct 1
to Oct 31" (a computer's "Into Maybank Savings · 42 lines, Oct 1 to Oct 31"), with counts
("38 to add", "4 already saved, left out", "6 going to Other"; a computer's "Ticked, to
add", "Look already saved, unticked", "Category from last time", "Going to Other"), tabs
over the lines on a computer ("All 42", "Already saved 4", "Going to Other 6") and "Cancel
import, nothing is saved" back to Import and export. Pick the account and the file; for a bank's file, say which column
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
items, stopped ones included, a line says so. The button then says how many of each
("Add 2 transactions and 2 repeating items"). A Mahnee export of some dates (its "Only
these dates" line) is read as transactions only: it adds no account (a line on one not
here says "<name> isn't an account here" and can't be ticked), changes no opening balance
and sets nothing up to repeat, and the page says so. Export then import into a fresh account, then
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
  (`?import`, going back up to Settings › Import and export), and Import, Recent imports
  and Banks it remembers on
  [components/settings/DataPage.tsx](../web/src/components/settings/DataPage.tsx).
- API: `addImport`, `addTransaction`'s `importId` and `undoImport` in
  [worker/ledger/changes.ts](../worker/ledger/changes.ts); `GET /api/imports`
  (`readImports` in [worker/ledger/imports.ts](../worker/ledger/imports.ts)).
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
- Each import that adds at least one transaction is recorded (D16): `addImport` (its id,
  the file's name, the account a bank's file went into or none for an export, how many
  transactions it added and how many of the file's transaction lines it left out) goes
  first in the same ordered changes, then each `addTransaction` with `importId`, so the
  0007 trigger always finds it; the server dates it. Recent imports
  (`GET /api/imports`, at most `MAX_RECENT_IMPORTS`, newest first, none undone) are owned
  by [ledger/ledger.ts](../web/src/ledger/ledger.ts) (`useImports()`, `applyToImports`,
  `fetchImports`): what's recorded or undone here shows at once on top of the server's
  list, a device copy opens offline, and it's fetched again once nothing waits.
- Undo asks first ('Undo maybank-oct.csv?', "Its 38 entries are deleted, on every device.
  Accounts and categories it added stay.", "Undo import" / "Keep it"), then sends
  `undoImport` through the outbox like any change: the server deletes every transaction
  that names that import, wherever it is now (moved or edited since), and marks it undone,
  all in the batch; one undone already changes nothing more, and the receipt counts a
  resent one once. The row goes at once; the entries leave balances and lists when the
  server has done it (at once online, offline once back), since a device can't know every
  entry an import added. Accounts, categories, opening balances and repeating items an
  import added stay. An entry naming an import not the person's own, or none, is refused
  404 "Import not found", one undone 409 "That import was undone".
- Banks it remembers lists this device's column layouts for the signed-in person by
  account, each with Forget (`rememberedMappings`, `forgetMapping`).

**Tests.** [shared/csv-import.test.ts](../shared/csv-import.test.ts) (cells, days,
amounts, bank rows and what's wrong with them, export lines read back as written,
repeating lines and what's wrong with them, the duplicate rule, the limit), [Import.test.tsx](../web/src/components/import/Import.test.tsx)
(the steps, heading and counts, a computer's tabs and Cancel, recording an import and its
entries, offline in order, nothing recorded without an entry, a file of some dates as
transactions only, mapping and remembering it, money in and out, already saved and ticked anyway, the
same file twice, categories from payees, shortened text, 5,001 refused, 5,000 on a phone
with a lost answer counted once, offline, the export round trip, opening balances, an
export picked before the accounts load; repeating items: the round trip, a next due kept
or moved on by the person's own day, what counts as already there, two alike, what each
names, the limit of 200, a line it can't read; desktop and phone),
[settings/DataPage.test.tsx](../web/src/components/settings/DataPage.test.tsx) (recent
imports, Undo asked, kept and confirmed, offline and resent once, an import undone before
it was sent, the stand-in's refusals, Banks it remembers and Forget, choosing and dropping
a file), and the payee categories and recent imports cases in
[worker/test/api.test.ts](../worker/test/api.test.ts) (recording, listing, every refusal,
the same id for two people, Undo exactly and once).

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
  Install the app on Settings › My account
  ([components/common/use-install-action.tsx](../web/src/components/common/use-install-action.tsx),
  the steps by hand in [components/common/InstallApp.tsx](../web/src/components/common/InstallApp.tsx)).

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
(on a computer, Accounts with that account beside the list) keeps the places, with
Accounts marked; Settings, its sections and Import cover them,
and so does the first run, before there is an account, and a phone or tablet selecting on
Activity (`&select`), and a category's page under Plan on a phone or tablet
(`?plan&category=<id>`), which then have no freshness strip either. Plan is budgets and
where the money went (see Plan); its Scheduled half is every scheduled item (see
Scheduled). Home is at a glance (see Home at a glance).

**Addresses.** Later pieces link to these; each is a query string read by `readRoute`.

| Page                      | Address                                                                                                                                  | Now                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home                      | none, or `?month=2026-10` for an earlier month                                                                                           | live                                                                                                                                                            |
| Activity                  | `?activity`, with `&q=`, `&account=`, `&category=`, `&kind=`, `&scheduled`, `&from=`, `&to=`, `&day=2026-11-10`, `&dates=all`, `&select` | live; see below                                                                                                                                                 |
| Plan                      | `?plan`, with `&month=2026-10`                                                                                                           | live                                                                                                                                                            |
| Scheduled                 | `?plan=scheduled`                                                                                                                        | Plan's other half: every scheduled item, with Schedule something; see Scheduled                                                                                 |
| A category over 12 months | `?plan&category=<id>` (after `&month=` for an earlier month); `expenses` or `income` for all of them                                     | live; a page on phones and tablets, beside the table on a computer                                                                                              |
| Accounts                  | `?accounts`                                                                                                                              | live                                                                                                                                                            |
| One account               | `?account=<id>`                                                                                                                          | live; on a computer, Accounts with it beside the list                                                                                                           |
| Settings                  | `?settings`, and `?settings=account`, `money`, `adding`, `look`, `budgets`, `categories`, `data`                                         | live; Budgets and reminders' reminder rows are read-only until reminders (piece 16); `&setting=<key>` opens one in view; a computer's `?settings` is My account |
| Importing a file          | `?import`                                                                                                                                | live, opened from `?settings=data`                                                                                                                              |

Activity's filters (components/activity/address.ts): plain `?activity` is this month on
every account. `&q=` is the words; `&account=` an account (transfers into it too);
`&category=` a category (a top-level one with its subcategories); `&kind=` one of
`expense`, `income`, `transfer`, or two joined by a comma (`expense,income` is "Expenses and
income"); `&scheduled` only entries from Scheduled; `&day=` one day (Home's calendar: `?activity&day=2026-11-10`); `&from=` and
`&to=` days, both included, either alone ("Since Oct 1"); `&dates=all` every month; and
`&select` opens a phone or tablet selecting (Tidy up:
`?activity&category=<OTHER_EXPENSE_ID>&from=<tidyUp.from>&select`). A day wins over from
and to, and those over all months. A part that makes no sense (a day that isn't one, a
kind not known, an account or category the person doesn't have) is dropped, and the
address is put right in place; each filter is written back in that order, only when not
at its default.

A page named first wins over the parameters after it: `?activity&account=<id>` is
Activity, and `account` is its filter. Older addresses are replaced in place, keeping the
rest of the address: `?search` becomes `?activity`, `?categories` becomes
`?settings=categories`. So `search` and `categories` are reserved: no page or parameter
may use either name for anything else (Activity's filters included).

**Owner.**

- [hooks/useRoute.ts](../web/src/hooks/useRoute.ts): pages come from the query string
  through `navigate()` (`{ replace: true }` for the places). A fresh start at the app's own
  address (no address, no earlier start in this tab) opens on the place chosen in Look and
  start (`openStartScreen`, owner decision D15): Home, Activity or Plan. The choice is kept
  on the device for that account alone (`START_SCREEN_KEY`, { email, start }, gone on Sign
  out or when someone else signs in), so it is used only while that account is the one last
  signed in here; once the profile says who's signed in, `rememberStartScreen` keeps theirs,
  and a start that opened on another's choice (or none kept yet), still where it opened,
  goes to theirs. A reload or a link keeps its own address. A
  page opened from another goes back up with `goUp`: Back when it came from there, else
  straight there in its own place. `closeSettings` goes back to the page Settings was
  opened over, or Home. Each page the app gains adds its view to `Route`, and `placeOf`
  says which place it belongs to.
- [hooks/useShortcuts.ts](../web/src/hooks/useShortcuts.ts): keys on a keyboard. N opens a
  new entry and / puts the cursor in the page's search, or opens Activity's (on pages with
  the places); Esc closes Settings (on a computer from any section; on phones and tablets
  it goes up from a section to the index); Ctrl K finds Settings' search on a computer; on a computer, Activity
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
