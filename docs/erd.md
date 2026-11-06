# Data model

Mahnee keeps everything in one Cloudflare D1 (SQLite) database. Accounts come from
Cloudflare Access: there is no table of users, only rows keyed by the signed-in email.
Each schema change is a numbered file in `migrations/`.

```mermaid
erDiagram
  profiles ||--o| user_settings : "has"
  profiles ||--o{ accounts : "has"
  profiles ||--o{ categories : "has"
  categories ||--o{ categories : "has subcategories"
  profiles ||--o{ transactions : "has"
  accounts ||--o{ transactions : "holds"
  categories ||--o{ transactions : "sorts"
  profiles ||--o{ change_receipts : "has"
  categories ||--o{ budgets : "has"
  profiles ||--o{ recurring : "has"
  accounts ||--o{ recurring : "repeats on"
  categories ||--o{ recurring : "sorts"
  profiles {
    TEXT email PK
    TEXT display_name "null, or 1 to 32 characters"
    INTEGER created_at "ms"
    INTEGER updated_at "ms"
  }
  user_settings {
    TEXT email PK "and FK to profiles"
    TEXT theme "dark, light or auto"
    TEXT accent "blurple, blue, teal, green, amber or rose"
    TEXT rate_preference "wise or ecb"
    INTEGER updated_at "ms"
  }
  accounts {
    TEXT email PK "and FK to profiles"
    TEXT id PK "16 hex characters, made by the app"
    TEXT name "1 to 40 characters"
    TEXT kind "cash, bank, card or ewallet"
    TEXT currency "MYR for now"
    INTEGER opening_cents "within 1,000,000,000 either way"
    INTEGER position "first at 0"
    INTEGER archived "0 or 1"
    INTEGER created_at "ms"
    INTEGER updated_at "ms"
  }
  categories {
    TEXT email PK "and FK to profiles"
    TEXT id PK "16 hex characters, made by the app or a default's"
    TEXT name "1 to 40 characters"
    TEXT kind "expense or income"
    TEXT parent_id "null at the top level; FK with email to categories"
    INTEGER position "among its siblings, first at 0"
    INTEGER archived "0 or 1"
    INTEGER created_at "ms"
    INTEGER updated_at "ms"
  }
  transactions {
    TEXT email PK "and FK to profiles"
    TEXT id PK "16 hex characters, made by the app"
    TEXT kind "expense, income or transfer"
    TEXT account_id "FK with email to accounts; a transfer's from"
    TEXT to_account_id "FK with email to accounts; a transfer's to, else null"
    INTEGER amount_cents "1 to 1,000,000,000"
    TEXT category_id "FK with email to categories; null only for a transfer"
    TEXT payee "null, or 1 to 80 characters"
    TEXT note "null, or 1 to 500 characters"
    TEXT date "the person's own day, as 2026-11-05"
    INTEGER created_at "ms"
    INTEGER updated_at "ms"
  }
  budgets {
    TEXT email PK "and FK to profiles"
    TEXT category_id PK "FK with email to categories; top-level spending"
    TEXT from_month PK "the month it applies from, as 2026-11"
    INTEGER amount_cents "null for none from this month, or 1 to 1,000,000,000"
    INTEGER carry_over "0 or 1"
    INTEGER updated_at "ms"
  }
  recurring {
    TEXT email PK "and FK to profiles"
    TEXT id PK "16 hex characters, made by the app"
    TEXT kind "expense, income or transfer"
    TEXT account_id "FK with email to accounts; a transfer's from"
    TEXT to_account_id "FK with email to accounts; a transfer's to, else null"
    INTEGER amount_cents "1 to 1,000,000,000"
    TEXT category_id "FK with email to categories; null only for a transfer"
    TEXT payee "null, or 1 to 80 characters"
    TEXT schedule "monthly or weekly"
    INTEGER day "1 to 31 of a month, or 1 (Monday) to 7"
    TEXT start_date "the day it was set up from"
    TEXT next_due "the next occurrence not logged or skipped"
    INTEGER position "set up in this order, first at 0"
    INTEGER archived "0 or 1: stopped repeating"
    INTEGER created_at "ms"
    INTEGER updated_at "ms"
  }
  change_receipts {
    TEXT email PK "and FK to profiles"
    TEXT change_id PK "the app's id for the change"
    TEXT fingerprint "SHA-256 of the change as sent"
    INTEGER saved_at "ms"
  }
```

