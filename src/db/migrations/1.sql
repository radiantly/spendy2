CREATE TABLE currencies (
  -- This table stores the currencies used in the database, along with how many decimals each
  -- currency is to store. Common currencies are already added to this table (think USD, EUR, etc).
  -- Exotic currencies will need to be added (think BTC).

  -- Currency code. Example: USD, EUR, BTC, etc.
  code              TEXT NOT NULL PRIMARY KEY CHECK (code <> ''),

  -- Number of stored decimals. Any amount that uses this currency will be multiplied by these many
  -- decimal places. For example, this value is 2 for USD (two decimal places). The amount $16.79
  -- will be stored as 1679.
  -- Note that if this value is updated, all existing amounts must also be updated.
  stored_decimals   INTEGER NOT NULL CHECK (stored_decimals >= 0)
) STRICT;

-- The currencies browsers know (ISO 4217, with a few recently withdrawn), with
-- ISO 4217's decimals. Others, or finer precision, can be set directly.
INSERT INTO currencies VALUES
  ('AED', 2), ('AFN', 2), ('ALL', 2), ('AMD', 2), ('ANG', 2), ('AOA', 2), ('ARS', 2), ('AUD', 2), ('AWG', 2), ('AZN', 2),
  ('BAM', 2), ('BBD', 2), ('BDT', 2), ('BGN', 2), ('BHD', 3), ('BIF', 0), ('BMD', 2), ('BND', 2), ('BOB', 2), ('BRL', 2),
  ('BSD', 2), ('BTN', 2), ('BWP', 2), ('BYN', 2), ('BZD', 2), ('CAD', 2), ('CDF', 2), ('CHF', 2), ('CLP', 0), ('CNY', 2),
  ('COP', 2), ('CRC', 2), ('CUC', 2), ('CUP', 2), ('CVE', 2), ('CZK', 2), ('DJF', 0), ('DKK', 2), ('DOP', 2), ('DZD', 2),
  ('EGP', 2), ('ERN', 2), ('ETB', 2), ('EUR', 2), ('FJD', 2), ('FKP', 2), ('GBP', 2), ('GEL', 2), ('GHS', 2), ('GIP', 2),
  ('GMD', 2), ('GNF', 0), ('GTQ', 2), ('GYD', 2), ('HKD', 2), ('HNL', 2), ('HRK', 2), ('HTG', 2), ('HUF', 2), ('IDR', 2),
  ('ILS', 2), ('INR', 2), ('IQD', 3), ('IRR', 2), ('ISK', 0), ('JMD', 2), ('JOD', 3), ('JPY', 0), ('KES', 2), ('KGS', 2),
  ('KHR', 2), ('KMF', 0), ('KPW', 2), ('KRW', 0), ('KWD', 3), ('KYD', 2), ('KZT', 2), ('LAK', 2), ('LBP', 2), ('LKR', 2),
  ('LRD', 2), ('LSL', 2), ('LYD', 3), ('MAD', 2), ('MDL', 2), ('MGA', 2), ('MKD', 2), ('MMK', 2), ('MNT', 2), ('MOP', 2),
  ('MRU', 2), ('MUR', 2), ('MVR', 2), ('MWK', 2), ('MXN', 2), ('MYR', 2), ('MZN', 2), ('NAD', 2), ('NGN', 2), ('NIO', 2),
  ('NOK', 2), ('NPR', 2), ('NZD', 2), ('OMR', 3), ('PAB', 2), ('PEN', 2), ('PGK', 2), ('PHP', 2), ('PKR', 2), ('PLN', 2),
  ('PYG', 0), ('QAR', 2), ('RON', 2), ('RSD', 2), ('RUB', 2), ('RWF', 0), ('SAR', 2), ('SBD', 2), ('SCR', 2), ('SDG', 2),
  ('SEK', 2), ('SGD', 2), ('SHP', 2), ('SLE', 2), ('SLL', 2), ('SOS', 2), ('SRD', 2), ('SSP', 2), ('STN', 2), ('SVC', 2),
  ('SYP', 2), ('SZL', 2), ('THB', 2), ('TJS', 2), ('TMT', 2), ('TND', 3), ('TOP', 2), ('TRY', 2), ('TTD', 2), ('TWD', 2),
  ('TZS', 2), ('UAH', 2), ('UGX', 0), ('USD', 2), ('UYU', 2), ('UZS', 2), ('VES', 2), ('VND', 0), ('VUV', 0), ('WST', 2),
  ('XAF', 0), ('XCD', 2), ('XCG', 2), ('XDR', 2), ('XOF', 0), ('XPF', 0), ('XSU', 2), ('YER', 2), ('ZAR', 2), ('ZMW', 2),
  ('ZWG', 2), ('ZWL', 2);

