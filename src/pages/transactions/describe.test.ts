import { describe, expect, it } from "vitest";
import type { TransactionRow } from "../../db/queries/transactions.ts";
import { describeEdit, MAX_NAME_LENGTH, MAX_VALUE_LENGTH } from "./describe.ts";
import type { TransactionChange } from "./TransactionsTable.tsx";

const row = (overrides: Partial<TransactionRow> = {}): TransactionRow => ({
  id: "t1",
  naive_date: "2026-10-09",
  account_name: "Everyday Checking",
  counterparty: "Corner Market",
  category: "Groceries",
  amount_numerator: -231,
  amount_denominator: 5,
  currency: "USD",
  remarks: null,
  ...overrides,
});
const CATEGORIES = ["Dining out", "Groceries"];

const describeOne = (change: Omit<TransactionChange, "rowIndex">, before = row()) =>
  describeEdit([{ rowIndex: 0, ...change }], [before], CATEGORIES);

describe("describeEdit", () => {
  it.each<[string, Omit<TransactionChange, "rowIndex">, string]>([
    [
      "a category",
      { field: "category", patch: { category: "Dining out" } },
      "category of Corner Market: Groceries → Dining out",
    ],
    [
      "a category cleared",
      { field: "category", patch: { category: null } },
      "category of Corner Market: Groceries → none",
    ],
    [
      "a new category",
      { field: "category", patch: { category: "Coffee" } },
      "category of Corner Market: Groceries → Coffee (new)",
    ],
    [
      "an existing category in another case",
      { field: "category", patch: { category: "dining out" } },
      "category of Corner Market: Groceries → dining out",
    ],
    [
      "an amount, with its currency",
      { field: "amount", patch: { amount_numerator: -25, amount_denominator: 2 } },
      "amount of Corner Market: USD -46.20 → USD -12.50",
    ],
    [
      "a date",
      { field: "naive_date", patch: { naive_date: "2026-10-01" } },
      "date of Corner Market: 2026-10-09 → 2026-10-01",
    ],
    [
      "an account",
      { field: "account_name", patch: { account_name: "Savings" } },
      "account of Corner Market: Everyday Checking → Savings",
    ],
    [
      "a counterparty, named as it was",
      { field: "counterparty", patch: { counterparty: "Corner Shop" } },
      "counterparty of Corner Market: Corner Market → Corner Shop",
    ],
  ])("describes %s with its values", (_, change, expected) => {
    expect(describeOne(change)).toBe(expected);
  });

  it("only says the remarks changed, without their values", () => {
    expect(describeOne({ field: "remarks", patch: { remarks: "split with Sam" } })).toBe(
      "a change to the remarks of Corner Market",
    );
  });

  it("names a transaction by its counterparty up to the longest length", () => {
    const counterparty = "x".repeat(MAX_NAME_LENGTH);

    expect(
      describeOne({ field: "category", patch: { category: null } }, row({ counterparty })),
    ).toBe(`category of ${counterparty}: Groceries → none`);
  });

  it("calls a transaction with a longer counterparty just a transaction", () => {
    const counterparty = "x".repeat(MAX_NAME_LENGTH + 1);

    expect(
      describeOne({ field: "category", patch: { category: null } }, row({ counterparty })),
    ).toBe("category of a transaction: Groceries → none");
  });

  it("cuts off long values", () => {
    const description = describeOne({
      field: "account_name",
      patch: { account_name: "a".repeat(MAX_VALUE_LENGTH + 10) },
    });

    expect(description).toBe(
      `account of Corner Market: Everyday Checking → ${"a".repeat(MAX_VALUE_LENGTH - 1)}…`,
    );
  });

  it("counts the cells and transactions of a cleared range", () => {
    const rows = [row(), row({ id: "t2", remarks: "weekly" })];

    expect(
      describeEdit(
        [
          { rowIndex: 0, field: "category", patch: { category: null } },
          { rowIndex: 1, field: "category", patch: { category: null } },
          { rowIndex: 1, field: "remarks", patch: { remarks: null } },
        ],
        rows,
        CATEGORIES,
      ),
    ).toBe("clearing 3 cells in 2 transactions");
  });

  it("counts other changes to several cells as changes", () => {
    expect(
      describeEdit(
        [
          { rowIndex: 0, field: "category", patch: { category: null } },
          { rowIndex: 0, field: "counterparty", patch: { counterparty: "Corner Shop" } },
        ],
        [row()],
        CATEGORIES,
      ),
    ).toBe("changes to 2 cells in 1 transaction");
  });
});
