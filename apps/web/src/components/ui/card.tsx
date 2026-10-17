import type { ReactNode } from "react";

function cx(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(" ");
}

type CardProps = {
  children: ReactNode;
  /** Hover and focus lift (M10). */
  lift?: boolean;
  className?: string;
};

export function Card({ children, lift, className }: CardProps) {
  return (
    <div
      className={cx(
        "rounded-xl border border-rule bg-bg-elev p-5",
        lift && "lift",
        className,
      )}
    >
      {children}
    </div>
  );
}

const CHIP_VARIANTS = {
  neutral: "border-rule text-fg-muted",
  accent: "border-accent/40 text-accent",
  preview: "border-warn/40 text-warn",
} as const;

type ChipProps = {
  children: ReactNode;
  variant?: keyof typeof CHIP_VARIANTS;
};

export function Chip({ children, variant = "neutral" }: ChipProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider",
        CHIP_VARIANTS[variant],
      )}
    >
      {children}
    </span>
  );
}

type StatProps = {
  value: ReactNode;
  label: ReactNode;
  /** Claim class from docs/claims.md, e.g. "measured". */
  tag?: string;
};

export function Stat({ value, label, tag }: StatProps) {
  return (
    <div>
      <p className="text-3xl font-extrabold tracking-tight text-fg tabular-nums">
        {value}
      </p>
      <p className="mt-1 text-sm text-fg-muted">{label}</p>
      {tag ? <p className="type-caption mt-1">{tag}</p> : null}
    </div>
  );
}
