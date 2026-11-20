/**
 * The on-screen controls drawn over the camera (WebXR "dom-overlay").
 *
 * Mirrors ar.html's non-technical redesign: one hint at the top telling the
 * user what to do next, one big primary action at the bottom per stage
 * (Start AR, Place, then the placed controls), and everything technical
 * folded under "More options".
 *
 * @param project     the project being viewed
 * @param ui          latest controller snapshot (null while loading)
 * @param controller  ref to the ArController that buttons call into
 * @param onStart     starts the XR session (must run inside the tap handler)
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import type { Project } from "@/lib/db/db";
import { formatFootprint, fromDisplayLength, toDisplayLength, unitSuffix } from "@/lib/plan";
import { useSettings } from "@/stores/settings";
import type { ArController, ArUiState } from "./ArController";
import { DENOM_MAX, DENOM_MIN } from "./ArController";
import styles from "./ar.module.css";

interface ArOverlayProps {
  project: Project;
  ui: ArUiState | null;
  controller: React.MutableRefObject<ArController | null>;
  onStart: () => void;
}

const ROTATE_STEP_DEG = 15;

const HUB_TEXT = {
  open: "Live map connected",
  connecting: "Connecting to live map…",
  reconnecting: "Live map not reachable",
  closed: "Live map off",
} as const;

export function ArOverlay({ project, ui, controller, onStart }: ArOverlayProps) {
  const units = useSettings((s) => s.units);
  const [hidden, setHidden] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const c = () => controller.current;

  if (!ui) {
    return (
      <div className={styles.top}>
        <p className={styles.hint} role="status">
          Loading…
        </p>
      </div>
    );
  }

  const phone = ui.phone;
  const life = Math.round(phone.model_denom) === 1;
  const sizeLabel = life
    ? `Life-size, ${formatFootprint(phone.plan_w_m, phone.plan_d_m, units)}`
    : `Tabletop 1:${Math.round(phone.model_denom)}, ${Math.round(phone.model_w_cm)} x ${Math.round(phone.model_d_cm)} cm`;

  return (
    <>
      <div className={styles.top}>
        <div className={styles.topRow}>
          <Link className={`btn ${styles.chip}`} to={`/projects/${project.id}`} onClick={() => c()?.end()}>
            Exit
          </Link>
          <span className={styles.chip} role="status">
            <span className={`dot ${ui.hub === "open" ? "dot-live" : "dot-warn"}`} aria-hidden="true" /> {HUB_TEXT[ui.hub]}
          </span>
          {ui.stage === "placed" && (
            <button type="button" className={`btn ${styles.chip}`} aria-pressed={hidden} onClick={() => setHidden(!hidden)}>
              {hidden ? "Show controls" : "Hide controls"}
            </button>
          )}
        </div>
        {!hidden && (
          <p className={styles.hint} role="status" aria-live="polite">
            {ui.hint}
          </p>
        )}
        {ui.errors.length > 0 && (
          <div className={`notice notice-error ${styles.errors}`} role="alert">
            {ui.errors.map((e, i) => (
              <span key={i}>{e}</span>
            ))}
          </div>
        )}
      </div>

      {!hidden && (
        <div className={styles.sheet}>
          {(ui.stage === "loading" || ui.stage === "ready") && (
            <>
              <h1 className={styles.title}>{project.name}</h1>
              <p className="small">
                {formatFootprint(phone.plan_w_m, phone.plan_d_m, units)}. Point the phone at the floor or a table after you start.
              </p>
              <button className="btn btn-primary btn-block" type="button" disabled={!ui.canStart} onClick={onStart}>
                {ui.stage === "loading" ? "Checking AR…" : "Start AR"}
              </button>
            </>
          )}

          {ui.stage === "aiming" && (
            <button className="btn btn-primary btn-block" type="button" disabled={!ui.canPlace} onClick={() => c()?.tryPlace()}>
              Place here
            </button>
          )}

          {ui.stage === "fake" && (
            <>
              <h1 className={styles.title}>Test walk</h1>
              <p className="small">{ui.fakePose ?? "Starting…"}</p>
              <p className="small muted">Open the live map on a computer to see the dot move.</p>
            </>
          )}

          {ui.stage === "placed" && (
            <PlacedControls ui={ui} sizeLabel={sizeLabel} life={life} units={units} controller={controller} showDebug={showDebug} onDebug={setShowDebug} />
          )}
        </div>
      )}
    </>
  );
}

interface PlacedControlsProps {
  ui: ArUiState;
  sizeLabel: string;
  life: boolean;
  units: ReturnType<typeof useSettings.getState>["units"];
  controller: React.MutableRefObject<ArController | null>;
  showDebug: boolean;
  onDebug: (on: boolean) => void;
}

function PlacedControls({ ui, sizeLabel, life, units, controller, showDebug, onDebug }: PlacedControlsProps) {
  const c = () => controller.current;
  const phone = ui.phone;
  const [lengthText, setLengthText] = useState<string | null>(null);
  const shownLength = lengthText ?? String(Math.round(toDisplayLength(phone.real_longest_m, units) * 10) / 10);

  return (
    <div className="stack" style={{ gap: "var(--space-3)" }}>
      <p className={styles.status}>{sizeLabel}</p>
      <div className="seg" role="group" aria-label="Size">
        <button type="button" aria-pressed={!life} onClick={() => c()?.setTabletop()}>
          Tabletop
        </button>
        <button type="button" aria-pressed={life} onClick={() => c()?.setLifeSize()}>
          Life-size
        </button>
      </div>

      <div className={styles.inline}>
        <button className="btn" type="button" onClick={() => c()?.nudgeYaw(-ROTATE_STEP_DEG)} aria-label="Turn left 15 degrees">
          Turn left
        </button>
        <button className="btn" type="button" onClick={() => c()?.nudgeYaw(ROTATE_STEP_DEG)} aria-label="Turn right 15 degrees">
          Turn right
        </button>
      </div>

      <form
        className={styles.inline}
        onSubmit={(e) => {
          e.preventDefault();
          const meters = fromDisplayLength(Number(shownLength.replace(",", ".")), units);
          if (meters > 0) c()?.setRealLongest(meters);
          setLengthText(null);
        }}
      >
        <label htmlFor="ar-length" className={styles.inlineLabel}>
          Building length
        </label>
        <div className="with-unit" style={{ flex: 1 }}>
          <input id="ar-length" className="input" inputMode="decimal" value={shownLength} onChange={(e) => setLengthText(e.target.value)} onBlur={(e) => e.currentTarget.form?.requestSubmit()} />
          <span className="unit">{unitSuffix(units)}</span>
        </div>
      </form>

      <details className={styles.more}>
        <summary>More options</summary>
        <div className="stack" style={{ gap: "var(--space-3)" }}>
          <div className="field">
            <label htmlFor="ar-denom">Model scale 1:{Math.round(phone.model_denom)}</label>
            <input id="ar-denom" type="range" min={DENOM_MIN} max={DENOM_MAX} step={1} value={Math.round(phone.model_denom)} onChange={(e) => c()?.setDenom(e.target.valueAsNumber)} />
          </div>
          <div className="field">
            <label htmlFor="ar-yaw">Turn {Math.round(phone.rotation_deg)} degrees</label>
            <input id="ar-yaw" type="range" min={0} max={359} step={1} value={Math.round(phone.rotation_deg)} onChange={(e) => c()?.setYaw(e.target.valueAsNumber)} />
          </div>
          <label className="check">
            <input type="checkbox" checked={phone.auto_fit} onChange={(e) => c()?.setAutoFit(e.target.checked)} />
            <span>Fit to the table automatically</span>
          </label>
          <div className={styles.inline}>
            <button className="btn" type="button" disabled={!ui.canDropToFloor} onClick={() => c()?.dropToFloor()}>
              Drop to floor
            </button>
            <button className="btn" type="button" onClick={() => c()?.requestReanchor()}>
              Re-anchor here
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={showDebug} onChange={(e) => onDebug(e.target.checked)} />
            <span>Show tracking details</span>
          </label>
          {showDebug && <pre className={styles.debug}>{ui.debug || "Collecting…"}</pre>}
        </div>
      </details>

      <button className="btn btn-block" type="button" onClick={() => c()?.resetPlacement()}>
        Start over
      </button>
    </div>
  );
}
