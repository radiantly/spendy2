import { FiTrendingUp } from "react-icons/fi";

type LogoProps = {
  /** Use when the logo sits on a lime background. */
  onLime?: boolean;
};

function Logo({ onLime = false }: LogoProps) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        className={`grid size-9 place-items-center rounded-full ${
          onLime ? "bg-ink-on-lime text-lime" : "bg-lime text-ink-on-lime"
        }`}
      >
        <FiTrendingUp className="size-5" strokeWidth={2.5} aria-hidden />
      </span>
      <span className="font-display text-2xl font-bold tracking-tight">
        spendy
      </span>
    </span>
  );
}

export default Logo;
