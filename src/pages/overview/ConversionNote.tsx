import { useId, useState } from "react";
import { conversionNote } from "./conversionNoteText.ts";

/**
 * An asterisk after an amount that isn't only what's stored (see
 * `conversionNote`), which says so when it's hovered, focused or pressed:
 * pressing is how a touch screen asks. Nothing when there's nothing to say.
 */
function ConversionNote({ estimated, skipped }: { estimated: number; skipped: number }) {
  const id = useId();
  // Pressing keeps it open until it's pressed again, or loses focus.
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const note = conversionNote(estimated, skipped);
  if (note === null) return null;
  const open = pinned || hovered || focused;

  return (
    <span className="relative inline-block align-top text-[0.5em] leading-none">
      <button
        type="button"
        aria-label="About this amount"
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setPinned(!pinned)}
        // Not for touch, where there's no hovering.
        onPointerEnter={(event) => event.pointerType === "mouse" && setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={(event) => setFocused(event.currentTarget.matches(":focus-visible"))}
        onBlur={() => {
          setFocused(false);
          setPinned(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          setPinned(false);
          setFocused(false);
        }}
        className="cursor-help rounded-sm px-[0.08em] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        *
      </button>
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none absolute top-full left-0 z-10 mt-1 w-max max-w-64 rounded-md bg-ink px-2.5 py-1.5 font-sans text-xs leading-snug font-medium tracking-normal text-canvas ${
          open ? "" : "invisible"
        }`}
      >
        {note}
      </span>
    </span>
  );
}

export default ConversionNote;
