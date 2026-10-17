import { FaCaretDown } from "react-icons/fa6";

type CurrencyPickerProps = {
  /** The most used first. */
  currencies: readonly string[];
  value: string;
  onChange: (currency: string) => void;
};

/** The currency the overview's amounts are in, as a pill on the lime Spent card. */
function CurrencyPicker({ currencies, value, onChange }: CurrencyPickerProps) {
  return (
    <div className="relative">
      <select
        aria-label="Currency"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // As tall as the comparison pill, border included. The usual lime
        // focus ring wouldn't show on the lime card.
        className="appearance-none rounded-full border border-ink-on-lime bg-transparent py-1.25 pr-9 pl-3.5 font-mono text-sm text-ink-on-lime outline-none focus-visible:ring-3 focus-visible:ring-ink-on-lime focus-visible:ring-offset-2 focus-visible:ring-offset-lime"
      >
        {currencies.map((currency) => (
          <option key={currency} value={currency}>
            {currency}
          </option>
        ))}
      </select>
      <FaCaretDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-[11px] text-ink-on-lime"
      />
    </div>
  );
}

export default CurrencyPicker;
