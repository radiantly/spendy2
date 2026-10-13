import type { DateRange } from "./period.ts";

type CustomRangeInputsProps = {
  range: DateRange;
  onChange: (range: DateRange) => void;
  /** The heading's type, so the dates read as the heading they replace. */
  className?: string;
};

const inputClass =
  "border-b-3 border-ink bg-transparent outline-none focus-visible:border-focus focus-visible:ring-0";

/** A custom range's dates, edited in place of the period's heading. */
function CustomRangeInputs({ range, onChange, className = "" }: CustomRangeInputsProps) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 ${className}`}>
      <input
        type="date"
        aria-label="From"
        value={range.from}
        // Cleared, the date is kept until a new one is picked.
        onChange={(event) => event.target.value && onChange({ ...range, from: event.target.value })}
        className={inputClass}
      />
      <span aria-hidden className="text-ink-muted">
        –
      </span>
      <input
        type="date"
        aria-label="To"
        value={range.to}
        onChange={(event) => event.target.value && onChange({ ...range, to: event.target.value })}
        className={inputClass}
      />
    </div>
  );
}

export default CustomRangeInputs;
