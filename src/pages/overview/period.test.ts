import { describe, expect, it } from "vitest";
import {
  addMonths,
  daysIn,
  endOfMonth,
  localDate,
  monthsEnding,
  resolvePeriod,
  type PeriodChoice,
} from "./period.ts";

// Intl puts thin and narrow no-break spaces around the dash in ranges.
const plain = (text: string | undefined) => text?.replace(/\s/g, " ");

const TODAY = "2026-10-09";
type Dates = { first: string | null; last: string | null };
const DATES: Dates = { first: "2024-03-14", last: "2026-10-06" };

function resolve(choice: PeriodChoice, today = TODAY, dates = DATES) {
  const period = resolvePeriod(choice, today, dates);
  return {
    ...period,
    span: plain(period.span),
    name: plain(period.name),
    previous: period.previous && { ...period.previous, label: plain(period.previous.label) },
  };
}

describe("addMonths", () => {
  it("keeps the day of the month", () => {
    expect(addMonths("2026-10-09", -1)).toBe("2026-09-09");
    expect(addMonths("2026-01-15", -2)).toBe("2025-11-15");
  });

  it("stops at the end of a shorter month", () => {
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2024-03-31", -1)).toBe("2024-02-29");
  });
});

describe("endOfMonth", () => {
  it("is the month's last day", () => {
    expect(endOfMonth("2026-02-10")).toBe("2026-02-28");
    expect(endOfMonth("2026-12-01")).toBe("2026-12-31");
  });
});

describe("daysIn", () => {
  it("counts both ends", () => {
    expect(daysIn({ from: "2026-10-01", to: "2026-10-09" })).toBe(9);
    expect(daysIn({ from: "2026-10-09", to: "2026-10-09" })).toBe(1);
  });

  it("isn't thrown by a daylight saving change", () => {
    expect(daysIn({ from: "2026-03-01", to: "2026-03-31" })).toBe(31);
  });
});

describe("localDate", () => {
  it("is the date where the user is, not in UTC", () => {
    expect(localDate(new Date(2026, 9, 9, 23, 30))).toBe("2026-10-09");
    expect(localDate(new Date(2026, 9, 10, 0, 30))).toBe("2026-10-10");
  });
});

describe("monthsEnding", () => {
  it("lists the months up to the date's, oldest first", () => {
    expect(monthsEnding("2026-02-15", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});

describe("resolvePeriod", () => {
  it("shows this month up to today, against the same days last month", () => {
    expect(resolve({ kind: "this-month" })).toEqual({
      from: "2026-10-01",
      to: "2026-10-09",
      span: "Oct 1 – 9, 2026",
      name: "October",
      previous: { from: "2026-09-01", to: "2026-09-09", label: "vs Sep 1 – 9" },
    });
  });

  it("compares the end of a long month with the end of a shorter one", () => {
    expect(resolve({ kind: "this-month" }, "2026-03-31").previous).toMatchObject({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("shows the whole of last month, against the month before", () => {
    expect(resolve({ kind: "last-month" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      span: "September 2026",
      name: "September",
      previous: { from: "2026-08-01", to: "2026-08-31", label: "vs August" },
    });
  });

  it("shows last month across a new year", () => {
    expect(resolve({ kind: "last-month" }, "2026-01-05")).toMatchObject({
      from: "2025-12-01",
      to: "2025-12-31",
      span: "December 2025",
    });
  });

  it("shows the last 3 months from the start of the first, against the 3 before", () => {
    expect(resolve({ kind: "last-3-months" })).toEqual({
      from: "2026-08-01",
      to: "2026-10-09",
      span: "Aug 1 – Oct 9, 2026",
      name: "3 months",
      previous: { from: "2026-05-01", to: "2026-07-09", label: "vs prior 3 months" },
    });
  });

  it("shows the last 6 months", () => {
    expect(resolve({ kind: "last-6-months" })).toMatchObject({
      from: "2026-05-01",
      to: "2026-10-09",
      name: "6 months",
    });
  });

  it("shows the last 12 months as last year", () => {
    expect(resolve({ kind: "last-year" })).toMatchObject({
      from: "2025-11-01",
      to: "2026-10-09",
      span: "Nov 1, 2025 – Oct 9, 2026",
      name: "12 months",
      previous: { from: "2024-11-01", to: "2025-10-09", label: "vs prior 12 months" },
    });
  });

  it("shows all from the first transaction to today, with nothing to compare", () => {
    expect(resolve({ kind: "all" })).toEqual({
      from: "2024-03-14",
      to: "2026-10-09",
      span: "Mar 2024 – Oct 2026",
      name: "All time",
      previous: null,
    });
  });

  it("includes transactions dated after today in all", () => {
    expect(resolve({ kind: "all" }, TODAY, { first: "2024-03-14", last: "2026-11-02" }).to).toBe(
      "2026-11-02",
    );
  });

  it("shows just today for all without transactions", () => {
    expect(resolve({ kind: "all" }, TODAY, { first: null, last: null })).toMatchObject({
      from: TODAY,
      to: TODAY,
    });
  });

  it("shows a custom range, with nothing to compare", () => {
    expect(resolve({ kind: "custom", from: "2026-08-15", to: "2026-10-09" })).toEqual({
      from: "2026-08-15",
      to: "2026-10-09",
      span: "Aug 15 – Oct 9, 2026",
      name: "Aug 15 – Oct 9",
      previous: null,
    });
  });

  it("puts a custom range's dates in order", () => {
    expect(resolve({ kind: "custom", from: "2026-10-09", to: "2026-08-15" })).toMatchObject({
      from: "2026-08-15",
      to: "2026-10-09",
    });
  });
});
