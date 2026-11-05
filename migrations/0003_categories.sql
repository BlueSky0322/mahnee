-- What a person's spending and income is sorted into. See docs/erd.md for how the
-- tables relate, and shared/categories.ts for the rules.

-- A person's categories, one level deep: a top-level category (parent_id NULL) can have
-- subcategories, each the same kind as its parent and with none of its own. Archived,
-- never deleted. Keyed by the person first, like accounts, and a subcategory's parent is
-- looked up among the same person's categories only.
CREATE TABLE categories (
  email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
  parent_id TEXT,
  -- Its place among the categories beside it (same kind and parent), first at 0
  position INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (email, id),
  FOREIGN KEY (email, parent_id) REFERENCES categories (email, id)
);

-- A category's subcategories, looked up when counting them and checking moves
CREATE INDEX categories_parent ON categories (email, parent_id);

-- One level deep, held here too, so two saves at once can't get round the Worker's
-- checks between them: a subcategory's parent is a top-level category of the same kind,
-- and a category with subcategories stays at the top level.
CREATE TRIGGER categories_parent_on_add
BEFORE INSERT ON categories
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM categories p
  WHERE p.email = NEW.email AND p.id = NEW.parent_id
    AND p.parent_id IS NULL AND p.kind = NEW.kind
)
BEGIN
  SELECT RAISE(ABORT, 'CONSTRAINT: categories go one level deep');
END;

CREATE TRIGGER categories_parent_on_move
BEFORE UPDATE OF parent_id ON categories
WHEN NEW.parent_id IS NOT NULL AND (
  NOT EXISTS (
    SELECT 1 FROM categories p
    WHERE p.email = NEW.email AND p.id = NEW.parent_id
      AND p.parent_id IS NULL AND p.kind = NEW.kind
  )
  OR EXISTS (SELECT 1 FROM categories c WHERE c.email = NEW.email AND c.parent_id = NEW.id)
)
BEGIN
  SELECT RAISE(ABORT, 'CONSTRAINT: categories go one level deep');
END;
