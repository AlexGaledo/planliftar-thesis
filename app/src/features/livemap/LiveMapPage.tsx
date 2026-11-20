/**
 * Live map: where the phone is inside the plan, right now.
 *
 * The phone (AR page) streams its position to the hub ~10 times a second; this
 * page connects as a "viewer", draws the dot/heading/trail, and can adjust the
 * phone's AR view through the control panel.
 *
 * Positions are plan pixels of the plan the PHONE has open, so both devices
 * must show the same plan (same file, gap closure on/off the same).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Project } from "@/lib/db/db";
import type { PreparedPlan } from "@/lib/db/hooks";
import { useHubUrl } from "@/lib/hub/useHubUrl";
import { useViewerHub } from "@/lib/hub/useViewerHub";
import type { PoseMessage } from "@/lib/hub/protocol";
import { ProjectGate } from "../plan/ProjectGate";
import { ControlPanel } from "./ControlPanel";
import { demoWalkPoses, demoWaypoints } from "./demoWalk";
import { MapCanvas, type LiveTrack } from "./MapCanvas";
import { TRAIL_MAX } from "./mapDrawing";
import styles from "./livemap.module.css";

export function LiveMapPage() {
  return <ProjectGate>{(ctx) => <LiveMap {...ctx} />}</ProjectGate>;
}

const LIVE_WITHIN_MS = 1500;
const HUD_TICK_MS = 250;

/** Demo walk: one pose per 100 ms at a slow walking pace (0.8 m/s). */
const DEMO_TICK_MS = 100;
const DEMO_SPEED_M_PER_S = 0.8;

const STATUS_TEXT = {
  connecting: "Connecting…",
  reconnecting: "Not connected to a phone, retrying…",
  open: "Connected",
  closed: "Disconnected",
} as const;

function LiveMap({ project, prepared }: { project: Project; prepared: PreparedPlan }) {
  const url = useHubUrl();
  const track = useRef<LiveTrack>({ latest: null, trail: [] });
  const [lastPoseAt, setLastPoseAt] = useState(0);
  const [now, setNow] = useState(() => performance.now());
  const [copied, setCopied] = useState(false);

  const onPose = useCallback((pose: PoseMessage) => {
    const t = track.current;
    t.latest = pose;
    t.trail.push({ x: pose.x, y: pose.y });
    if (t.trail.length > TRAIL_MAX) t.trail.shift();
    setLastPoseAt(performance.now());
  }, []);
  const hub = useViewerHub(url, onPose);

  // Simulated walker for demos without a phone; it feeds the same pose path a phone would.
  const [demoWalk, setDemoWalk] = useState(false);
  const demoPoses = useMemo(
    () =>
      demoWalkPoses(
        demoWaypoints(prepared.plan),
        (project.ppm * DEMO_SPEED_M_PER_S * DEMO_TICK_MS) / 1000,
      ),
    [prepared.plan, project.ppm],
  );
  useEffect(() => {
    if (!demoWalk || demoPoses.length === 0) return;
    let i = 0;
    const id = setInterval(() => {
      onPose(demoPoses[i]);
      i = (i + 1) % demoPoses.length;
    }, DEMO_TICK_MS);
    return () => clearInterval(id);
  }, [demoWalk, demoPoses, onPose]);

  // A different plan has a different coordinate space; drop the old trail.
  useEffect(() => {
    track.current = { latest: null, trail: [] };
  }, [prepared.plan]);

  // Tick the "last seen" text even when no poses arrive.
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), HUD_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const age = lastPoseAt ? now - lastPoseAt : Infinity;
  const live = age < LIVE_WITHIN_MS;
  const statusText = demoWalk
    ? "Demo walk (simulated, not a phone)"
    : hub.status !== "open"
      ? STATUS_TEXT[hub.status]
      : live
        ? "Phone live"
        : lastPoseAt
          ? `Phone last seen ${Math.round(age / 1000)} s ago`
          : "Connected, no phone yet";
  const phoneUrl = `${window.location.origin}/projects/${project.id}/ar`;
  const onLocalhost = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

  return (
    <div className={styles.page}>
      <h1 className="visually-hidden">Live map: {project.name}</h1>
      <div className={styles.mapArea}>
        <header className={styles.hud}>
          <div>
            <p className="small">
              <Link to={`/projects/${project.id}`}>{project.name}</Link>
            </p>
            <p className={styles.status} role="status">
              <span
                className={`dot ${demoWalk || (hub.status === "open" && live) ? "dot-live" : hub.status === "open" ? "" : "dot-warn"}`}
                aria-hidden="true"
              />
              {statusText}
            </p>
          </div>
          {demoWalk && (
            <button
              className="btn"
              type="button"
              onClick={() => {
                // Forget the simulated trail so it is never mistaken for a phone.
                setDemoWalk(false);
                track.current = { latest: null, trail: [] };
                setLastPoseAt(0);
              }}
            >
              Stop demo walk
            </button>
          )}
        </header>
        <MapCanvas
          plan={prepared.plan}
          track={track}
          label={`Live map of ${project.name}. A green dot shows the phone's position and a cone its heading.`}
        />
        {!lastPoseAt && (
          <div className={styles.waiting}>
            <h2>Waiting for a phone</h2>
            <ol>
              <li>Open this plan on the phone and tap Walk it in AR.</li>
              <li>Place the model. The dot appears here as you walk.</li>
            </ol>
            {onLocalhost ? (
              <p className="small muted">
                This page is open as localhost. Open it by the computer&apos;s Wi-Fi address so the
                phone can reach it.
              </p>
            ) : (
              <p className="small">
                Phone address: <code>{phoneUrl}</code>{" "}
                <button
                  className="btn btn-quiet"
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(phoneUrl).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </p>
            )}
            <p className="small muted">
              Both devices need the same plan. The phone keeps its own project list, so add the same
              file or example there.
            </p>
            <div className="row">
              <button
                className="btn"
                type="button"
                onClick={() => setDemoWalk(true)}
                disabled={demoPoses.length === 0}
              >
                Play a demo walk
              </button>
              <span className="small muted">No phone? See how the map follows someone.</span>
            </div>
          </div>
        )}
      </div>
      <aside className={styles.side}>
        <ControlPanel state={hub.phoneState} sendControl={hub.sendControl} />
        <p className="small muted">
          Live link: <code>{url}</code> <Link to="/settings">Change</Link>
        </p>
      </aside>
    </div>
  );
}
