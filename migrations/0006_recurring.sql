-- Bills and income that repeat. See docs/erd.md for how the tables relate, and
-- shared/recurring.ts for how each falls due.

-- One row per repeating item: what Log it records (as a transaction would hold it) and
-- when it's next due. Nothing is recorded until the person logs an occurrence. Stopped
-- (archived), never deleted. Keyed by the person first, like accounts, and its accounts
-- and category are looked up among the same person's only.
CREATE TABLE recurring (
  email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
  account_id TEXT NOT NULL,
  -- Where a transfer goes; null for spending and income
  to_account_id TEXT CHECK (to_account_id IS NULL OR kind = 'transfer'),
  -- Whole cents, above zero and at most MAX_TRANSACTION_CENTS
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000),
  -- Of the matching kind; none only for a transfer
  category_id TEXT CHECK ((category_id IS NULL) = (kind = 'transfer')),
  payee TEXT CHECK (payee IS NULL OR length(payee) BETWEEN 1 AND 80),
  schedule TEXT NOT NULL CHECK (schedule IN ('monthly', 'weekly')),
  -- 1 to 31 of a month (its last day when shorter), or 1 (Monday) to 7 (Sunday)
  day INTEGER NOT NULL
    CHECK (day >= 1 AND day <= CASE schedule WHEN 'monthly' THEN 31 ELSE 7 END),
  -- The day it was set up from, and the next occurrence not yet logged or skipped
  start_date TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  next_due TEXT NOT NULL CHECK (next_due GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Set up in this order; NULL past the person's limit, which NOT NULL refuses
  position INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (email, id),
  FOREIGN KEY (email, account_id) REFERENCES accounts (email, id),
  FOREIGN KEY (email, to_account_id) REFERENCES accounts (email, id),
  FOREIGN KEY (email, category_id) REFERENCES categories (email, id)
);
