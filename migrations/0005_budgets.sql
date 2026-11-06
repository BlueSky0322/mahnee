-- A monthly amount a person means to spend in a top-level spending category. See
-- docs/erd.md for how the tables relate, and shared/budgets.ts for the rules.

-- One row per category and month it was set in: the amount from that month on, until a
-- later row. No amount (NULL) takes the budget away from that month on, so earlier months
-- keep what they had. Carry over adds what the month before left (or takes away what it
-- overspent). Keyed by the person first, and the category looked up among theirs only.
CREATE TABLE budgets (
  email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  -- The month it applies from, as 2026-11
  from_month TEXT NOT NULL CHECK (from_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  -- Whole cents, above zero and at most MAX_TRANSACTION_CENTS; NULL for none from this month
  amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents BETWEEN 1 AND 1000000000),
  carry_over INTEGER NOT NULL DEFAULT 0 CHECK (carry_over IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (email, category_id, from_month),
  FOREIGN KEY (email, category_id) REFERENCES categories (email, id)
);

-- Held here too, so nothing that writes here gets round the Worker's check: a budget goes
-- on one of the person's own top-level spending categories (archived or not, so one can be
-- taken away from an archived category)
CREATE TRIGGER budgets_top_level_spending
BEFORE INSERT ON budgets
WHEN NOT EXISTS (
  SELECT 1 FROM categories c
  WHERE c.email = NEW.email AND c.id = NEW.category_id
    AND c.parent_id IS NULL AND c.kind = 'expense'
)
BEGIN
  SELECT RAISE(ABORT, 'CONSTRAINT: a budget goes on a top-level spending category');
END;
