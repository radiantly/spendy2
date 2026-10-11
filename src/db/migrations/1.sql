CREATE TABLE accounts (
  name              TEXT NOT NULL PRIMARY KEY,
  default_currency  TEXT NOT NULL
);

CREATE TABLE sources (
  hash              TEXT NOT NULL PRIMARY KEY,
  remarks           TEXT NOT NULL,
  import_timestamp  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE categories (
  name              TEXT NOT NULL PRIMARY KEY,
  parent            TEXT REFERENCES categories(name) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT no_self_parent CHECK (name <> parent)
);

-- if timestamp is NULL, transactions will be ordered by (naive_date, seq).
CREATE TABLE transactions (
  seq               INTEGER NOT NULL UNIQUE,
  id                TEXT NOT NULL PRIMARY KEY,
  source            TEXT NOT NULL REFERENCES sources(hash) ON UPDATE CASCADE ON DELETE CASCADE,
  account_name      TEXT NOT NULL REFERENCES accounts(name) ON UPDATE CASCADE ON DELETE CASCADE,

  -- if the counterparty is an existing account
  transfer_account  TEXT REFERENCES accounts(name) ON UPDATE CASCADE ON DELETE SET NULL,

  -- amount is actual amount multiplied by 10000 and rounded
  amount            INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  converted_amount  INTEGER,
  converted_currency TEXT,
  counterparty      TEXT NOT NULL,
  category          TEXT REFERENCES categories(name) ON UPDATE CASCADE ON DELETE SET NULL,
  duplicate_of      TEXT REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE SET NULL,
  -- local date, not utc, not timezone aware
  naive_date        TEXT NOT NULL CHECK (naive_date IS date(naive_date)),
  timestamp         INTEGER,
  remarks           TEXT,
  CONSTRAINT no_self_duplicate CHECK (id <> duplicate_of),
  CONSTRAINT no_self_transfer CHECK (account_name <> transfer_account),
  CONSTRAINT valid_conversion CHECK ((converted_amount IS NULL) = (converted_currency IS NULL))
);
