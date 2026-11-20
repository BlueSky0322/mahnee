-- How many times a home-currency conversion has started over from its first transaction
-- (found with worked-out amounts gone), kept apart from conversions.restarts, which now
-- counts only the stalls since it last moved on (worker/currency/convert.ts).
ALTER TABLE conversions ADD COLUMN start_overs INTEGER NOT NULL DEFAULT 0;
