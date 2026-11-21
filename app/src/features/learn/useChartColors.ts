/**
 * Chart colours as concrete hex values.
 *
 * Recharts writes colours into SVG attributes (fill="..."), where CSS
 * variables are not reliable, so we read the tokens once and again whenever
 * the OS switches light/dark.
 *
 * Palette: categorical slots 1-3 of the dataviz reference palette (blue,
 * orange, aqua), validated with the skill's validate_palette.js against our
 * own surfaces (#fafaf7 light, #0d1c1c dark): all checks pass; light aqua is under
 * 3:1, so every chart also ships a data table (the "relief" rule). Single-series
 * charts use plain ink, in keeping with the black-and-white drawing style.
 */
import { useEffect, useState } from "react";

export interface ChartColors {
  ink: string;
  muted: string;
  grid: string;
  paper: string;
  series: [string, string, string];
}

const LIGHT: ChartColors = { ink: "#12302f", muted: "#55625f", grid: "#dfe4e0", paper: "#fafaf7", series: ["#2a78d6", "#eb6834", "#1baf7a"] };
const DARK: ChartColors = { ink: "#edf2f0", muted: "#9fb0ab", grid: "#1e3a3a", paper: "#0d1c1c", series: ["#3987e5", "#d95926", "#199e70"] };

function isDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function useChartColors(): ChartColors {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => setDark(isDark());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark ? DARK : LIGHT;
}
