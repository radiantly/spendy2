import { useId, type ReactNode } from "react";

/** Small uppercase label, e.g. "TOP CATEGORIES". */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-mono text-xs font-medium tracking-[0.14em] uppercase ${className}`}>
      {children}
    </span>
  );
}

type CardProps = {
  title: string;
  /** Next to the title, e.g. a link or a count. */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
};

/** A titled section of the overview on the page's surface colour. */
export function Card({ title, aside, className = "", children }: CardProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={`flex min-w-0 flex-col gap-5 rounded-[28px] border border-line bg-surface p-6 lg:p-7 ${className}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id={titleId} className="font-display text-2xl font-bold tracking-tight">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A link styled to sit in a card. */
export const cardLinkClass =
  "text-sm font-semibold underline underline-offset-4 outline-none hover:text-ink-muted focus-visible:ring-3 focus-visible:ring-focus rounded-sm";
