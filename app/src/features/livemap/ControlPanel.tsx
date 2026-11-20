/**
 * Remote controls for the phone's AR view (port of index.html's control panel).
 *
 * Rules carried over from the prototype, all from PROTOCOL.md:
 *  - The phone is authoritative. The panel renders from the phone's "state"
 *    messages, never from what it last sent (the phone clamps and may auto-fit).
 *  - Slider drags are queued and sent at most ~10 times a second; releasing
 *    the slider (or leaving a field) sends the final value immediately.
 *  - A control the user is touching is not overwritten by incoming state; it
 *    catches up when they let go.
 *
 * @param state        latest phone state, or null when no phone has reported
 * @param sendControl  sends {"type":"control","patch":...} to the hub
 */
import { useEffect, useRef, useState } from "react";
import type { ControlPatch, PhoneState } from "@/lib/hub/protocol";
import { formatFootprint, fromDisplayLength, toDisplayLength, unitSuffix } from "@/lib/plan";
import { useSettings } from "@/stores/settings";
import styles from "./livemap.module.css";

type Key = "real_longest_m" | "model_denom" | "auto_fit" | "wall_height_m" | "wall_opacity" | "rotation_deg";
type Values = Record<Key, number | boolean>;

interface ControlPanelProps {
  state: PhoneState | null;
  sendControl: (patch: ControlPatch) => boolean;
}

const SEND_INTERVAL_MS = 100;
const KEYS: Key[] = ["real_longest_m", "model_denom", "auto_fit", "wall_height_m", "wall_opacity", "rotation_deg"];

/** The two presets, identical to ar.html's buttons so phone and laptop agree. */
const TABLETOP: ControlPatch = { model_denom: 50, auto_fit: true };
const LIFE_SIZE: ControlPatch = { model_denom: 1, auto_fit: false, wall_opacity: 1 };

function pick(state: PhoneState): Values {
  return Object.fromEntries(KEYS.map((k) => [k, state[k]])) as Values;
}

function describeXr(xr: PhoneState["xr"]): string {
  switch (xr) {
    case "active":
      return "AR running";
    case "fake":
      return "test walk";
    case "unsupported":
      return "AR not supported on that phone";
    default:
      return "AR not started";
  }
}

