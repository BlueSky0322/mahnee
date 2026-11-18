-- The home currency (owner decisions D2 to D5). See docs/erd.md for how the tables relate,
-- and worker/currency/convert.ts for converting every amount when it changes.

-- The currency every amount is kept and shown in: one the ECB publishes (HOME_CURRENCIES in
-- shared/rates.ts), so each can be converted at its own day's rate. Everyone so far is in MYR.
ALTER TABLE user_settings ADD COLUMN currency TEXT NOT NULL DEFAULT 'MYR'
  CHECK (currency IN (
    'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR',
    'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON',
    'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR'
  ));

-- A change of home currency while its amounts are converted (phase converting), or the last
-- one refused, naming the limit an amount would have gone past, until the next change. While
-- one converts, the person's writes wait. after_date and after_id are how far through the
-- transactions it has got, by day and then id.
CREATE TABLE conversions (
  email TEXT PRIMARY KEY REFERENCES profiles(email) ON DELETE CASCADE,
  from_currency TEXT NOT NULL CHECK (length(from_currency) = 3),
  to_currency TEXT NOT NULL CHECK (length(to_currency) = 3),
  since INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('converting', 'refused')),
  after_date TEXT NOT NULL DEFAULT '',
  after_id TEXT NOT NULL DEFAULT '',
  -- When it last moved on, so one that stopped (the queue gave up) is started again
  touched_at INTEGER NOT NULL,
  refused TEXT CHECK (refused IS NULL OR refused IN ('amount', 'opening', 'budget', 'scheduled')),
  CHECK ((phase = 'refused') = (refused IS NOT NULL))
);

-- Each amount worked out in the new currency while a conversion goes through them, swapped in
-- all together once every one fits (so a refusal changes nothing, and amounts never show in
-- two currencies at once), then let go. key: a transaction's, account's or scheduled item's
-- id, or a budget's category id and month as id/2026-11.
CREATE TABLE conversion_staged (
  email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('transaction', 'account', 'budget', 'recurring')),
  key TEXT NOT NULL,
  cents INTEGER NOT NULL,
  original_currency TEXT,
  original_cents INTEGER,
  rate REAL,
  rate_source TEXT,
  rate_at INTEGER,
  PRIMARY KEY (email, kind, key)
);

-- What each amount was before it was converted: the currency it was typed in, the amount
-- typed (whole cents) and the rate used (from which service, and for when). All NULL for an
-- amount typed in the home currency. Changing the amount itself (outside a conversion)
-- makes it typed in the home currency, so the triggers let go of what it was.
ALTER TABLE transactions ADD COLUMN original_currency TEXT
  CHECK (original_currency IS NULL OR (length(original_currency) = 3
    AND NOT original_currency GLOB '*[^A-Z]*'));
ALTER TABLE transactions ADD COLUMN original_cents INTEGER
  CHECK ((original_cents IS NULL) = (original_currency IS NULL)
    AND (original_cents IS NULL OR typeof(original_cents) = 'integer'));
ALTER TABLE transactions ADD COLUMN rate REAL
  CHECK ((rate IS NULL) = (original_currency IS NULL) AND (rate IS NULL OR rate > 0));
ALTER TABLE transactions ADD COLUMN rate_source TEXT
  CHECK ((rate_source IS NULL) = (original_currency IS NULL)
    AND (rate_source IS NULL OR rate_source IN ('wise', 'frankfurter')));
ALTER TABLE transactions ADD COLUMN rate_at INTEGER
  CHECK ((rate_at IS NULL) = (original_currency IS NULL));

CREATE TRIGGER transactions_typed_again
AFTER UPDATE OF amount_cents ON transactions
WHEN OLD.amount_cents IS NOT NEW.amount_cents AND NEW.original_currency IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM conversions c WHERE c.email = NEW.email AND c.phase = 'converting'
)
BEGIN
  UPDATE transactions SET original_currency = NULL, original_cents = NULL, rate = NULL,
    rate_source = NULL, rate_at = NULL
  WHERE email = NEW.email AND id = NEW.id;
END;

ALTER TABLE accounts ADD COLUMN original_currency TEXT
  CHECK (original_currency IS NULL OR (length(original_currency) = 3
    AND NOT original_currency GLOB '*[^A-Z]*'));
