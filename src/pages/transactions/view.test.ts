import { beforeEach, describe, expect, it } from "vitest";
import type { ListedTransaction } from "../../db/queries/transactions.ts";
import type { Rates } from "../../lib/rates/rates.ts";
import { fill } from "../../lib/rates/reader.ts";
import { chunkOf } from "../../test/rates.ts";
import {
  DEFAULT_VIEW,
  filterValues,
  shownRows,
  sortOrder,
  viewHidden,
  withArrived,
  withHidden,
  type SortColumn,
  type SortDirection,
  type TransactionsView,
} from "./view.ts";

let count = 0;
beforeEach(() => {
  count = 0;
});

/** A transaction without a time, imported after the ones before it. */
function row(overrides: Partial<ListedTransaction> = {}): ListedTransaction {
  count++;
  return {
    id: `t${count}`,
    timestamp: null,
    sort_key: count,
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
/** No exchange rates: only sorting by amount reads them. */
const NO_RATES: Rates = new Map();

/** What the view with `changes` shows of `rows`, none of them removed (see `shownRows`). */
function showing(
  rows: ListedTransaction[],
  changes: Partial<TransactionsView> = {},
  rates = NO_RATES,
) {
  const view = { ...DEFAULT_VIEW, ...changes };
  return shownRows(
    rows,
    sortOrder(rows, view.sort, NAMES, rates),
    viewHidden(rows, view, NAMES, TODAY),
    new Set(),
  );
}

/** The ids of `rows` the view with `changes` shows, in order. */
function shown(
  rows: ListedTransaction[],
  changes: Partial<TransactionsView> = {},
  rates = NO_RATES,
) {
  return showing(rows, changes, rates).rows.map(({ id }) => id);
}

/** The numbers of the rows the view with `changes` shows of `rows`, in order. */
function numbers(rows: ListedTransaction[], changes: Partial<TransactionsView> = {}) {
  return showing(rows, changes).numbers;
}

const ids = (rows: ListedTransaction[]) => rows.map(({ id }) => id);

/** The first day of key 5, 2026-01-27, whose chunks the rows' days (October 2026) are in. */
const KEY_5_DATE = "2026-01-27";

/** Rates of key 5 from its first day, by currency: the same every day after the last given. */
function ratesOf(byCurrency: Record<string, number[]>): Rates {
  return new Map(
    Object.entries(byCurrency).map(([currency, rates]) => [
      currency,
      new Map([[5, fill(chunkOf(...rates), NaN)]]),
    ]),
  );
}

/** A euro bought 1.25 dollars, 1.6 Singapore dollars and 200 yen, every day. */
const RATES = ratesOf({ USD: [1.25], SGD: [1.6], JPY: [200] });
/** A time on 2026-10-10 (`HH:MM`, UTC), as a timestamp. */
const at = (time: string) => Date.parse(`2026-10-10T${time}Z`) / 1000;
const OLDEST_FIRST = { sort: { column: "date", direction: "ascending" } } as const;

describe("the rows a view shows", () => {
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

      expect(shown([second, first, older], OLDEST_FIRST)).toEqual(ids([older, first, second]));
    });

    it("shows a day's with a time first, the latest first, then those without", () => {
      const evening = row({ timestamp: at("18:00") });
      const morning = row({ timestamp: at("09:00") });
      const untimed = row();

      expect(shown([untimed, morning, evening])).toEqual(ids([evening, morning, untimed]));
    });

    it("shows the oldest first: on a day, those without a time first, as if at its start", () => {
      const evening = row({ timestamp: at("18:00") });
      const untimed = row();
      const morning = row({ timestamp: at("09:00") });

      expect(shown([evening, untimed, morning], OLDEST_FIRST)).toEqual(
        ids([untimed, morning, evening]),
      );
    });

    it("shows a transaction on its date, whatever day its time is on", () => {
      const later = row({ naive_date: "2026-10-05", timestamp: at("12:00") });
      const next = row({ naive_date: "2026-10-06" });

      expect(shown([later, next])).toEqual(ids([next, later]));
    });

    it.each([
      ["the same time", at("12:00")],
      ["no time", null],
    ])("shows a day's with %s by sort key, the highest first", (_, timestamp) => {
      const higher = row({ timestamp, sort_key: 2 });
      const lower = row({ timestamp, sort_key: 1 });

      expect(shown([lower, higher])).toEqual(ids([higher, lower]));
    });

    it("shows a day's with the same sort key by id, the highest first", () => {
      const a = row({ id: "a", sort_key: 1 });
      const b = row({ id: "b", sort_key: 1 });

      expect(shown([a, b])).toEqual(ids([b, a]));
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

    it("sorts by remarks, putting transactions without them last, either way", () => {
      const none = row({ remarks: null, naive_date: "2026-10-12" });
      const refund = row({ remarks: "Refund" });
      const gift = row({ remarks: "gift" });

      expect(
        shown([none, refund, gift], { sort: { column: "remarks", direction: "ascending" } }),
      ).toEqual(ids([gift, refund, none]));
      expect(
        shown([none, refund, gift], { sort: { column: "remarks", direction: "descending" } }),
      ).toEqual(ids([refund, gift, none]));
    });
  });

  describe("sorting by amount", () => {
    const smallestFirst = { sort: { column: "amount", direction: "ascending" } } as const;
    const largestFirst = { sort: { column: "amount", direction: "descending" } } as const;

    it("puts the amounts of one currency in order of size, either way", () => {
      const rows = [row({ amount: -500 }), row({ amount: -100 }), row({ amount: -4620 })];

      expect(shown(rows, smallestFirst, RATES)).toEqual(ids([rows[1]!, rows[0]!, rows[2]!]));
      expect(shown(rows, largestFirst, RATES)).toEqual(ids([rows[2]!, rows[0]!, rows[1]!]));
    });

    it("sorts by size, whichever way the money went", () => {
      const rows = [row({ amount: 300 }), row({ amount: -500 }), row({ amount: -100 })];

      expect(shown(rows, smallestFirst, RATES)).toEqual(ids([rows[2]!, rows[0]!, rows[1]!]));
      expect(shown(rows, largestFirst, RATES)).toEqual(ids([rows[1]!, rows[0]!, rows[2]!]));
    });

    it("compares amounts in different currencies by what they're worth", () => {
      const rows = [
        // 10 euros, 8 euros, 12 euros and 9 euros.
        row({ currency: "SGD", amount: -1600 }),
        row({ currency: "USD", amount: -1000 }),
        row({ currency: "JPY", amount: -2400, decimals: 0 }),
        row({ currency: "EUR", amount: -900 }),
      ];

      expect(shown(rows, smallestFirst, RATES)).toEqual(
        ids([rows[1]!, rows[3]!, rows[0]!, rows[2]!]),
      );
      expect(shown(rows, largestFirst, RATES)).toEqual(
        ids([rows[2]!, rows[0]!, rows[3]!, rows[1]!]),
      );
    });

    it("reads an amount in its currency's stored decimals", () => {
      const rows = [
        row({ currency: "USD", amount: -12_500, decimals: 3 }),
        row({ currency: "USD", amount: -1300, decimals: 2 }),
      ];

      expect(shown(rows, largestFirst, RATES)).toEqual(ids([rows[1]!, rows[0]!]));
    });

    it("uses the rate of each transaction's own day", () => {
      // A euro bought 1.25 dollars on the first day, and 2.5 from the second.
      const rates = ratesOf({ USD: [1.25, 2.5] });
      const rows = [
        // 8 euros then, and 6 euros later, though more dollars.
        row({ currency: "USD", amount: -1000, naive_date: KEY_5_DATE }),
        row({ currency: "USD", amount: -1500, naive_date: "2026-10-10" }),
        row({ currency: "EUR", amount: -700, naive_date: "2026-10-10" }),
      ];

      expect(shown(rows, largestFirst, rates)).toEqual(ids([rows[0]!, rows[2]!, rows[1]!]));
    });

    it("goes by a stored conversion rather than the transaction's own amount", () => {
      const rows = [
        // SGD 16.00 is 10 euros by the rates, but it came to JPY 3,000: 15 euros.
        row({
          currency: "SGD",
          amount: -1600,
          conversions: { JPY: { amount: -3000, decimals: 0 } },
        }),
        row({ currency: "EUR", amount: -1200 }),
      ];

      expect(shown(rows, largestFirst, RATES)).toEqual(ids([rows[0]!, rows[1]!]));
    });

    it("goes by the largest of a transaction's conversions", () => {
      const rows = [
        row({
          currency: "SGD",
          amount: -1600,
          // 9 euros, and 15 euros.
          conversions: {
            USD: { amount: -1125, decimals: 2 },
            JPY: { amount: -3000, decimals: 0 },
          },
        }),
        row({ currency: "EUR", amount: -1200 }),
      ];

      expect(shown(rows, largestFirst, RATES)).toEqual(ids([rows[0]!, rows[1]!]));
    });

    it("goes by the transaction's own amount when its conversions have no rates", () => {
      const rows = [
        row({
          currency: "SGD",
          amount: -1600,
          conversions: { XTS: { amount: -99_999_900, decimals: 2 } },
        }),
        row({ currency: "EUR", amount: -1200 }),
      ];

      expect(shown(rows, largestFirst, RATES)).toEqual(ids([rows[1]!, rows[0]!]));
    });

    it("keeps transactions of the same size newest first, either way", () => {
      const rows = [
        row({ amount: -500, naive_date: "2026-10-01" }),
        row({ amount: 500, naive_date: "2026-10-03" }),
        row({ amount: -500, naive_date: "2026-10-02" }),
        // 4 euros, as USD 5.00 is.
        row({ currency: "EUR", amount: -400, naive_date: "2026-10-04" }),
      ];

      const newestFirst = ids([rows[3]!, rows[1]!, rows[2]!, rows[0]!]);
      expect(shown(rows, smallestFirst, RATES)).toEqual(newestFirst);
      expect(shown(rows, largestFirst, RATES)).toEqual(newestFirst);
    });

    describe("transactions without a rate", () => {
      it("go last either way", () => {
        const rows = [
          row({ currency: "XTS", amount: -1 }),
          row({ currency: "USD", amount: -500 }),
          row({ currency: "XTS", amount: -99_999_900 }),
          row({ currency: "USD", amount: -100 }),
        ];

        expect(shown(rows, smallestFirst, RATES).slice(0, 2)).toEqual(ids([rows[3]!, rows[1]!]));
        expect(shown(rows, largestFirst, RATES).slice(0, 2)).toEqual(ids([rows[1]!, rows[3]!]));
      });

      it("are in order of their amounts as numbers among themselves, whatever their currencies", () => {
        const rows = [
          row({ currency: "XTS", amount: -500 }),
          row({ currency: "USD", amount: -100 }),
          row({ currency: "XXX", amount: 300 }),
          row({ currency: "XTS", amount: -4620 }),
          // 20.00 in three decimals.
          row({ currency: "XBT", amount: -20_000, decimals: 3 }),
        ];

        expect(shown(rows, smallestFirst, RATES)).toEqual(
          ids([rows[1]!, rows[2]!, rows[0]!, rows[4]!, rows[3]!]),
        );
        expect(shown(rows, largestFirst, RATES)).toEqual(
          ids([rows[1]!, rows[3]!, rows[4]!, rows[0]!, rows[2]!]),
        );
      });

      it("are those on a day before their currency's first rate", () => {
        // The dollar's rates start on the second day of the chunk.
        const rates = ratesOf({ USD: [NaN, 1.25] });
        const rows = [
          row({ currency: "USD", amount: -99_900, naive_date: KEY_5_DATE }),
          row({ currency: "USD", amount: -100, naive_date: "2026-01-28" }),
        ];

        expect(shown(rows, largestFirst, rates)).toEqual(ids([rows[1]!, rows[0]!]));
      });

      it("are those on a day whose rates aren't loaded", () => {
        const rows = [
          // Key 4's last day.
          row({ currency: "USD", amount: -99_900, naive_date: "2026-01-26" }),
          row({ currency: "USD", amount: -100 }),
        ];

        expect(shown(rows, largestFirst, RATES)).toEqual(ids([rows[1]!, rows[0]!]));
      });

      it("are those whose date isn't one, euros too", () => {
        const rows = [
          row({ currency: "EUR", amount: -99_900, naive_date: "" }),
          row({ currency: "EUR", amount: -100 }),
        ];

        expect(shown(rows, largestFirst, RATES)).toEqual(ids([rows[1]!, rows[0]!]));
      });
    });

    it("sorts every transaction by its amount as a number without any rates, euros first", () => {
      const rows = [
        row({ currency: "USD", amount: -500 }),
        row({ currency: "EUR", amount: -4620 }),
        row({ currency: "SGD", amount: -100 }),
        row({ currency: "EUR", amount: -200 }),
      ];

      // The euro needs no rate, so it is the only one with a size.
      expect(shown(rows, smallestFirst)).toEqual(ids([rows[3]!, rows[1]!, rows[2]!, rows[0]!]));
      expect(shown(rows, largestFirst)).toEqual(ids([rows[1]!, rows[3]!, rows[0]!, rows[2]!]));
    });

    it("leaves the rows it was given as they were", () => {
      const rows = [row({ amount: -500 }), row({ amount: -100 })];
      const before = [...rows];

      shown(rows, smallestFirst, RATES);

      expect(rows).toEqual(before);
    });

    it("numbers the rows in the sort's order", () => {
      const rows = [row({ amount: -500 }), row({ amount: -100 }), row({ amount: -300 })];

      expect(showing(rows, smallestFirst, RATES).numbers).toEqual([1, 2, 3]);
    });
  });

  describe("numbering", () => {
    const days = () =>
      ["2026-10-04", "2026-10-03", "2026-10-02", "2026-10-01"].map((naive_date, index) =>
        row({ naive_date, category: index % 2 === 0 ? "Rent" : "Food" }),
      );

    it("numbers the rows from 1, in the order they're sorted", () => {
      expect(numbers(days())).toEqual([1, 2, 3, 4]);
      expect(numbers(days(), OLDEST_FIRST)).toEqual([1, 2, 3, 4]);
    });

    it("keeps the rows' numbers when some are filtered out, skipping theirs", () => {
      const rows = days();
      const hidingRent = { hiddenCategories: new Set(["Rent"]) };

      expect(shown(rows, hidingRent)).toEqual(ids([rows[1]!, rows[3]!]));
      expect(numbers(rows, hidingRent)).toEqual([2, 4]);
    });

    it("numbers the rows again when they're sorted, filtered or not", () => {
      const rows = days();
      const hidingRent = { hiddenCategories: new Set(["Rent"]), ...OLDEST_FIRST };

      expect(shown(rows, hidingRent)).toEqual(ids([rows[3]!, rows[1]!]));
      expect(numbers(rows, hidingRent)).toEqual([1, 3]);
    });

    it("gives hidden duplicates no number, so the rest have no gaps", () => {
      const [first, second, third] = days();
      const duplicate = { ...second!, duplicate_of: first!.id };
      const rows = [first!, duplicate, third!];

      expect(numbers(rows)).toEqual([1, 2]);
      expect(numbers(rows, { showDuplicates: true })).toEqual([1, 2, 3]);
    });

    it("gives a hidden duplicate no number when a filter would hide it too", () => {
      const [first, second, third] = days();
      const duplicate = { ...second!, duplicate_of: first!.id };

      // Hiding Food hides only the duplicate, which the two Rent rows don't count.
      expect(numbers([first!, duplicate, third!], { hiddenCategories: new Set(["Food"]) })).toEqual(
        [1, 2],
      );
    });

    it("gives a removed row no number, and the rows after it the ones before theirs", () => {
      const rows = days();
      const order = sortOrder(rows, DEFAULT_VIEW.sort, NAMES, NO_RATES);
      const hidden = viewHidden(rows, DEFAULT_VIEW, NAMES, TODAY);

      expect(shownRows(rows, order, hidden, new Set([1]))).toEqual({
        rows: [rows[0], rows[2], rows[3]],
        numbers: [1, 2, 3],
      });
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

    it("hides the duplicates, but not what they're duplicates of, until they're shown", () => {
      const original = row();
      const duplicate = row({ duplicate_of: original.id });

      expect(shown([original, duplicate])).toEqual([original.id]);
      expect(shown([original, duplicate], { showDuplicates: true })).toEqual(
        ids([duplicate, original]),
      );
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

describe("withArrived", () => {
  /** The ids of `rows` with those at `arrived` placed into `order` as the default sort would. */
  function placed(rows: ListedTransaction[], order: number[], arrived: number[]) {
    return withArrived(order, arrived, rows, DEFAULT_VIEW.sort, NAMES, NO_RATES).map(
      (at) => rows[at]!.id,
    );
  }

  it("puts an arrived row where the sort would, keeping the rest in order", () => {
    const rows = [
      row({ naive_date: "2026-10-03" }),
      row({ naive_date: "2026-10-01" }),
      row({ naive_date: "2026-10-02" }),
    ];

    expect(placed(rows, [0, 1], [2])).toEqual(ids([rows[0]!, rows[2]!, rows[1]!]));
  });

  it("keeps rows that are out of order where they are, placing among them as it passes", () => {
    // The row at 1 was edited to a later date, but stays where it was.
    const rows = [
      row({ naive_date: "2026-10-05" }),
      row({ naive_date: "2026-10-09" }),
      row({ naive_date: "2026-10-01" }),
      row({ naive_date: "2026-10-04" }),
    ];

    expect(placed(rows, [0, 1, 2], [3])).toEqual(ids([rows[0]!, rows[1]!, rows[3]!, rows[2]!]));
  });

  it("places several that arrived together, in order among themselves", () => {
    const rows = [
      row({ naive_date: "2026-10-05" }),
      row({ naive_date: "2026-10-01" }),
      row({ naive_date: "2026-10-02" }),
      row({ naive_date: "2026-10-09" }),
      row({ naive_date: "2026-10-03" }),
    ];

    expect(placed(rows, [0, 1], [2, 3, 4])).toEqual(
      ids([rows[3]!, rows[0]!, rows[4]!, rows[2]!, rows[1]!]),
    );
  });

  // Placing into the order the view gives the rest must give what it gives all of them.
  it.each(
    (["date", "account", "counterparty", "category", "remarks"] as SortColumn[]).flatMap((column) =>
      (["ascending", "descending"] as SortDirection[]).map((direction) => ({ column, direction })),
    ),
  )("places rows as sortOrder would, sorting by $column, $direction", (sort) => {
    const values = ["b", "a", null, "c", "a", null, "b"];
    const rows = values.map((text, i) =>
      row({
        naive_date: `2026-10-0${(i % 3) + 1}`,
        account_name: ["Card", "Checking", "Savings"][i % 3]!,
        counterparty: text ?? "z",
        category: text === null ? null : "Groceries",
        remarks: text,
      }),
    );
    const all = sortOrder(rows, sort, NAMES, NO_RATES);
    const arrived = [1, 4, 6];

    expect(
      withArrived(
        all.filter((at) => !arrived.includes(at)),
        arrived,
        rows,
        sort,
        NAMES,
        NO_RATES,
      ),
    ).toEqual(all);
  });

  it.each(["ascending", "descending"] as SortDirection[])(
    "places rows as sortOrder would, sorting by amount, %s",
    (direction) => {
      const sort = { column: "amount", direction } as const;
      // Some with a rate, some without, some of the same size, on three days.
      const rows = [
        ["USD", -500],
        ["SGD", -800],
        ["XTS", -300],
        ["USD", 500],
        ["XTS", -900],
        ["SGD", -100],
        ["XTS", 300],
        ["EUR", -400],
      ].map(([currency, amount], i) =>
        row({
          currency: currency as string,
          amount: amount as number,
          naive_date: `2026-10-0${(i % 3) + 1}`,
        }),
      );
      const all = sortOrder(rows, sort, NAMES, RATES);
      const arrived = [1, 2, 4, 7];

      expect(
        withArrived(
          all.filter((at) => !arrived.includes(at)),
          arrived,
          rows,
          sort,
          NAMES,
          RATES,
        ),
      ).toEqual(all);
    },
  );
});

describe("withHidden", () => {
  it("hides those of the rows it's given that the view hides, with those hidden before", () => {
    const rows = [
      row({ category: "Rent" }),
      row(),
      row({ category: "Rent" }),
      row({ duplicate_of: "t1" }),
      row({ category: "Rent" }),
    ];
    const view = { ...DEFAULT_VIEW, hiddenCategories: new Set(["Rent"]) };
    const before = viewHidden(rows.slice(0, 2), view, NAMES, TODAY);

    // The row at 4 isn't among those given.
    expect(withHidden(before, [2, 3], rows, view, NAMES, TODAY)).toEqual({
      filtered: new Set([0, 2]),
      uncounted: new Set([3]),
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
