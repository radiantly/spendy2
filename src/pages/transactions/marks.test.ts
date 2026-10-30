import { describe, expect, it } from "vitest";
import type { ListedTransaction } from "../../db/queries/transactions.ts";
import type { TransactionMark } from "../../db/transactions.ts";
import { duplicateMarks, isMarked, marksNote, transferMarks, unmarks } from "./marks.ts";

function transaction(overrides: Partial<ListedTransaction> = {}): ListedTransaction {
  return {
    id: "t1",
    naive_date: "2026-10-10",
    timestamp: null,
    sort_key: 1,
    account_name: "Checking",
    counterparty: "Corner Market",
    category: "Groceries",
    amount: -4620,
    decimals: 2,
    currency: "USD",
    remarks: null,
    transfer_account: null,
    duplicate_of: null,
    conversions: {},
    ...overrides,
  };
}

/**
 * Transactions with `ids`, as the page keeps them: each a duplicate of what
 * `duplicates` has for it, and those in `removed` removed.
 */
function transactions(
  ids: string[],
  duplicates: Record<string, string> = {},
  removed: string[] = [],
) {
  const rows = ids.map((id) => transaction({ id, duplicate_of: duplicates[id] ?? null }));
  return {
    rows,
    positions: new Map(rows.map((row, position) => [row.id, position])),
    removed: new Set(removed.map((id) => ids.indexOf(id))),
  };
}

const duplicate = (id: string, value: string | null): TransactionMark => ({
  id,
  field: "duplicate_of",
  value,
});

describe("duplicateMarks", () => {
  it("marks one as a duplicate of the one picked", () => {
    expect(duplicateMarks(transactions(["A", "B"]), ["A"], "B")).toEqual([duplicate("A", "B")]);
  });

  it("marks several as duplicates of the one picked", () => {
    expect(duplicateMarks(transactions(["A", "B", "C"]), ["A", "B"], "C")).toEqual([
      duplicate("A", "C"),
      duplicate("B", "C"),
    ]);
  });

  it("marks nothing when the one marked is picked", () => {
    expect(duplicateMarks(transactions(["A", "B"]), ["A"], "A")).toEqual([]);
  });

  it("marks nothing when they're duplicates of the one picked already", () => {
    expect(duplicateMarks(transactions(["A", "B"], { A: "B" }), ["A"], "B")).toEqual([]);
  });

  it("marks them duplicates of the original of a duplicate picked", () => {
    expect(duplicateMarks(transactions(["A", "B", "C"], { B: "C" }), ["A"], "B")).toEqual([
      duplicate("A", "C"),
    ]);
  });

  it("makes the one picked among them the original of the rest", () => {
    expect(duplicateMarks(transactions(["A", "B", "C"]), ["A", "B", "C"], "B")).toEqual([
      duplicate("A", "B"),
      duplicate("C", "B"),
    ]);
  });

  it("makes a duplicate of the one marked its original, when it's picked", () => {
    expect(duplicateMarks(transactions(["A", "B"], { B: "A" }), ["A"], "B")).toEqual([
      duplicate("B", null),
      duplicate("A", "B"),
    ]);
  });

  it("makes a duplicate of one of them their original, when it's picked", () => {
    expect(duplicateMarks(transactions(["A", "B", "C"], { C: "A" }), ["A", "B"], "C")).toEqual([
      duplicate("C", null),
      duplicate("A", "C"),
      duplicate("B", "C"),
    ]);
  });

  it("moves the duplicates of those marked on to the original", () => {
    expect(duplicateMarks(transactions(["A", "B", "X"], { X: "A" }), ["A"], "B")).toEqual([
      duplicate("A", "B"),
      duplicate("X", "B"),
    ]);
  });

  it("leaves the original's duplicates as they are", () => {
    expect(duplicateMarks(transactions(["A", "B", "X"], { X: "B" }), ["A"], "B")).toEqual([
      duplicate("A", "B"),
    ]);
  });

  it("marks a duplicate of another as a duplicate of the one picked", () => {
    expect(duplicateMarks(transactions(["A", "B", "X"], { A: "X" }), ["A"], "B")).toEqual([
      duplicate("A", "B"),
    ]);
  });

  it("ends a loop of duplicates, as an import can make, at the original", () => {
    // A is a duplicate of B, which is a duplicate of A: B is the last before
    // A comes round again.
    expect(duplicateMarks(transactions(["A", "B", "C"], { A: "B", B: "A" }), ["C"], "A")).toEqual([
      duplicate("B", null),
      duplicate("C", "B"),
    ]);
  });

  it("leaves out those removed", () => {
    expect(duplicateMarks(transactions(["A", "B", "X"], { X: "A" }, ["X"]), ["A"], "B")).toEqual([
      duplicate("A", "B"),
    ]);
  });
});

