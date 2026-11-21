/**
 * PlanVisAR mark: a map pin whose head is a floor plan, standing on an orange
 * anchor ring ("the plan, placed at a real spot"). Colours come from CSS:
 * currentColor = pin body, --accent = ring + dot, --paper = plan lines (knockout).
 * public/icons/logo.svg and the PNG icons are rendered from the same paths
 * (scripts/icons.mjs), so change them together.
 */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="32" cy="58.5" rx="11" ry="3" stroke="var(--accent)" strokeWidth="2.5" />
      <path
        d="M32 5 C19.5 5 11.5 14.2 11.5 25.5 C11.5 39.5 32 56 32 56 C32 56 52.5 39.5 52.5 25.5 C52.5 14.2 44.5 5 32 5 Z"
        fill="currentColor"
      />
      <path d="M28 35 H22 V16 H42 V35 H33" stroke="var(--paper)" strokeWidth="2.6" />
      <path d="M32 16 V23 M22 26 H28" stroke="var(--paper)" strokeWidth="2.6" />
      <circle cx="37" cy="29" r="2.6" fill="var(--accent)" />
    </svg>
  );
}

/** Wordmark: lower-case "planvis" in ink, "ar" in the accent. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className} aria-label="PlanVisAR">
      <span aria-hidden="true">
        planvis<span style={{ color: "var(--accent)" }}>ar</span>
      </span>
    </span>
  );
}
