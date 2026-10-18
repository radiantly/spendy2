/**
 * The periods the overview can show, and the transactions' dates can be
 * filtered to, on local dates as the schema stores them (`YYYY-MM-DD`, no
 * time zone). Date maths runs on UTC midnights so
 * daylight saving never shifts a day.
 */

export type NaiveDate = string;

/** Inclusive at both ends. */
export type DateRange = { from: NaiveDate; to: NaiveDate };

/**
 * Whole months: a month, or the last 3, 6 or 12 up to the end of this one.
 * Or everything.
 */
export const PRESETS = [
  { id: "this-month", label: "This month" },
  { id: "last-month", label: "Last month" },
  { id: "last-3-months", label: "Last 3 months" },
  { id: "last-6-months", label: "Last 6 months" },
  // "Last 12 months" wouldn't leave room beside a custom range's dates.
  { id: "last-12-months", label: "Last year" },
  { id: "all", label: "All" },
] as const;

export type Preset = (typeof PRESETS)[number]["id"];

export type PeriodChoice = { kind: Preset } | ({ kind: "custom" } & DateRange);

export type Period = DateRange & {
  /** The whole period, e.g. "October 2026", "Aug – Oct 2026" or "Aug 15 – Oct 9, 2026". */
  span: string;
  /** A short name, e.g. "October" or "3 months". */
  name: string;
  /** The period to compare with, if there's a fair one. */
  previous: (DateRange & { label: string }) | null;
};

function toDate(date: NaiveDate) {
  return new Date(`${date}T00:00:00Z`);
}

function fromDate(date: Date): NaiveDate {
  return date.toISOString().slice(0, 10);
}

/** The local date at `time`. */
export function localDate(time: Date): NaiveDate {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
}

export function today(): NaiveDate {
  return localDate(new Date());
}

export function addDays(date: NaiveDate, days: number): NaiveDate {
  const result = toDate(date);
  result.setUTCDate(result.getUTCDate() + days);
  return fromDate(result);
}

/** The same day `months` later, or the month's last day if it's shorter. */
export function addMonths(date: NaiveDate, months: number): NaiveDate {
  const source = toDate(date);
  const target = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(source.getUTCDate(), lastDay));
  return fromDate(target);
}

export function startOfMonth(date: NaiveDate): NaiveDate {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: NaiveDate): NaiveDate {
  return addDays(addMonths(startOfMonth(date), 1), -1);
}

/** The number of days from `from` to `to`, both included. */
export function daysIn({ from, to }: DateRange) {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000) + 1;
}

const format = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });

const DAY = format({ month: "short", day: "numeric", year: "numeric" });
const DAY_NO_YEAR = format({ month: "short", day: "numeric" });
const MONTH = format({ month: "long" });
const MONTH_YEAR = format({ month: "long", year: "numeric" });
const SHORT_MONTH_YEAR = format({ month: "short", year: "numeric" });

/** e.g. "Oct 1 – 9, 2026", or without the year "Oct 1 – 9". */
export function formatRange({ from, to }: DateRange, { year = true } = {}) {
  return (year ? DAY : DAY_NO_YEAR).formatRange(toDate(from), toDate(to));
}

/** e.g. "Oct 9, 2026". */
export function formatDay(date: NaiveDate, { year = true } = {}) {
  return (year ? DAY : DAY_NO_YEAR).format(toDate(date));
}

/** The last `count` months, from the `count - 1`th month before `date`'s to the end of `date`'s. */
function lastMonths(date: NaiveDate, count: number): DateRange {
  return { from: startOfMonth(addMonths(date, -(count - 1))), to: endOfMonth(date) };
}

const LAST_MONTHS = { "last-3-months": 3, "last-6-months": 6, "last-12-months": 12 } as const;

/**
 * Where `choice` starts and ends on `today`. "All" spans the transactions
 * from the first (`first`) up to today, or the last if that's later.
 */
export function resolvePeriod(
  choice: PeriodChoice,
  today: NaiveDate,
  { first, last }: { first: NaiveDate | null; last: NaiveDate | null },
): Period {
  switch (choice.kind) {
    case "this-month": {
      const from = startOfMonth(today);
      // The same days of last month as have gone by of this one.
      const previous = { from: addMonths(from, -1), to: addMonths(today, -1) };
      return {
        from,
        to: endOfMonth(today),
        span: MONTH_YEAR.format(toDate(today)),
        name: MONTH.format(toDate(today)),
        previous: { ...previous, label: `vs ${formatRange(previous, { year: false })}` },
      };
    }
    case "last-month": {
      const from = startOfMonth(addMonths(today, -1));
      const previousFrom = addMonths(from, -1);
      return {
        from,
        to: endOfMonth(from),
        span: MONTH_YEAR.format(toDate(from)),
        name: MONTH.format(toDate(from)),
        previous: {
          from: previousFrom,
          to: endOfMonth(previousFrom),
          label: `vs ${MONTH.format(toDate(previousFrom))}`,
        },
      };
    }
    case "last-3-months":
    case "last-6-months":
    case "last-12-months": {
      const months = LAST_MONTHS[choice.kind];
      const range = lastMonths(today, months);
      return {
        ...range,
        span: SHORT_MONTH_YEAR.formatRange(toDate(range.from), toDate(range.to)),
        name: `${months} months`,
        // As many days before as have gone by of these.
        previous: {
          from: addMonths(range.from, -months),
          to: addMonths(today, -months),
          label: `vs prior ${months} months`,
        },
      };
    }
    case "all": {
      const to = last !== null && last > today ? last : today;
      const from = first !== null && first < to ? first : to;
      return {
        from,
        to,
        span: SHORT_MONTH_YEAR.formatRange(toDate(from), toDate(to)),
        name: "All time",
        previous: null,
      };
    }
    case "custom": {
      const range = choice.from <= choice.to ? choice : { from: choice.to, to: choice.from };
      return {
        from: range.from,
        to: range.to,
        span: formatRange(range),
        name: formatRange(range, { year: false }),
        previous: null,
      };
    }
  }
}

/** The `count` months up to `date`'s, oldest first, as `YYYY-MM`. */
export function monthsEnding(date: NaiveDate, count: number) {
  return Array.from({ length: count }, (_, i) =>
    addMonths(startOfMonth(date), i - (count - 1)).slice(0, 7),
  );
}

/** e.g. "Oct" for "2026-10". */
export function monthLabel(month: string) {
  return format({ month: "short" }).format(toDate(`${month}-01`));
}

/** e.g. "Mar 2024", for labelling long periods. */
export function formatMonth(date: NaiveDate) {
  return SHORT_MONTH_YEAR.format(toDate(date));
}
