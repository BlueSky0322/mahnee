-- How much an import changed its account's opening balance, so the rows it added from before
-- tracking began don't count twice; 0 for none. Undo takes it back by as much, so a change
-- made by hand since stays.
ALTER TABLE imports ADD COLUMN opening_change_cents INTEGER NOT NULL DEFAULT 0
  CHECK (opening_change_cents BETWEEN -2000000000 AND 2000000000);

-- What that change was before the home currency changed, as an opening balance keeps what it
-- was typed as: converted with the opening balance at the same rate, so Undo after a change of
-- currency puts the opening balance back exactly where it would be on its own. Both NULL for a
-- change in the home currency.
ALTER TABLE imports ADD COLUMN opening_change_currency TEXT
  CHECK (opening_change_currency IS NULL OR (length(opening_change_currency) = 3
    AND NOT opening_change_currency GLOB '*[^A-Z]*'));
ALTER TABLE imports ADD COLUMN opening_change_typed_cents INTEGER
  CHECK ((opening_change_typed_cents IS NULL) = (opening_change_currency IS NULL)
    AND (opening_change_typed_cents IS NULL OR typeof(opening_change_typed_cents) = 'integer'));

-- Amounts worked out during a conversion take an import's opening change too. The table only
-- holds work under way: a conversion running as this is applied finds its worked-out entries
-- gone and starts over (convert.ts), as it does for any that go missing.
DROP TABLE conversion_staged;
CREATE TABLE conversion_staged (
  email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('transaction', 'account', 'budget', 'recurring', 'import')),
  key TEXT NOT NULL,
  cents INTEGER NOT NULL,
  original_currency TEXT,
  original_cents INTEGER,
  rate REAL,
  rate_source TEXT,
  rate_at INTEGER,
  PRIMARY KEY (email, kind, key)
);