CREATE TABLE accounts (
  -- Account details. All transactions must be linked to an account in this table.

  -- Account name.
  name              TEXT NOT NULL COLLATE NOCASE PRIMARY KEY CHECK (name <> ''),

  -- The currency that this account's amounts are shown in. If a transaction linked to this account
  -- is made in a different currency, it will not be taken into account if it is not converted into
  -- this currency. If this value is NULL, conversions are not required and the UI will show a
  -- dropdown to see spends in all currencies that transactions are made in.
  display_currency  TEXT REFERENCES currencies(code),

  -- Account type. Example: "Bank" or "Card"
  type              TEXT NOT NULL CHECK (type <> ''),

  -- Account identifier. Usually masked. Example: "••4821"
  identifier        TEXT CHECK (identifier <> '')
) STRICT;

CREATE TABLE sources (
  -- Every transaction is required to be linked to a "source"
  -- In the case of file imports, hash can store the file hash, while remarks can store the file
  -- name or description.
  -- In other cases, it is up to the importer to fill the various details. The sources table exists
  -- to easily remove bulk transactions that may be incorrectly imported. A popular option is to
  -- set hash to sha256(date) - assuming that no better alternative exists.
  hash              BLOB NOT NULL PRIMARY KEY CHECK (length(hash) = 32),
  remarks           TEXT NOT NULL CHECK (remarks <> ''),
  import_timestamp  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE categories (
  -- Stores the various categories that transactions can be categorized under.

  -- Category name.
  name              TEXT NOT NULL COLLATE NOCASE PRIMARY KEY CHECK (name <> ''),

  -- A category can be listed under an existing category.
  parent            TEXT COLLATE NOCASE REFERENCES categories(name) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT no_self_parent CHECK (name <> parent)
) STRICT;

CREATE TABLE transactions (
  -- Store all transactions made.

  -- A transaction id. Lowercase uuid4. Importers can generate this per transaction.
  id                TEXT NOT NULL PRIMARY KEY CHECK (id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),

  source            BLOB NOT NULL REFERENCES sources(hash) ON UPDATE CASCADE ON DELETE CASCADE,
  account_name      TEXT NOT NULL COLLATE NOCASE REFERENCES accounts(name) ON UPDATE CASCADE ON DELETE CASCADE,

  -- Indicates if the transaction is made from/to an existing account
  transfer_account  TEXT COLLATE NOCASE REFERENCES accounts(name) ON UPDATE CASCADE ON DELETE SET NULL,

  currency          TEXT NOT NULL REFERENCES currencies(code),

  -- Amount. This is the actual amount multiplied the pow(10, currency's stored decimal places).
  amount            INTEGER NOT NULL,

  counterparty      TEXT NOT NULL CHECK (counterparty <> ''),
  category          TEXT COLLATE NOCASE REFERENCES categories(name) ON UPDATE CASCADE ON DELETE SET NULL,

  -- It is quite possible that two sources list the same transaction. In that case, set one of the
  -- transactions as duplicate of the other.
  duplicate_of      TEXT REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE SET NULL,

  -- Local date, not utc, not timezone aware.
  naive_date        TEXT NOT NULL CHECK (naive_date IS date(naive_date)),

  -- if timestamp is NULL, transactions will be ordered by (naive_date, seq).
  seq               INTEGER NOT NULL UNIQUE,
  
  timestamp         INTEGER,
  remarks           TEXT CHECK (remarks <> ''),
  CONSTRAINT no_self_duplicate CHECK (id <> duplicate_of),
  CONSTRAINT no_self_transfer CHECK (account_name <> transfer_account)
) STRICT;

CREATE TABLE conversions (
  -- A transaction's amount in other currencies, at most one per currency.
  transaction_id    TEXT NOT NULL REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE CASCADE,
  currency          TEXT NOT NULL REFERENCES currencies(code),
  amount            INTEGER NOT NULL, -- in the currency's stored_decimals
  PRIMARY KEY (transaction_id, currency)
) STRICT;

-- for the foreign keys' cascades, and the checks below
CREATE INDEX transactions_category ON transactions(category);
CREATE INDEX categories_parent ON categories(parent);
-- for the amounts in one currency
CREATE INDEX conversions_currency ON conversions(currency);
-- for the overview's list of currencies, and the account foreign keys' cascades
CREATE INDEX transactions_account_currency ON transactions(account_name, currency);
-- for the overview's periods, which are ranges of dates
CREATE INDEX transactions_naive_date ON transactions(naive_date);

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
