-- Scheduled (owner decisions D8 and D19). See docs/erd.md for how the tables relate, and
-- worker/ledger/post-scheduled.ts for the nightly job that adds each item on its day.

-- Whether an item's amount changes from time to time ("It changes"): what's added is marked
-- for the person to check
ALTER TABLE recurring ADD COLUMN amount_varies INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(amount_varies) = 'integer' AND amount_varies IN (0, 1));

-- Whether the item waits for Log it or Skip on Home rather than being added on its day: one
-- overdue when saved, moved back or brought back, as nothing is guessed about a bill that
-- may not have been paid
ALTER TABLE recurring ADD COLUMN ask_first INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(ask_first) = 'integer' AND ask_first IN (0, 1));

-- Items already overdue on the day this runs (its own date, UTC) keep asking, one last time;
-- every other one is added on its day from now on
UPDATE recurring SET ask_first = 1 WHERE archived = 0 AND next_due <= date('now');

-- The scheduled occurrence a transaction came from (the item and the day it was due), and
-- whether its amount is still for the person to check. SQLite can't add a foreign key on
-- two columns to a table, so the triggers below hold the item to one of the person's own.
ALTER TABLE transactions ADD COLUMN recurring_id TEXT
  CHECK (recurring_id IS NULL OR (length(recurring_id) = 16 AND NOT recurring_id GLOB '*[^0-9a-f]*'));
ALTER TABLE transactions ADD COLUMN recurring_due TEXT
  CHECK ((recurring_due IS NULL) = (recurring_id IS NULL) AND (recurring_due IS NULL
    OR recurring_due GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'));
ALTER TABLE transactions ADD COLUMN to_check INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(to_check) = 'integer' AND to_check IN (0, 1)
    AND (to_check = 0 OR recurring_id IS NOT NULL));

CREATE TRIGGER transactions_recurring_on_add
BEFORE INSERT ON transactions
WHEN NEW.recurring_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM recurring r WHERE r.email = NEW.email AND r.id = NEW.recurring_id
)
BEGIN
  SELECT RAISE(ABORT, 'CONSTRAINT: a transaction comes from one of its own scheduled items');
END;

CREATE TRIGGER transactions_recurring_on_change
BEFORE UPDATE OF recurring_id ON transactions
WHEN NEW.recurring_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM recurring r WHERE r.email = NEW.email AND r.id = NEW.recurring_id
)
BEGIN
  SELECT RAISE(ABORT, 'CONSTRAINT: a transaction comes from one of its own scheduled items');
END;
