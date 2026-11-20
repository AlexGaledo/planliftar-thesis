/**
 * Line icons for the main navigation, drawn in the same 1.5px "ink" stroke as
 * the plans themselves. Inline SVG: no icon font to download, works offline,
 * inherits currentColor for light/dark mode.
 */
export type NavIconName = "projects" | "new" | "map" | "learn" | "settings";

const PATHS: Record<NavIconName, string> = {
  // a floor plan: outer wall with one interior wall and a door gap
  projects: "M3 3h18v18H3zM12 3v7M12 14v7M12 14h9",
  new: "M12 5v14M5 12h14",
  // location pin over a plan grid
  map: "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14",
  // open book
  learn: "M3 5c3-1 6-1 9 1 3-2 6-2 9-1v14c-3-1-6-1-9 1-3-2-6-2-9-1zM12 6v14",
  // sliders
  settings: "M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4",
};

export function NavIcon({ name, size = 22 }: { name: NavIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
