-- A person's accounts, and receipts for the changes the app has saved. See docs/erd.md
-- for how the tables relate.

-- Where a person's money is, or what they owe on a card. Archived, never deleted. Keyed
-- by the person first, so an id is only ever looked up among their own accounts, and
-- another person's never collides with or reveals one of theirs.
CREATE TABLE accounts (
  email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  kind TEXT NOT NULL CHECK (kind IN ('cash', 'bank', 'card', 'ewallet')),
  currency TEXT NOT NULL,
  -- What it held when tracking began, in whole cents; below zero when owed
  opening_cents INTEGER NOT NULL
    CHECK (opening_cents BETWEEN -1000000000 AND 1000000000),
  -- Its place in the person's list, first at 0
  position INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (email, id)
);

-- The app's changes, by the id it gave each one: one sent again (its answer lost on the
-- way back) is answered as saved rather than applied twice. fingerprint is the change
-- as sent, so the same id with a different change is refused. Kept for 90 days.
CREATE TABLE change_receipts (
  email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  change_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (email, change_id)
);

-- Letting go of old receipts looks them up by age
CREATE INDEX change_receipts_saved_at ON change_receipts (email, saved_at);