## Tables

- **`profiles`**: one row per account, made the first time it saves anything. Until
  then the API answers with the defaults, so an account that has only signed in has no
  rows at all.
- **`user_settings`**: the account's private preferences, which follow it between
  devices. A first row is written with every setting, the changed ones and the defaults
  from `DEFAULT_SETTINGS` in `shared/api.ts` for the rest, so the defaults live in one
  place; the columns' own defaults are only a fallback. Deleting a profile deletes its
  settings.
- **`accounts`**: where a person's money is, or what they owe on a card (a card's
  opening balance is below zero). Keyed by email and then id, so an id is only looked up
  among the person's own. Archived, never deleted; at most 50 per person, archived ones
  included. A balance is the opening balance plus what's come in and gone out, worked out
  when read and never stored. Saving the first one makes the profile row.
- **`categories`**: what spending and income are sorted into, one level deep: a
  top-level category (`parent_id` NULL) can have subcategories, each the same kind as its
  parent and with none of its own. `(email, parent_id)` refers to `(email, id)`, so a
  parent is always one of the person's own, and triggers refuse a parent that isn't a
  top-level category of the same kind, or a category with subcategories going under
  another. Keyed by email and then id, like accounts. Archived, never deleted; at most
  200 per person and 50 under one category, archived ones included. A position orders a
  category among its siblings (same kind and parent). The defaults (`DEFAULT_CATEGORIES`
  in `shared/categories.ts`, the same ids for everyone) are saved with a person's first
  change of any kind; until then there are no rows and the app shows the defaults.
- **`transactions`**: money spent from an account (`expense`) or that came into one
  (`income`), in a category of the same kind, top level or a subcategory; or money moved
  from one of the person's accounts (`account_id`) to another (`to_account_id`), a
  `transfer`, with no category, which is never spending or income. The amount is
  always above zero; the kind says which way it went. `date` is the day on the person's
  own calendar, from 2000 to tomorrow in UTC. Keyed by email and then id, and its
  accounts and category are foreign keys with the email, so they're always the person's
  own. At most 100,000 on one account, a transfer counted on both, checked again as each
  row is saved. Deleted for good when
  the person deletes one (Undo adds it again with the same id). An account's balance is
  its opening balance plus its income and transfers in, less its spending and transfers
  out, summed when read. Indexed for an account's newest first (by `account_id`; the
  transfers into an account are found by scanning the person's rows) and for a month
  across accounts.
- **`budgets`**: a monthly amount a person means to spend in a top-level spending
  category, its subcategories counting toward it. One row per category and month it was
  set in (`from_month`): the amount applies from that month on, until a later row, so
  earlier months keep what they had; setting one removes the category's rows for later
  months. A NULL amount takes the budget away from that month on. With `carry_over`, the
  month before's leftover (or overspending) is added, worked out when read
  (`shared/budgets.ts`), never stored. `(email, category_id)` refers to the person's
  categories, and a trigger refuses a row on anything but one of their top-level spending
  categories (archived ones allowed, so a budget can be taken away from one). A budget on
  a category later moved under another is kept but set aside until it's back at the top
  level.
- **`recurring`**: bills and income that repeat, monthly on a day of the month (the
  month's last day when it's shorter) or weekly on a weekday (1 Monday to 7 Sunday), with
  what Log it records each time, written like a transaction's columns and checked the same
  way. Nothing is recorded until an occurrence is logged: logging saves its transaction and
  moves `next_due` on in one batch, only from the occurrence it names (`next_due` is NULL
  otherwise, which the table refuses), so it's never recorded twice; skipping moves it on
  alone. Stopped (archived), never deleted; at most 200 per person, stopped ones included,
  checked again as each row is saved. Keyed by email and then id, its accounts and category
  foreign keys with the email. Read with the accounts (`GET /api/accounts`, only for someone
  who has any).
- **`change_receipts`**: one per change the app saved through `POST /api/changes`, by
  the id the app gave it, with the change's fingerprint, saved in the same batch as the
  change. A change sent again counts once; the same id with a different change is
  refused. Each person's receipts older than 90 days are let go when they next save.

## Conventions

- Times are whole milliseconds since 1970 (`*_at`).
- Money is whole cents in `*_cents` columns (see Money in `AGENTS.md`).
- Every row belongs to one account, and every query is scoped by it.
