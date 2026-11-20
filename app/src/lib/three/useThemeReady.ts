/**
 * React side of the theme's async contract (docs/research/bakeoff/DECISION.md W5).
 *
 * `ready` turns true once the theme's preload() has settled. `canBuild` turns
 * true at the same moment, or after `graceMs` if the assets are slow, so a
 * stalled network shows the untextured model instead of an empty canvas. A
 * caller that builds on `canBuild` and keys its build on `ready` rebuilds
 * exactly once when the textures and kit models arrive late.
 */
import { useEffect, useState } from "react";
import { DEFAULT_THEME, preloadTheme, themeReady, type SurfaceTheme } from "./surfaceTheme";

export function useThemeReady(theme: SurfaceTheme = DEFAULT_THEME, graceMs = 1500): { ready: boolean; canBuild: boolean } {
  const [ready, setReady] = useState(() => themeReady(theme));
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    if (ready) return;
    let alive = true;
    void preloadTheme(theme).then(() => alive && setReady(true));
    const t = setTimeout(() => alive && setGraceOver(true), graceMs);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [theme, ready, graceMs]);
  return { ready, canBuild: ready || graceOver };
}
