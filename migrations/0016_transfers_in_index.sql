-- An account's transactions include the transfers into it. They were found by reading
-- every one of the person's transactions and sorting them, for each page; with this index
-- a page reads the account's own entries (transactions_account) and the transfers into
-- it here, each newest first, and merges them (worker/ledger/read.ts).
CREATE INDEX transactions_to_account
  ON transactions (email, to_account_id, date DESC, time DESC, created_at DESC)
  WHERE to_account_id IS NOT NULL;
