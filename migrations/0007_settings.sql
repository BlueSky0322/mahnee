-- The redesign's settings, a time on transactions, and a record of each import. See
-- docs/erd.md for how the tables relate, and shared/settings.ts for what each setting
-- takes (each CHECK here matches it).
--
-- user_settings is rebuilt, since SQLite can't change a CHECK: every row is copied with
-- its theme, rate source and time kept, and its accent mapped to one of the redesign's
-- five (green stays green; every other accent there was becomes cobalt). The new
-- settings start at the design's defaults, the same as DEFAULT_SETTINGS in shared/api.ts.
-- Nothing refers to user_settings, so dropping the old table breaks no foreign key.

CREATE TABLE user_settings_new (
  email TEXT PRIMARY KEY REFERENCES profiles(email) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'auto' CHECK (theme IN ('dark', 'light', 'auto')),
  accent TEXT NOT NULL DEFAULT 'cobalt'
    CHECK (accent IN ('cobalt', 'green', 'plum', 'rust', 'graphite')),
  -- Where exchange rates come from first: Wise's live rate, or the ECB's daily one
  rate_preference TEXT NOT NULL DEFAULT 'wise' CHECK (rate_preference IN ('wise', 'ecb')),
  -- The first day of a week on Home's calendar
  week_start TEXT NOT NULL DEFAULT 'monday' CHECK (week_start IN ('monday', 'sunday')),
  -- When a month starts: on a day of the month, or on the day a scheduled pay is due
  month_start_mode TEXT NOT NULL DEFAULT 'date'
    CHECK (month_start_mode IN ('date', 'payday')),
  -- 1 to 28, or 31 for the last day of the month (a shorter month's last day)
  month_start_day INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(month_start_day) = 'integer'
      AND (month_start_day BETWEEN 1 AND 28 OR month_start_day = 31)),
  -- The scheduled pay that payday follows, kept when the month goes back to a date
  month_start_pay_id TEXT,
  -- The page the app opens on
  start_screen TEXT NOT NULL DEFAULT 'home'
    CHECK (start_screen IN ('home', 'activity', 'plan')),
  -- Home with the month end and what needs the person only, or everything
  home_density TEXT NOT NULL DEFAULT 'everything'
    CHECK (home_density IN ('essentials', 'everything')),
  -- What Add asks for first
  start_with TEXT NOT NULL DEFAULT 'amount' CHECK (start_with IN ('amount', 'category')),
  -- The account Add starts on; NULL for the last one used
  default_account_id TEXT,
  suggest_as_you_type INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(suggest_as_you_type) = 'integer' AND suggest_as_you_type IN (0, 1)),
  -- Whether Add asks for a time of day
  ask_for_time INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(ask_for_time) = 'integer' AND ask_for_time IN (0, 1)),
  -- Spending shown in ink or in red (income is always green)
  expense_colour TEXT NOT NULL DEFAULT 'ink' CHECK (expense_colour IN ('ink', 'red')),
  -- Whether a new budget carries over
  carry_over_default INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(carry_over_default) = 'integer' AND carry_over_default IN (0, 1)),
  -- A reminder on days with nothing added, at a time of the person's own day
  daily_reminder INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(daily_reminder) = 'integer' AND daily_reminder IN (0, 1)),
  reminder_time TEXT NOT NULL DEFAULT '21:00'
    CHECK (reminder_time GLOB '[0-2][0-9]:[0-5][0-9]' AND reminder_time <= '23:59'),
  -- How many days before a scheduled entry to remind; NULL for not at all
  scheduled_reminder_days INTEGER DEFAULT 1
    CHECK (scheduled_reminder_days IS NULL OR (typeof(scheduled_reminder_days) = 'integer'
      AND scheduled_reminder_days BETWEEN 1 AND 7)),
  -- The person's time zone, as their device names it (Asia/Kuala_Lumpur); NULL until sent
  time_zone TEXT
    CHECK (time_zone IS NULL OR (length(time_zone) BETWEEN 1 AND 64
      AND time_zone GLOB '[A-Za-z]*' AND NOT time_zone GLOB '*[^A-Za-z0-9_+/-]*')),
  updated_at INTEGER NOT NULL,
  -- Payday needs its pay
  CHECK (month_start_mode = 'date' OR month_start_pay_id IS NOT NULL),
  FOREIGN KEY (email, month_start_pay_id) REFERENCES recurring (email, id),
  FOREIGN KEY (email, default_account_id) REFERENCES accounts (email, id)
);

INSERT INTO user_settings_new (email, theme, accent, rate_preference, updated_at)
SELECT email, theme, CASE accent WHEN 'green' THEN 'green' ELSE 'cobalt' END,
  rate_preference, updated_at
FROM user_settings;

DROP TABLE user_settings;
ALTER TABLE user_settings_new RENAME TO user_settings;

-- One row per file imported, so every device can list recent imports and undo one. Its
-- transactions name it in import_id. Keyed by the person first, like accounts.
CREATE TABLE imports (
  email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(id) = 16 AND NOT id GLOB '*[^0-9a-f]*'),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  -- The account a bank's file went into; NULL for a Mahnee export, which names its own
  account_id TEXT,
  -- How many rows were added and left out, each at most MAX_IMPORT_ROWS
  added_count INTEGER NOT NULL CHECK (added_count BETWEEN 0 AND 5000),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count BETWEEN 0 AND 5000),
  created_at INTEGER NOT NULL,
  -- When it was undone, if it was
  undone_at INTEGER,
  PRIMARY KEY (email, id),
  FOREIGN KEY (email, account_id) REFERENCES accounts (email, id)
);

-- Recent imports, newest first
CREATE INDEX imports_created ON imports (email, created_at DESC);

-- The time of day a transaction was made, on the person's own clock as 20:12; NULL when
-- the person doesn't add times, as before
ALTER TABLE transactions ADD COLUMN time TEXT
  CHECK (time IS NULL OR (time GLOB '[0-2][0-9]:[0-5][0-9]' AND time <= '23:59'));

-- The import a transaction came in with. SQLite can't add a foreign key on two columns to
-- a table, so the triggers below hold it to one of the person's own imports.
ALTER TABLE transactions ADD COLUMN import_id TEXT
  CHECK (import_id IS NULL OR (length(import_id) = 16 AND NOT import_id GLOB '*[^0-9a-f]*'));

-- An import's transactions, found to undo it
CREATE INDEX transactions_import ON transactions (email, import_id) WHERE import_id IS NOT NULL;

-- An account's transactions, newest first within a day by their time too
DROP INDEX transactions_account;
CREATE INDEX transactions_account
  ON transactions (email, account_id, date DESC, time DESC, created_at DESC);

CREATE TRIGGER transactions_import_on_add
BEFORE INSERT ON transactions
WHEN NEW.import_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM imports i WHERE i.email = NEW.email AND i.id = NEW.import_id
)
BEGIN
  SELECT RAISE(ABORT, 'CONSTRAINT: a transaction comes from one of its own imports');
END;

CREATE TRIGGER transactions_import_on_change
BEFORE UPDATE OF import_id ON transactions
WHEN NEW.import_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM imports i WHERE i.email = NEW.email AND i.id = NEW.import_id
)
BEGIN
  SELECT RAISE(ABORT, 'CONSTRAINT: a transaction comes from one of its own imports');
END;

-- An import let go keeps its transactions, naming no import
CREATE TRIGGER imports_on_delete
AFTER DELETE ON imports
BEGIN
  UPDATE transactions SET import_id = NULL
  WHERE email = OLD.email AND import_id = OLD.id;
END;