const side = (id: string, account_name: string, transfer_account: string | null = null) => ({
  id,
  account_name,
  transfer_account,
});

const transfer = (id: string, value: string): TransactionMark => ({
  id,
  field: "transfer_account",
  value,
});

describe("transferMarks", () => {
  it("marks both, each a transfer with the other's account", () => {
    expect(transferMarks(side("A", "Checking"), side("B", "Savings"))).toEqual([
      transfer("A", "Savings"),
      transfer("B", "Checking"),
    ]);
  });

  it.each([
    ["the same", "Checking"],
    ["another case of the same", "checking"],
  ])("marks nothing in %s account", (_, account) => {
    expect(transferMarks(side("A", "Checking"), side("B", account))).toEqual([]);
  });

  it("tells apart accounts whose names differ in the case of letters beyond A to Z", () => {
    // As the schema does: NOCASE folds only A to Z.
    expect(transferMarks(side("A", "Épargne"), side("B", "épargne"))).toEqual([
      transfer("A", "épargne"),
      transfer("B", "Épargne"),
    ]);
  });

  it("marks only the side that isn't a transfer with the other already", () => {
    expect(transferMarks(side("A", "Checking"), side("B", "Savings", "Checking"))).toEqual([
      transfer("A", "Savings"),
    ]);
  });

  it("marks nothing when they're transfers with each other already", () => {
    expect(
      transferMarks(side("A", "Checking", "Savings"), side("B", "Savings", "Checking")),
    ).toEqual([]);
  });

  it("marks one that was a transfer with another account again", () => {
    expect(transferMarks(side("A", "Checking", "Travel"), side("B", "Savings"))).toEqual([
      transfer("A", "Savings"),
      transfer("B", "Checking"),
    ]);
  });
});

describe("marksNote", () => {
  // Only t2 is shown, as row 456.
  const rowNumberOf = (id: string) => (id === "t2" ? 456 : undefined);

  it("says nothing for a transaction that isn't marked", () => {
    expect(marksNote(transaction(), rowNumberOf)).toBeNull();
  });

  it.each([
    [4620, "Transfer from Savings."],
    [-4620, "Transfer to Savings."],
    // Neither in nor out, as if out.
    [0, "Transfer to Savings."],
  ])("says a transfer of %d is from or to the other side's account", (amount, note) => {
    expect(marksNote(transaction({ amount, transfer_account: "Savings" }), rowNumberOf)).toBe(note);
  });

  it("says which row a duplicate's original is", () => {
    expect(marksNote(transaction({ duplicate_of: "t2" }), rowNumberOf)).toBe(
      "Duplicate of transaction 456.",
    );
  });

  it("says a duplicate's original is hidden, when it isn't shown", () => {
    expect(marksNote(transaction({ duplicate_of: "t3" }), rowNumberOf)).toBe(
      "Duplicate of a hidden transaction.",
    );
  });

  it("says both, the transfer first", () => {
    expect(
      marksNote(transaction({ transfer_account: "Savings", duplicate_of: "t2" }), rowNumberOf),
    ).toBe("Transfer to Savings. Duplicate of transaction 456.");
  });
});

describe("unmarks", () => {
  const rows = [
    transaction({ id: "A", duplicate_of: "X", transfer_account: "Savings" }),
    transaction({ id: "B", transfer_account: "Savings" }),
  ];

  it("unmarks those marked as the kind, leaving the rest", () => {
    expect(unmarks("duplicate", rows)).toEqual([duplicate("A", null)]);
    expect(unmarks("transfer", rows)).toEqual([
      { id: "A", field: "transfer_account", value: null },
      { id: "B", field: "transfer_account", value: null },
    ]);
  });

  it("tells which are marked as each kind", () => {
    expect(rows.map((row) => isMarked(row, "duplicate"))).toEqual([true, false]);
    expect(rows.map((row) => isMarked(row, "transfer"))).toEqual([true, true]);
  });
});
