import { beforeEach, describe, expect, it } from "vitest";
import type { ListedTransaction } from "../../db/queries/transactions.ts";
import { DEFAULT_VIEW, filterValues, viewOrder, type TransactionsView } from "./view.ts";

let seq = 0;
beforeEach(() => {
  seq = 0;
});

/** A transaction, imported after the ones before it. */
function row(overrides: Partial<ListedTransaction> = {}): ListedTransaction {
  seq++;
  return {
    id: `t${seq}`,
    seq,
    naive_date: "2026-10-10",
    account_name: "Checking",
    counterparty: "Shop",
    category: "Groceries",
    amount: -100,
    decimals: 2,
    currency: "USD",
    remarks: null,
    transfer_account: null,
    duplicate_of: null,
    conversions: {},
    ...overrides,
  };
}

const NAMES = {
  accounts: ["Card", "Checking", "Savings"],
  categories: ["Food", "Groceries", "Rent"],
};
const TODAY = "2026-10-18";

/** The ids of `rows` the view with `changes` shows, in order. */
function shown(rows: ListedTransaction[], changes: Partial<TransactionsView> = {}) {
  return viewOrder(rows, { ...DEFAULT_VIEW, ...changes }, NAMES, TODAY).map(
    (position) => rows[position]!.id,
  );
}

const ids = (rows: ListedTransaction[]) => rows.map(({ id }) => id);

