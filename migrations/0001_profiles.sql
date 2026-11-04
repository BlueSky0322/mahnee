-- The accounts that have signed in and saved something, and their settings. See
-- docs/erd.md for how the tables relate.

-- One row per account, made the first time they save anything
CREATE TABLE profiles (
  email TEXT PRIMARY KEY,
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 32),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Private preferences that follow the account between devices
CREATE TABLE user_settings (
  email TEXT PRIMARY KEY REFERENCES profiles(email) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'auto' CHECK (theme IN ('dark', 'light', 'auto')),
  accent TEXT NOT NULL DEFAULT 'blurple'
    CHECK (accent IN ('blurple', 'blue', 'teal', 'green', 'amber', 'rose')),
  -- Where exchange rates come from first: Wise's live rate, or the ECB's daily one
  rate_preference TEXT NOT NULL DEFAULT 'wise' CHECK (rate_preference IN ('wise', 'ecb')),
  updated_at INTEGER NOT NULL
);
