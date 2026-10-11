-- Account and category names ignore case: "Groceries" and "groceries" are the
-- same name. Columns referring to them do too, so comparisons agree.
CREATE TABLE accounts (
  name              TEXT NOT NULL COLLATE NOCASE PRIMARY KEY,
  default_currency  TEXT NOT NULL
);

CREATE TABLE sources (
  hash              TEXT NOT NULL PRIMARY KEY,
  remarks           TEXT NOT NULL,
  import_timestamp  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE categories (
  name              TEXT NOT NULL COLLATE NOCASE PRIMARY KEY,
  parent            TEXT COLLATE NOCASE REFERENCES categories(name) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT no_self_parent CHECK (name <> parent)
);

-- if timestamp is NULL, transactions will be ordered by (naive_date, seq).
CREATE TABLE transactions (
  seq               INTEGER NOT NULL UNIQUE,
  id                TEXT NOT NULL PRIMARY KEY,
  source            TEXT NOT NULL REFERENCES sources(hash) ON UPDATE CASCADE ON DELETE CASCADE,
  account_name      TEXT NOT NULL COLLATE NOCASE REFERENCES accounts(name) ON UPDATE CASCADE ON DELETE CASCADE,

  -- if the counterparty is an existing account
  transfer_account  TEXT COLLATE NOCASE REFERENCES accounts(name) ON UPDATE CASCADE ON DELETE SET NULL,

  -- amount is actual amount multiplied by 10000 and rounded
  amount            INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  converted_amount  INTEGER,
  converted_currency TEXT,
  counterparty      TEXT NOT NULL,
  category          TEXT COLLATE NOCASE REFERENCES categories(name) ON UPDATE CASCADE ON DELETE SET NULL,
  duplicate_of      TEXT REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE SET NULL,
  -- local date, not utc, not timezone aware
  naive_date        TEXT NOT NULL CHECK (naive_date IS date(naive_date)),
  timestamp         INTEGER,
  remarks           TEXT,
  CONSTRAINT no_self_duplicate CHECK (id <> duplicate_of),
  CONSTRAINT no_self_transfer CHECK (account_name <> transfer_account),
  CONSTRAINT valid_conversion CHECK ((converted_amount IS NULL) = (converted_currency IS NULL))
);

-- for the foreign keys' cascades, and the checks below
CREATE INDEX transactions_category ON transactions(category);
CREATE INDEX categories_parent ON categories(parent);

-- Every category with each of its ancestors: parent, grandparent, and so on.
-- UNION stops even on a loop already in the data.
CREATE VIEW category_ancestors(name, ancestor) AS
WITH RECURSIVE ancestors(name, ancestor) AS (
  SELECT name, parent FROM categories WHERE parent IS NOT NULL
  UNION
  SELECT ancestors.name, categories.parent
  FROM ancestors JOIN categories ON categories.name = ancestors.ancestor
  WHERE categories.parent IS NOT NULL
)
SELECT name, ancestor FROM ancestors;

-- A category can't be its own ancestor (being its own parent is no_self_parent's).
-- Inserts are checked too, for when foreign keys are off (e.g. migrations).
CREATE TRIGGER no_category_loop_on_insert
BEFORE INSERT ON categories
WHEN NEW.parent IS NOT NEW.name COLLATE NOCASE AND EXISTS (
  SELECT 1 FROM category_ancestors
  WHERE name = NEW.parent COLLATE NOCASE AND ancestor = NEW.name COLLATE NOCASE
)
BEGIN
  SELECT RAISE(ABORT, 'A category can''t be inside its own subcategory');
END;

CREATE TRIGGER no_category_loop_on_update
BEFORE UPDATE OF parent ON categories
WHEN NEW.parent IS NOT NEW.name COLLATE NOCASE AND EXISTS (
  SELECT 1 FROM category_ancestors
  WHERE name = NEW.parent COLLATE NOCASE AND ancestor = NEW.name COLLATE NOCASE
)
BEGIN
  SELECT RAISE(ABORT, 'A category can''t be inside its own subcategory');
END;

-- Categories nothing uses: no transaction and no subcategory.
CREATE VIEW unused_categories(name) AS
SELECT name FROM categories AS category
WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE transactions.category = category.name)
  AND NOT EXISTS (SELECT 1 FROM categories AS sub WHERE sub.parent = category.name);

-- A category is deleted once it's unused. Checked when a transaction moves off
-- a category or is deleted, and when a category loses a subcategory, so
-- deleting one can delete its parent in turn. Deeper than that needs
-- PRAGMA recursive_triggers = ON, which is per connection.
-- Categories that were never used are left alone.
CREATE TRIGGER delete_unused_category_after_transaction_update
AFTER UPDATE OF category ON transactions
WHEN OLD.category IS NOT NULL
BEGIN
  DELETE FROM categories WHERE name IN (SELECT name FROM unused_categories WHERE name = OLD.category);
END;

CREATE TRIGGER delete_unused_category_after_transaction_delete
AFTER DELETE ON transactions
WHEN OLD.category IS NOT NULL
BEGIN
  DELETE FROM categories WHERE name IN (SELECT name FROM unused_categories WHERE name = OLD.category);
END;

CREATE TRIGGER delete_unused_parent_after_category_update
AFTER UPDATE OF parent ON categories
WHEN OLD.parent IS NOT NULL
BEGIN
  DELETE FROM categories WHERE name IN (SELECT name FROM unused_categories WHERE name = OLD.parent);
END;

CREATE TRIGGER delete_unused_parent_after_category_delete
AFTER DELETE ON categories
WHEN OLD.parent IS NOT NULL
BEGIN
  DELETE FROM categories WHERE name IN (SELECT name FROM unused_categories WHERE name = OLD.parent);
END;
