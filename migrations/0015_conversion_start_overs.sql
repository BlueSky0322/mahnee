-- How many times a home-currency conversion has started over from its first transaction
-- (found with worked-out amounts gone), kept apart from conversions.restarts, which now
-- counts only the stalls since it last moved on (worker/currency/convert.ts).
ALTER TABLE conversions ADD COLUMN start_overs INTEGER NOT NULL DEFAULT 0;

-- The calendar day an entry's rate is from, when it's an earlier day's (2026-11-12), so the
-- app says that day wherever the person is; NULL for a live rate, timed when it was fetched.
-- Kept through a conversion by conversion_staged.
ALTER TABLE transactions ADD COLUMN rate_day TEXT
  CHECK (rate_day IS NULL OR (original_currency IS NOT NULL
    AND rate_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'));
ALTER TABLE conversion_staged ADD COLUMN rate_day TEXT;

-- Until now an earlier day's rate was told only by its time, noon UTC on its day
UPDATE transactions SET rate_day = date(rate_at / 1000, 'unixepoch')
WHERE original_currency IS NOT NULL AND rate_at % 86400000 = 43200000;

-- Changing an entry's amount lets go of what it was typed as, its rate's day too
DROP TRIGGER transactions_typed_again;
CREATE TRIGGER transactions_typed_again
AFTER UPDATE OF amount_cents ON transactions
WHEN OLD.amount_cents IS NOT NEW.amount_cents AND NEW.original_currency IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM conversions c WHERE c.email = NEW.email AND c.phase = 'converting'
)
BEGIN
  UPDATE transactions SET original_currency = NULL, original_cents = NULL, rate = NULL,
    rate_source = NULL, rate_at = NULL, rate_day = NULL
  WHERE email = NEW.email AND id = NEW.id;
END;
