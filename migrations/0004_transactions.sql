-- The money going out of and coming into a person's accounts. See docs/erd.md for how the
-- tables relate, and shared/ledger.ts for the rules.

-- One row per transaction: spending from an account, income into one, or (later) a
-- transfer between two. Deleted for good when a person deletes it. Keyed by the person
-- first, like accounts, and its account and category are looked up among the same
-- person's only. An amount is always above zero; the kind says which way it went.
CREATE TABLE transactions (
  email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
  account_id TEXT NOT NULL,
  -- Where a transfer goes; transfers aren't saved yet
  to_account_id TEXT CHECK (to_account_id IS NULL OR kind = 'transfer'),
  -- Whole cents, above zero and at most MAX_TRANSACTION_CENTS
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000),
  -- Top level or a subcategory, of the matching kind; none only for a transfer
  category_id TEXT CHECK ((category_id IS NULL) = (kind = 'transfer')),
  payee TEXT CHECK (payee IS NULL OR length(payee) BETWEEN 1 AND 80),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  -- The person's own calendar day, as 2026-11-05
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (email, id),
  FOREIGN KEY (email, account_id) REFERENCES accounts (email, id),
  FOREIGN KEY (email, to_account_id) REFERENCES accounts (email, id),
  FOREIGN KEY (email, category_id) REFERENCES categories (email, id)
);

-- An account's transactions, newest first, and how many it has
CREATE INDEX transactions_account
  ON transactions (email, account_id, date DESC, created_at DESC);

-- A month's transactions across every account
CREATE INDEX transactions_date ON transactions (email, date);
