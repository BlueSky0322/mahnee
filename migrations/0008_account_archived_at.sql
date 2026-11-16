-- The day an account was archived, which Accounts shows ("E-wallet · archived Aug 14"). See
-- docs/erd.md.
--
-- When it was archived, in ms, as the server saved the change; NULL while it's running.
-- Accounts archived before this have none: updated_at moves with any edit (a rename too),
-- so it isn't taken for one, and those say only "archived".
ALTER TABLE accounts ADD COLUMN archived_at INTEGER
  CHECK (archived_at IS NULL OR (archived = 1 AND typeof(archived_at) = 'integer'));
