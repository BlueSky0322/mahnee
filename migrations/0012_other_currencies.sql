-- Other currencies (owner request 2026-11-19): the list Add offers after the home currency,
-- and whether Add follows where the device is. See docs/erd.md, and shared/settings.ts for
-- what each takes (each CHECK here matches it). An entry typed in one of them keeps what was
-- typed in the transactions' original_* columns (0011), so nothing else changes.

-- The person's other currencies, in their order: a JSON array of codes, at most
-- MAX_OTHER_CURRENCIES (8). Which codes is checked by the Worker (ENTRY_CURRENCIES).
ALTER TABLE user_settings ADD COLUMN other_currencies TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(other_currencies) AND json_type(other_currencies) = 'array'
    AND json_array_length(other_currencies) <= 8);

-- Whether Add opens in the currency of where the device is for the day (travel sense)
ALTER TABLE user_settings ADD COLUMN travel_sense INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(travel_sense) = 'integer' AND travel_sense IN (0, 1));
