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
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Project } from "@/lib/db/db";
import type { PreparedPlan } from "@/lib/db/hooks";
import { useHubUrl } from "@/lib/hub/useHubUrl";
import { useViewerHub } from "@/lib/hub/useViewerHub";
import type { PoseMessage } from "@/lib/hub/protocol";
import { ProjectGate } from "../plan/ProjectGate";
import { ControlPanel } from "./ControlPanel";
import { MapCanvas, type LiveTrack } from "./MapCanvas";
import { TRAIL_MAX } from "./mapDrawing";
import styles from "./livemap.module.css";

export function LiveMapPage() {
  return <ProjectGate>{(ctx) => <LiveMap {...ctx} />}</ProjectGate>;
}

const LIVE_WITHIN_MS = 1500;
const HUD_TICK_MS = 250;

const STATUS_TEXT = {
  connecting: "Connecting to the hub…",
  reconnecting: "Hub not reachable, retrying…",
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
  const phoneUrl = `${window.location.origin}/projects/${project.id}/ar`;
  const onLocalhost = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

  return (
    <div className={styles.page}>
      <div className={styles.mapArea}>
        <header className={styles.hud}>
          <div>
            <p className="small">
              <Link to={`/projects/${project.id}`}>{project.name}</Link>
            </p>
            <p className={styles.status} role="status">
              <span className={`dot ${hub.status === "open" ? (live ? "dot-live" : "") : "dot-warn"}`} aria-hidden="true" />
              {hub.status !== "open" ? STATUS_TEXT[hub.status] : live ? "Phone live" : lastPoseAt ? `Phone last seen ${Math.round(age / 1000)} s ago` : "Connected, no phone yet"}
            </p>
          </div>
        </header>
        <MapCanvas plan={prepared.plan} track={track} label={`Live map of ${project.name}. A green dot shows the phone's position and a cone its heading.`} />
        {!lastPoseAt && (
          <div className={styles.waiting}>
            <h2>Waiting for a phone</h2>
            <ol>
              <li>Open this plan on the phone and tap Walk it in AR.</li>
              <li>Place the model. The dot appears here as you walk.</li>
            </ol>
            {onLocalhost ? (
              <p className="small muted">This page is open as localhost. Open it by the computer&apos;s Wi-Fi address so the phone can reach it.</p>
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
            <p className="small muted">Both devices need the same plan. The phone keeps its own project list, so add the same file or example there.</p>
          </div>
        )}
      </div>
      <aside className={styles.side}>
        <ControlPanel state={hub.phoneState} sendControl={hub.sendControl} />
        <p className="small muted">
          Hub: <code>{url}</code> <Link to="/settings">Change</Link>
        </p>
      </aside>
    </div>
  );
}
