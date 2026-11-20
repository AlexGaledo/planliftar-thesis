/**
 * The "Live map" tab without a project in the URL.
 *
 * It listens on the hub first: when a phone has shared the plan it has open
 * (PROTOCOL.md "Plan"; the server hub replays the latest one on connect), the
 * map follows that plan directly, even if this device has never seen it, and
 * offers to save it to the library. Otherwise it jumps to the last opened
 * project, or asks which plan to follow. `?shared=1` stays here and waits.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useProjects, type PreparedPlan } from "@/lib/db/hooks";
import type { Project } from "@/lib/db/db";
import { saveSharedPlan, sharedPlanProject } from "@/lib/db/projects";
import type { SharedPlan } from "@/lib/hub/protocol";
import { useHubUrl } from "@/lib/hub/useHubUrl";
import { useViewerHub, type ViewerHub } from "@/lib/hub/useViewerHub";
import { computeBounds, preparePlan } from "@/lib/plan";
import { useSettings } from "@/stores/settings";
import { LiveMap } from "./LiveMapPage";

/** How long to wait for a replayed shared plan before falling back to the library. */
const SHARED_PLAN_GRACE_MS = 1200;

export function MapIndexPage() {
  const lastId = useSettings((s) => s.lastProjectId);
  const projects = useProjects();
  const [params] = useSearchParams();
  const waitForShared = params.get("shared") === "1";
  const hub = useViewerHub(useHubUrl());
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (hub.status === "reconnecting" || hub.status === "closed") {
      setSettled(true);
      return;
    }
    if (hub.status !== "open") return;
    const id = setTimeout(() => setSettled(true), SHARED_PLAN_GRACE_MS);
    return () => clearTimeout(id);
  }, [hub.status]);

  if (hub.sharedPlan) return <SharedLiveMap key={hub.sharedPlan.plan_id} shared={hub.sharedPlan} hub={hub} />;

  if (projects === undefined || (!settled && !waitForShared)) {
    return (
      <div className="page" aria-busy="true">
        <div className="progress progress-indeterminate" role="progressbar" aria-label="Looking for a phone">
          <span />
        </div>
      </div>
    );
  }
  if (!waitForShared && lastId && projects.some((p) => p.id === lastId))
    return <Navigate to={`/projects/${lastId}/map`} replace />;

  return (
    <div className="page page-narrow">
      <header className="page-header">
        <div>
          <h1>Live map</h1>
          <p className="muted">
            Follow a phone walking a plan in AR. When the phone opens AR, its plan appears here by itself. Or choose
            the plan the phone has open.
          </p>
        </div>
      </header>
      {projects.length === 0 ? (
        <p>
          No plans yet. <Link to="/new">Add one</Link> first.
        </p>
      ) : (
        <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {projects.map((p) => (
            <li key={p.id}>
              <Link className="btn btn-block" to={`/projects/${p.id}/map`} style={{ justifyContent: "flex-start" }}>
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The live map over a plan the phone shared, with "Save to library". */
function SharedLiveMap({ shared, hub }: { shared: SharedPlan; hub: ViewerHub }) {
  const closeGaps = useSettings((s) => s.closeGaps);
  const [saved, setSaved] = useState<Project | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const built = useMemo((): { project: Project; prepared: PreparedPlan } | { error: string } => {
    try {
      const project = sharedPlanProject(shared);
      const plan = preparePlan(shared.plan, { closeGaps });
      return { project, prepared: { plan, bounds: computeBounds(plan) } };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [shared, closeGaps]);

  if ("error" in built) {
    return (
      <div className="page page-narrow">
        <h1>Live map</h1>
        <p className="notice notice-error" role="alert">
          The phone shared a plan this device cannot read: {built.error}
        </p>
      </div>
    );
  }

  const header = (
    <p className="small" data-testid="shared-plan">
      {built.project.name} <span className="muted">(shared from the phone)</span>{" "}
      {saved ? (
        <Link to={`/projects/${saved.id}`}>Saved. Open it</Link>
      ) : (
        <button
          className="btn btn-quiet"
          type="button"
          onClick={() => {
            saveSharedPlan(shared).then(setSaved, (e: Error) => setSaveError(e.message));
          }}
        >
          Save to library
        </button>
      )}
      {saveError && <span role="alert"> Could not save: {saveError}</span>}
    </p>
  );
  return <LiveMap project={built.project} prepared={built.prepared} hub={hub} sharedHeader={header} />;
}
