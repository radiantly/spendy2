-- Account and category names ignore case: "Groceries" and "groceries" are the
-- same name. Columns referring to them do too, so comparisons agree.
CREATE TABLE accounts (
  name              TEXT NOT NULL COLLATE NOCASE PRIMARY KEY CHECK (name <> ''),
  -- The currency the account's amounts are shown in: a transaction in another
  -- currency counts through its conversion to it, and one without a conversion
  -- is left out (and flagged). NULL: each transaction in its own currency.
  display_currency  TEXT CHECK (display_currency <> ''),
  type              TEXT NOT NULL CHECK (type <> ''), -- e.g. "Bank" or "Card"
  identifier        TEXT CHECK (identifier <> '') -- e.g. a masked account or card number, like ••4821
) STRICT;

CREATE TABLE sources (
  -- SHA-256
  hash              BLOB NOT NULL PRIMARY KEY CHECK (length(hash) = 32),
  remarks           TEXT NOT NULL CHECK (remarks <> ''),
  import_timestamp  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE categories (
  name              TEXT NOT NULL COLLATE NOCASE PRIMARY KEY CHECK (name <> ''),
  parent            TEXT COLLATE NOCASE REFERENCES categories(name) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT no_self_parent CHECK (name <> parent)
) STRICT;

-- if timestamp is NULL, transactions will be ordered by (naive_date, seq).
CREATE TABLE transactions (
  seq               INTEGER NOT NULL UNIQUE,
  -- a lowercase UUIDv4
  id                TEXT NOT NULL PRIMARY KEY CHECK (id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  source            BLOB NOT NULL REFERENCES sources(hash) ON UPDATE CASCADE ON DELETE CASCADE,
  account_name      TEXT NOT NULL COLLATE NOCASE REFERENCES accounts(name) ON UPDATE CASCADE ON DELETE CASCADE,

  -- if the counterparty is an existing account
  transfer_account  TEXT COLLATE NOCASE REFERENCES accounts(name) ON UPDATE CASCADE ON DELETE SET NULL,

  -- amount is a rational number, both parts of the fraction stored
  amount_numerator  INTEGER NOT NULL,
  amount_denominator INTEGER NOT NULL CHECK (amount_denominator > 0),
  currency          TEXT NOT NULL CHECK (currency <> ''),
  counterparty      TEXT NOT NULL CHECK (counterparty <> ''),
  category          TEXT COLLATE NOCASE REFERENCES categories(name) ON UPDATE CASCADE ON DELETE SET NULL,
  duplicate_of      TEXT REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE SET NULL,
  -- local date, not utc, not timezone aware
  naive_date        TEXT NOT NULL CHECK (naive_date IS date(naive_date)),
  timestamp         INTEGER,
  remarks           TEXT CHECK (remarks <> ''),
  CONSTRAINT no_self_duplicate CHECK (id <> duplicate_of),
  CONSTRAINT no_self_transfer CHECK (account_name <> transfer_account)
) STRICT;

-- A transaction's amount in other currencies, at most one per currency.
CREATE TABLE conversions (
  transaction_id    TEXT NOT NULL REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE CASCADE,
  currency          TEXT NOT NULL CHECK (currency <> ''),
  amount_numerator  INTEGER NOT NULL,
  amount_denominator INTEGER NOT NULL CHECK (amount_denominator > 0),
  PRIMARY KEY (transaction_id, currency)
) STRICT;

-- for the foreign keys' cascades, and the checks below
CREATE INDEX transactions_category ON transactions(category);
CREATE INDEX categories_parent ON categories(parent);
-- for the amounts in one currency
CREATE INDEX conversions_currency ON conversions(currency);
-- for the overview's list of currencies, and the account foreign keys' cascades
CREATE INDEX transactions_account_currency ON transactions(account_name, currency);

-- A conversion is into another currency: a transaction's amount in its own
-- currency is its amount. Checked from both sides, so neither a conversion nor
-- a change of the transaction's currency can make one.
CREATE TRIGGER no_conversion_to_own_currency_on_insert
BEFORE INSERT ON conversions
WHEN EXISTS (SELECT 1 FROM transactions WHERE id = NEW.transaction_id AND currency = NEW.currency)
BEGIN
  SELECT RAISE(ABORT, 'A transaction can''t be converted to its own currency');
END;

CREATE TRIGGER no_conversion_to_own_currency_on_update
BEFORE UPDATE OF transaction_id, currency ON conversions
WHEN EXISTS (SELECT 1 FROM transactions WHERE id = NEW.transaction_id AND currency = NEW.currency)
BEGIN
  SELECT RAISE(ABORT, 'A transaction can''t be converted to its own currency');
END;

CREATE TRIGGER no_currency_with_conversion
BEFORE UPDATE OF currency ON transactions
WHEN EXISTS (SELECT 1 FROM conversions WHERE transaction_id = NEW.id AND currency = NEW.currency)
BEGIN
  SELECT RAISE(ABORT, 'A transaction can''t be converted to its own currency');
END;

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