describe("viewOrder", () => {
  describe("sorting by date", () => {
    it("shows the newest first, and on a day, the last imported first", () => {
      const older = row({ naive_date: "2026-10-01" });
      const first = row({ naive_date: "2026-10-05" });
      const second = row({ naive_date: "2026-10-05" });

      expect(shown([older, second, first])).toEqual(ids([second, first, older]));
    });

    // An edit leaves a row where it was read, but sorting again puts it where reading would.
    it("puts a row whose date was edited among that day's by when it was imported", () => {
      const moved = row({ naive_date: "2026-10-05" });
      const later = row({ naive_date: "2026-10-05" });
      const latest = row({ naive_date: "2026-10-05" });

      expect(shown([latest, later, moved])).toEqual(ids([latest, later, moved]));
      expect(shown([moved, latest, later])).toEqual(ids([latest, later, moved]));
    });

    it("shows the oldest first, and on a day, the first imported first", () => {
      const older = row({ naive_date: "2026-10-01" });
      const first = row({ naive_date: "2026-10-05" });
      const second = row({ naive_date: "2026-10-05" });

      expect(
        shown([second, first, older], { sort: { column: "date", direction: "ascending" } }),
      ).toEqual(ids([older, first, second]));
    });
  });

  describe("sorting by text", () => {
    it("sorts by account, the newest first within each", () => {
      const savings = row({ account_name: "Savings" });
      const oldCard = row({ account_name: "Card", naive_date: "2026-10-01" });
      const newCard = row({ account_name: "Card", naive_date: "2026-10-09" });

      expect(
        shown([savings, oldCard, newCard], { sort: { column: "account", direction: "ascending" } }),
      ).toEqual(ids([newCard, oldCard, savings]));
      // Z to A reverses the accounts, not the dates.
      expect(
        shown([savings, oldCard, newCard], {
          sort: { column: "account", direction: "descending" },
        }),
      ).toEqual(ids([savings, newCard, oldCard]));
    });

    it("sorts an account spelled in another case with the one listed", () => {
      const listed = row({ account_name: "Checking", naive_date: "2026-10-01" });
      const savings = row({ account_name: "Savings", naive_date: "2026-10-09" });
      const otherCase = row({ account_name: "checking", naive_date: "2026-10-05" });

      expect(
        shown([listed, savings, otherCase], {
          sort: { column: "account", direction: "ascending" },
        }),
      ).toEqual(ids([otherCase, listed, savings]));
    });

    it("sorts names ignoring case, with numbers by value", () => {
      const ten = row({ counterparty: "shop 10" });
      const two = row({ counterparty: "Shop 2" });
      const apple = row({ counterparty: "apple" });

      expect(
        shown([ten, two, apple], { sort: { column: "counterparty", direction: "ascending" } }),
      ).toEqual(ids([apple, two, ten]));
    });

    it("puts transactions without a category last, either way", () => {
      const none = row({ category: null, naive_date: "2026-10-12" });
      const food = row({ category: "Food" });
      const rent = row({ category: "Rent" });

      expect(
        shown([none, food, rent], { sort: { column: "category", direction: "ascending" } }),
      ).toEqual(ids([food, rent, none]));
      expect(
        shown([none, food, rent], { sort: { column: "category", direction: "descending" } }),
      ).toEqual(ids([rent, food, none]));
    });
  });

  describe("filtering by date", () => {
    const days = () =>
      [
        "2025-10-31",
        "2025-11-01",
        "2026-08-31",
        "2026-09-01",
        "2026-09-30",
        "2026-10-01",
        TODAY,
      ].map((naive_date) => row({ naive_date }));
    const datesOf = (rows: ListedTransaction[], dates: TransactionsView["dates"]) =>
      shown(rows, { dates }).map((id) => rows.find((r) => r.id === id)!.naive_date);

    it.each([
      ["this-month", ["2026-10-18", "2026-10-01"]],
      ["last-month", ["2026-09-30", "2026-09-01"]],
      ["last-3-months", ["2026-10-18", "2026-10-01", "2026-09-30", "2026-09-01", "2026-08-31"]],
      // The twelve months up to this one's: from the start of the eleventh before.
      [
        "last-12-months",
        ["2026-10-18", "2026-10-01", "2026-09-30", "2026-09-01", "2026-08-31", "2025-11-01"],
      ],
    ] as const)("shows %s's", (kind, expected) => {
      expect(datesOf(days(), { kind })).toEqual(expected);
    });

    it("shows a custom range's, both ends included", () => {
      expect(datesOf(days(), { kind: "custom", from: "2026-09-01", to: "2026-10-01" })).toEqual([
        "2026-10-01",
        "2026-09-30",
        "2026-09-01",
      ]);
    });

    it("shows a custom range whose ends were picked the wrong way round", () => {
      expect(datesOf(days(), { kind: "custom", from: "2026-10-01", to: "2026-09-01" })).toEqual([
        "2026-10-01",
        "2026-09-30",
        "2026-09-01",
      ]);
    });

    it("shows a transaction dated later this month in this month", () => {
      const later = row({ naive_date: "2026-10-20" });

      expect(shown([later], { dates: { kind: "this-month" } })).toEqual([later.id]);
    });
  });

  describe("filtering by values", () => {
    it("hides the unchecked accounts, however their transactions spell them", () => {
      const checking = row({ account_name: "Checking" });
      const otherCase = row({ account_name: "CHECKING" });
      const card = row({ account_name: "Card" });

      expect(shown([checking, otherCase, card], { hiddenAccounts: new Set(["Checking"]) })).toEqual(
        [card.id],
      );
    });

    it("hides the transactions set to an unchecked category, not to its subcategories", () => {
      const food = row({ category: "Food" });
      const groceries = row({ category: "groceries" });
      const none = row({ category: null });

      expect(shown([food, groceries, none], { hiddenCategories: new Set(["Food"]) })).toEqual(
        ids([none, groceries]),
      );
      expect(shown([food, groceries, none], { hiddenCategories: new Set([null]) })).toEqual(
        ids([groceries, food]),
      );
    });

    it("shows only money in, or only money out, and a zero amount in neither", () => {
      const income = row({ amount: 500 });
      const spending = row({ amount: -500 });
      const zero = row({ amount: 0 });

      expect(shown([income, spending, zero], { flow: "in" })).toEqual([income.id]);
      expect(shown([income, spending, zero], { flow: "out" })).toEqual([spending.id]);
      expect(shown([income, spending, zero])).toEqual(ids([zero, spending, income]));
    });

    it("hides the unchecked currencies", () => {
      const usd = row({ currency: "USD" });
      const eur = row({ currency: "EUR" });

      expect(shown([usd, eur], { hiddenCurrencies: new Set(["USD"]) })).toEqual([eur.id]);
    });

    it("shows only what every filter lets through", () => {
      const kept = row({ account_name: "Card", amount: -1 });
      const wrongAccount = row({ account_name: "Savings", amount: -1 });
      const income = row({ account_name: "Card", amount: 1 });

      expect(
        shown([kept, wrongAccount, income], {
          hiddenAccounts: new Set(["Savings"]),
          flow: "out",
        }),
      ).toEqual([kept.id]);
    });
  });
});

describe("filterValues", () => {
  it("gives the categories used, as listed, and null if one is missing", () => {
    const values = filterValues(
      [row({ category: "groceries" }), row({ category: null }), row({ category: "Rent" })],
      NAMES,
    );

    expect(values.categories).toEqual(new Set(["Groceries", null, "Rent"]));
  });

  it("gives each currency used once, alphabetical", () => {
    const values = filterValues(
      [row({ currency: "USD" }), row({ currency: "EUR" }), row({ currency: "USD" })],
      NAMES,
    );

    expect(values.currencies).toEqual(["EUR", "USD"]);
  });
});
