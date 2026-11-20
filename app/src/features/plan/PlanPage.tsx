/**
 * One project: the extracted plan over its source image, the real-size form,
 * and the ways onward (3D, AR, live map, downloads).
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useObjectUrl } from "@/hooks/useObjectUrl";
import type { Project } from "@/lib/db/db";
import type { PreparedPlan } from "@/lib/db/hooks";
import { formatFootprint } from "@/lib/plan";
import { downloadBlob, planToGlb, safeFilename } from "@/lib/three/exportGlb";
import { useSettings } from "@/stores/settings";
import { PlanOverlay } from "./PlanOverlay";
import { ProjectGate } from "./ProjectGate";
import { ScaleForm, type ScaleMode } from "./ScaleForm";
import styles from "./plan.module.css";

export function PlanPage() {
  return <ProjectGate>{(ctx) => <PlanView {...ctx} />}</ProjectGate>;
}

/** Notes the acceptance barrier attaches, in plain language. */
const NOTE_TEXT: Record<string, string> = {
  merged_rooms: "Some open-plan areas are kept as one room. The pipeline never invents walls.",
  mitunet_only: "Only the wall model ran; rooms were not cross-checked.",
  synthetic_reference_plan: "A hand-drawn reference plan, not AI output.",
};

function PlanView({ project, prepared }: { project: Project; prepared: PreparedPlan }) {
  const { plan, bounds } = prepared;
  const units = useSettings((s) => s.units);
  const imageUrl = useObjectUrl(project.sourceImage);
  const [mode, setMode] = useState<ScaleMode>(project.scaleReference?.kind ?? "longest");
  const [selectedWall, setSelectedWall] = useState<string | null>(project.scaleReference?.wallId ?? null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const notes = (plan.acceptance?.notes ?? []).filter((n) => NOTE_TEXT[n]);
  const filled = plan.walls.filter((w) => w.generated).length;

  async function exportGlb() {
    setExporting(true);
    setExportError(null);
    try {
      const blob = await planToGlb(plan, { ppm: project.ppm, wallHeightM: project.wallHeightM });
      downloadBlob(blob, safeFilename(project.name, "glb"));
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(project.plan, null, 2)], { type: "application/json" });
    downloadBlob(blob, safeFilename(project.name, "json"));
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="small muted">
            <Link to="/">Projects</Link> / {project.name}
          </p>
          <h1>{project.name}</h1>
          <p className="muted">
            {formatFootprint(bounds.widthPx / project.ppm, bounds.heightPx / project.ppm, units)}, {plan.rooms?.length ?? 0} rooms,{" "}
            {plan.walls.length} walls{filled ? ` (${filled} gap fills)` : ""}
          </p>
        </div>
      </header>

      <nav className={styles.actions} aria-label="Open this plan as">
        <Link className="btn btn-primary" to={`/projects/${project.id}/ar`}>
          Walk it in AR
        </Link>
        <Link className="btn" to={`/projects/${project.id}/3d`}>
          View in 3D
        </Link>
        <Link className="btn" to={`/projects/${project.id}/map`}>
          Live map
        </Link>
      </nav>

      {project.demo && (
        <p className="notice notice-warn">
          <span>
            <strong>Demo result.</strong> This is a bundled sample plan, not an analysis of the image you uploaded.
          </span>
        </p>
      )}
      {notes.map((n) => (
        <p key={n} className="notice small">
          {NOTE_TEXT[n]}
        </p>
      ))}

      <div className={styles.layout}>
        <PlanOverlay
          plan={plan}
          imageUrl={imageUrl}
          selectedWallId={mode === "wall" ? selectedWall : null}
          onSelectWall={
            mode === "wall"
              ? setSelectedWall
              : (id) => {
                  setMode("wall");
                  setSelectedWall(id);
                }
          }
        />
        <div className="stack">
          <ScaleForm
            project={project}
            plan={plan}
            bounds={bounds}
            selectedWallId={selectedWall}
            mode={mode}
            onMode={setMode}
            onSelectWall={setSelectedWall}
          />
          <section className="panel" aria-labelledby="download-heading">
            <h2 id="download-heading" className="field-label" style={{ fontSize: "var(--step-1)" }}>
              Download
            </h2>
            <p className="small muted">The 3D model uses metres, at the size set above.</p>
            <div className="row">
              <button className="btn" type="button" onClick={() => void exportGlb()} disabled={exporting}>
                {exporting ? "Building model…" : "3D model (.glb)"}
              </button>
              <button className="btn" type="button" onClick={exportJson}>
                Plan file (.json)
              </button>
            </div>
            {exportError && (
              <p className="notice notice-error small" role="alert">
                The model could not be exported: {exportError}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
