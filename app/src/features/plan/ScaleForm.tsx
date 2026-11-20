/**
 * "How big is it?" Set the real-world scale from ONE known dimension.
 *
 * Two ways, same result (a single ppm = plan px per metre):
 *  - Building length: the longest side of the footprint (what ar.html calls
 *    "Building length", real_longest_m in PROTOCOL.md).
 *  - One wall: tap a wall on the drawing and type its real length.
 *
 * Also sets wall height. Values are typed in the user's units (Settings) and
 * stored in metres.
 *
 * @param project        the project being edited
 * @param plan/bounds    its prepared plan and footprint
 * @param selectedWallId wall picked on the overlay (for "One wall" mode)
 * @param mode/onMode    which reference the form is using (lifted so the
 *                       overlay knows whether wall picking is active)
 */
import { useEffect, useState } from "react";
import type { Project } from "@/lib/db/db";
import { setProjectScale, setWallHeight } from "@/lib/db/projects";
import {
  clampRealLongest,
  formatFootprint,
  formatLength,
  fromDisplayLength,
  longestSidePx,
  ppmFromReference,
  toDisplayLength,
  unitSuffix,
  wallLengthPx,
  type Plan,
  type PlanBounds,
} from "@/lib/plan";
import { useSettings } from "@/stores/settings";
import { wallKey } from "./labels";

export type ScaleMode = "longest" | "wall";

interface ScaleFormProps {
  project: Project;
  plan: Plan;
  bounds: PlanBounds;
  selectedWallId: string | null;
  mode: ScaleMode;
  onMode: (mode: ScaleMode) => void;
  onSelectWall: (id: string) => void;
}

const HEIGHT_MIN_M = 0.1;
const HEIGHT_MAX_M = 10;

const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "");

export function ScaleForm({ project, plan, bounds, selectedWallId, mode, onMode, onSelectWall }: ScaleFormProps) {
  const units = useSettings((s) => s.units);
  const suffix = unitSuffix(units);
  const longestPx = longestSidePx(bounds);
  const walls = plan.walls.map((w, i) => ({ id: wallKey(w, i), px: wallLengthPx(w), generated: !!w.generated }));
  const selected = walls.find((w) => w.id === selectedWallId) ?? null;
  const selectedPx = selected?.px ?? null;

  const currentLongestM = longestPx / project.ppm;
  const [lengthText, setLengthText] = useState("");
  const [heightText, setHeightText] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Refill inputs from the stored values whenever they (or the units) change.
  useEffect(() => {
    if (mode === "longest") setLengthText(fmt(toDisplayLength(currentLongestM, units)));
    else setLengthText(selectedPx ? fmt(toDisplayLength(selectedPx / project.ppm, units)) : "");
    // Depend on the numbers, not on `selected` (a new object every render would
    // reset the field while the user types).
  }, [mode, currentLongestM, selectedPx, project.ppm, units]);
  useEffect(() => setHeightText(fmt(toDisplayLength(project.wallHeightM, units))), [project.wallHeightM, units]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const typed = Number(lengthText.replace(",", "."));
    const meters = fromDisplayLength(typed, units);
    if (!(meters > 0)) {
      setMessage({ kind: "error", text: `Type the real length in ${suffix}, for example 12.5.` });
      return;
    }
    const refPx = mode === "longest" ? longestPx : selected?.px;
    if (!refPx) {
      setMessage({ kind: "error", text: "Tap a wall on the drawing first." });
      return;
    }
    // Keep the building inside the protocol's 0.5..500 m range.
    const ppm = ppmFromReference(refPx, meters);
    const clampedPpm = ppm ? longestPx / clampRealLongest(longestPx / ppm) : null;
    const height = fromDisplayLength(Number(heightText.replace(",", ".")), units);
    if (!clampedPpm) {
      setMessage({ kind: "error", text: "That length does not give a usable scale." });
      return;
    }
    if (!(height >= HEIGHT_MIN_M && height <= HEIGHT_MAX_M)) {
      setMessage({ kind: "error", text: `Wall height must be between ${formatLength(HEIGHT_MIN_M, units)} and ${formatLength(HEIGHT_MAX_M, units)}.` });
      return;
    }
    await setProjectScale(project.id, clampedPpm, { kind: mode, wallId: mode === "wall" ? selected?.id : undefined, meters });
    await setWallHeight(project.id, height);
    setMessage({ kind: "ok", text: `Saved. The building is ${formatFootprint(bounds.widthPx / clampedPpm, bounds.heightPx / clampedPpm, units)}.` });
  }

  return (
    <form className="panel" onSubmit={onSubmit} aria-labelledby="scale-heading">
      <h2 id="scale-heading" className="field-label" style={{ fontSize: "var(--step-1)" }}>
        Real size
      </h2>
      <p className="small muted">
        Plans have no units. Tell us one real measurement and everything else scales from it.
      </p>
      <div className="seg" role="group" aria-label="Measure from">
        <button type="button" aria-pressed={mode === "longest"} onClick={() => onMode("longest")}>
          Building length
        </button>
        <button type="button" aria-pressed={mode === "wall"} onClick={() => onMode("wall")}>
          One wall
        </button>
      </div>

      {mode === "wall" && (
        <div className="field">
          <label htmlFor="wall-select">Wall</label>
          <select id="wall-select" className="select" value={selectedWallId ?? ""} onChange={(e) => onSelectWall(e.target.value)}>
            <option value="" disabled>
              Tap a wall on the drawing, or pick one
            </option>
            {walls
              .filter((w) => !w.generated)
              .sort((a, b) => b.px - a.px)
              .map((w, i) => (
                <option key={w.id} value={w.id}>
                  {`Wall ${i + 1} (${formatLength(w.px / project.ppm, units)} now)`}
                </option>
              ))}
          </select>
        </div>
      )}

      <div className="field">
        <label htmlFor="real-length">{mode === "longest" ? "Longest side of the building" : "Real length of that wall"}</label>
        <div className="with-unit">
          <input id="real-length" className="input" inputMode="decimal" value={lengthText} onChange={(e) => setLengthText(e.target.value)} />
          <span className="unit">{suffix}</span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="wall-height">Wall height</label>
        <div className="with-unit">
          <input id="wall-height" className="input" inputMode="decimal" value={heightText} onChange={(e) => setHeightText(e.target.value)} />
          <span className="unit">{suffix}</span>
        </div>
      </div>

      <p className="small">
        Now: <strong>{formatFootprint(bounds.widthPx / project.ppm, bounds.heightPx / project.ppm, units)}</strong>
        {project.scaleReference ? "" : " (estimated, not yet measured)"}
      </p>
      {message && (
        <p className={`notice small ${message.kind === "error" ? "notice-error" : "notice-live"}`} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      )}
      <button className="btn btn-primary" type="submit">
        Save size
      </button>
    </form>
  );
}
