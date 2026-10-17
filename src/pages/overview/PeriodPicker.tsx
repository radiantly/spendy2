import { FaCaretDown } from "react-icons/fa6";
import { PRESETS, type DateRange, type PeriodChoice } from "./period.ts";

type PeriodPickerProps = {
  choice: PeriodChoice;
  /** The period shown, which a custom range starts from. */
  current: DateRange;
  onChange: (choice: PeriodChoice) => void;
};

const CHOICES = [...PRESETS, { id: "custom", label: "Custom" }] as const;
type ChoiceId = (typeof CHOICES)[number]["id"];

const pillClass = (pressed: boolean) =>
  `min-h-9 rounded-full px-3.5 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-focus ${
    pressed ? "bg-ink text-canvas" : "text-ink-muted hover:text-ink"
  }`;

/**
 * The preset periods, and a custom range (its dates are edited in the
 * heading). Where the buttons would need more than one row, they're a
 * dropdown instead.
 */
function PeriodPicker({ choice, current, onChange }: PeriodPickerProps) {
  function choose(id: ChoiceId) {
    if (id !== "custom") onChange({ kind: id });
    // Starts from the period shown; picking it again keeps the dates.
    else if (choice.kind !== "custom") onChange({ kind: "custom", ...current });
  }

  return (
    <>
      {/* The buttons take 692px, which fits from 724px with the page's padding. */}
      <div
        role="group"
        aria-label="Choose period"
        className="hidden flex-wrap gap-1 rounded-full border border-line bg-surface p-1 md:flex"
      >
        {CHOICES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={choice.kind === id}
            onClick={() => choose(id)}
            className={pillClass(choice.kind === id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="relative md:hidden">
        <select
          aria-label="Choose period"
          value={choice.kind}
          onChange={(event) => choose(event.target.value as ChoiceId)}
          className="min-h-10 appearance-none rounded-full border border-line bg-surface pr-10 pl-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-focus"
        >
          {CHOICES.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <FaCaretDown
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-[11px] text-ink-muted"
        />
      </div>
    </>
  );
}

export default PeriodPicker;