export function ControlPanel({ state, sendControl }: ControlPanelProps) {
  const units = useSettings((s) => s.units);
  const [values, setValues] = useState<Values | null>(null);
  const interacting = useRef(new Set<Key>());
  const pending = useRef<Partial<Values>>({});
  const lastSent = useRef<Partial<Values>>({});
  const sendRef = useRef(sendControl);
  sendRef.current = sendControl;

  // Adopt the phone's state, except for controls the user is holding.
  useEffect(() => {
    if (!state) return;
    const incoming = pick(state);
    setValues((prev) => {
      const next = { ...incoming };
      if (prev) for (const k of interacting.current) next[k] = prev[k];
      return next;
    });
    // Seed so the ticker does not echo the phone's own values back to it.
    for (const k of KEYS) if (!interacting.current.has(k)) lastSent.current[k] = incoming[k];
  }, [state]);

  // Drain queued values ~10 times a second.
  useEffect(() => {
    const id = setInterval(() => {
      for (const k of Object.keys(pending.current) as Key[]) flush(k);
    }, SEND_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  function flush(k: Key) {
    if (!(k in pending.current)) return;
    const v = pending.current[k]!;
    delete pending.current[k];
    if (lastSent.current[k] === v) return;
    if (sendRef.current({ [k]: v } as ControlPatch)) lastSent.current[k] = v;
  }

  function change(k: Key, v: number | boolean) {
    setValues((prev) => (prev ? { ...prev, [k]: v } : prev));
    if (typeof v === "number" && !Number.isFinite(v)) return;
    pending.current[k] = v;
  }

  // Focus/pointer handlers that mark a control as "being used".
  const hold = (k: Key) => ({
    onFocus: () => interacting.current.add(k),
    onPointerDown: () => interacting.current.add(k),
    onBlur: () => {
      interacting.current.delete(k);
      flush(k);
      if (state) setValues((prev) => (prev ? { ...prev, [k]: state[k] } : prev));
    },
    onPointerUp: () => flush(k),
    onKeyUp: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") flush(k);
    },
  });

  if (!state || !values) {
    return (
      <section className={styles.panel} aria-labelledby="ctl-heading">
        <h2 id="ctl-heading" className={styles.panelTitle}>
          Phone controls
        </h2>
        <p className="small muted">Controls appear when a phone opens this plan in AR.</p>
      </section>
    );
  }

  const life = Math.round(state.model_denom) === 1;
  const suffix = unitSuffix(units);
  const num = (k: Key) => values[k] as number;

  return (
    <section className={styles.panel} aria-labelledby="ctl-heading">
      <h2 id="ctl-heading" className={styles.panelTitle}>
        Phone controls
      </h2>
      <p className="small" aria-live="polite">
        <strong>
          {life
            ? `${formatFootprint(state.plan_w_m, state.plan_d_m, units)}, life-size`
            : `${Math.round(state.model_w_cm || (state.plan_w_m * 100) / state.model_denom)} x ${Math.round(state.model_d_cm || (state.plan_d_m * 100) / state.model_denom)} cm tabletop model (1:${Math.round(state.model_denom)})`}
        </strong>
        <br />
        {state.placed ? "Placed" : "Not placed yet"}, {describeXr(state.xr)}
      </p>

      <div className="seg" role="group" aria-label="Size">
        <button type="button" aria-pressed={!life} onClick={() => sendControl(TABLETOP)}>
          Tabletop
        </button>
        <button type="button" aria-pressed={life} onClick={() => sendControl(LIFE_SIZE)}>
          Life-size
        </button>
      </div>

      <div className="field">
        <label htmlFor="ctl-longest">Building length</label>
        <div className="with-unit">
          <input
            id="ctl-longest"
            className="input"
            type="number"
            min={toDisplayLength(0.5, units)}
            max={toDisplayLength(500, units)}
            step={0.1}
            value={round(toDisplayLength(num("real_longest_m"), units), 2)}
            onChange={(e) => change("real_longest_m", fromDisplayLength(e.target.valueAsNumber, units))}
            {...hold("real_longest_m")}
          />
          <span className="unit">{suffix}</span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="ctl-rotation">Turn the model: {Math.round(num("rotation_deg"))} degrees</label>
        <input id="ctl-rotation" type="range" min={0} max={359} step={1} value={num("rotation_deg")} onChange={(e) => change("rotation_deg", e.target.valueAsNumber)} {...hold("rotation_deg")} />
      </div>

      <details className={styles.more}>
        <summary>More controls</summary>
        <div className="stack">
          <div className="field">
            <label htmlFor="ctl-denom">Model scale: 1:{Math.round(num("model_denom"))}</label>
            <input id="ctl-denom" type="range" min={1} max={200} step={1} value={num("model_denom")} onChange={(e) => change("model_denom", e.target.valueAsNumber)} {...hold("model_denom")} />
          </div>
          <label className="check">
            <input type="checkbox" checked={values.auto_fit as boolean} onChange={(e) => change("auto_fit", e.target.checked)} {...hold("auto_fit")} />
            <span>Fit to the table automatically</span>
          </label>
          <div className="field">
            <label htmlFor="ctl-height">Wall height</label>
            <div className="with-unit">
              <input
                id="ctl-height"
                className="input"
                type="number"
                min={toDisplayLength(0.1, units)}
                max={toDisplayLength(10, units)}
                step={0.1}
                value={round(toDisplayLength(num("wall_height_m"), units), 2)}
                onChange={(e) => change("wall_height_m", fromDisplayLength(e.target.valueAsNumber, units))}
                {...hold("wall_height_m")}
              />
              <span className="unit">{suffix}</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="ctl-opacity">Wall transparency: {Math.round(num("wall_opacity") * 100)}%</label>
            <input id="ctl-opacity" type="range" min={0.05} max={1} step={0.01} value={num("wall_opacity")} onChange={(e) => change("wall_opacity", e.target.valueAsNumber)} {...hold("wall_opacity")} />
          </div>
        </div>
      </details>

      <button className="btn btn-block" type="button" onClick={() => sendControl({ reset_placement: true })}>
        Place again on the phone
      </button>
    </section>
  );
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