ALTER TABLE accounts ADD COLUMN original_cents INTEGER
  CHECK ((original_cents IS NULL) = (original_currency IS NULL)
    AND (original_cents IS NULL OR typeof(original_cents) = 'integer'));
ALTER TABLE accounts ADD COLUMN rate REAL
  CHECK ((rate IS NULL) = (original_currency IS NULL) AND (rate IS NULL OR rate > 0));
ALTER TABLE accounts ADD COLUMN rate_source TEXT
  CHECK ((rate_source IS NULL) = (original_currency IS NULL)
    AND (rate_source IS NULL OR rate_source IN ('wise', 'frankfurter')));
ALTER TABLE accounts ADD COLUMN rate_at INTEGER
  CHECK ((rate_at IS NULL) = (original_currency IS NULL));

CREATE TRIGGER accounts_typed_again
AFTER UPDATE OF opening_cents ON accounts
WHEN OLD.opening_cents IS NOT NEW.opening_cents AND NEW.original_currency IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM conversions c WHERE c.email = NEW.email AND c.phase = 'converting'
)
BEGIN
  UPDATE accounts SET original_currency = NULL, original_cents = NULL, rate = NULL,
    rate_source = NULL, rate_at = NULL
  WHERE email = NEW.email AND id = NEW.id;
END;

ALTER TABLE budgets ADD COLUMN original_currency TEXT
  CHECK (original_currency IS NULL OR (length(original_currency) = 3
    AND NOT original_currency GLOB '*[^A-Z]*'));
ALTER TABLE budgets ADD COLUMN original_cents INTEGER
  CHECK ((original_cents IS NULL) = (original_currency IS NULL)
    AND (original_cents IS NULL OR typeof(original_cents) = 'integer'));
ALTER TABLE budgets ADD COLUMN rate REAL
  CHECK ((rate IS NULL) = (original_currency IS NULL) AND (rate IS NULL OR rate > 0));
ALTER TABLE budgets ADD COLUMN rate_source TEXT
  CHECK ((rate_source IS NULL) = (original_currency IS NULL)
    AND (rate_source IS NULL OR rate_source IN ('wise', 'frankfurter')));
ALTER TABLE budgets ADD COLUMN rate_at INTEGER
  CHECK ((rate_at IS NULL) = (original_currency IS NULL));

CREATE TRIGGER budgets_typed_again
AFTER UPDATE OF amount_cents ON budgets
WHEN OLD.amount_cents IS NOT NEW.amount_cents AND NEW.original_currency IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM conversions c WHERE c.email = NEW.email AND c.phase = 'converting'
)
BEGIN
  UPDATE budgets SET original_currency = NULL, original_cents = NULL, rate = NULL,
    rate_source = NULL, rate_at = NULL
  WHERE email = NEW.email AND category_id = NEW.category_id
    AND from_month = NEW.from_month;
END;

ALTER TABLE recurring ADD COLUMN original_currency TEXT
  CHECK (original_currency IS NULL OR (length(original_currency) = 3
    AND NOT original_currency GLOB '*[^A-Z]*'));
ALTER TABLE recurring ADD COLUMN original_cents INTEGER
  CHECK ((original_cents IS NULL) = (original_currency IS NULL)
    AND (original_cents IS NULL OR typeof(original_cents) = 'integer'));
ALTER TABLE recurring ADD COLUMN rate REAL
  CHECK ((rate IS NULL) = (original_currency IS NULL) AND (rate IS NULL OR rate > 0));
ALTER TABLE recurring ADD COLUMN rate_source TEXT
  CHECK ((rate_source IS NULL) = (original_currency IS NULL)
    AND (rate_source IS NULL OR rate_source IN ('wise', 'frankfurter')));
ALTER TABLE recurring ADD COLUMN rate_at INTEGER
  CHECK ((rate_at IS NULL) = (original_currency IS NULL));

CREATE TRIGGER recurring_typed_again
AFTER UPDATE OF amount_cents ON recurring
WHEN OLD.amount_cents IS NOT NEW.amount_cents AND NEW.original_currency IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM conversions c WHERE c.email = NEW.email AND c.phase = 'converting'
)
BEGIN
  UPDATE recurring SET original_currency = NULL, original_cents = NULL, rate = NULL,
    rate_source = NULL, rate_at = NULL
  WHERE email = NEW.email AND id = NEW.id;
END;
