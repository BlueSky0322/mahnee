-- Reminders by web push (owner decision D6). See docs/erd.md for how the tables relate,
-- and worker/push/reminders.ts for the cron's job that sends them.

-- One row per device that gets reminders: the browser's push subscription, kept for the
-- account that subscribed it. The endpoint is one browser's own address at its push
-- service, so it is the key: a device subscribed by someone else moves to them, and one
-- device reminds one account.
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY CHECK (length(endpoint) BETWEEN 1 AND 2048),
  email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  -- The browser's public key (P-256, uncompressed) and its auth secret, base64url: what the
  -- message is encrypted to
  p256dh TEXT NOT NULL CHECK (length(p256dh) = 87),
  auth TEXT NOT NULL CHECK (length(auth) = 22),
  created_at INTEGER NOT NULL,
  -- The person's own day it was last reminded on (2026-11-18), so it is reminded once a day
  reminded_on TEXT
    CHECK (reminded_on IS NULL OR reminded_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- When its push service last took a message (ms)
  last_ok_at INTEGER
);

-- A person's devices, newest first
CREATE INDEX push_subscriptions_email ON push_subscriptions (email, created_at DESC);

-- Whether anything was added during a person's day, for the daily reminder
CREATE INDEX transactions_created ON transactions (email, created_at);
