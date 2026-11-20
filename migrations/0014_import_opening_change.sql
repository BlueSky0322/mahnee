-- How much an import changed its account's opening balance, so the rows it added from before
-- tracking began don't count twice; 0 for none. Undo takes it back by as much, so a change
-- made by hand since stays.
ALTER TABLE imports ADD COLUMN opening_change_cents INTEGER NOT NULL DEFAULT 0
  CHECK (opening_change_cents BETWEEN -2000000000 AND 2000000000);
