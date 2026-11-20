/**
 * 3D viewer: the extruded plan with orbit controls, coloured and labelled
 * rooms, and GLB export.
 *
 * Built with @react-three/fiber (React renderer for three.js: the scene is
 * written as JSX) and drei (ready-made helpers like OrbitControls and Html).
 * The geometry itself comes from the same buildFloorplanGroup() the AR session
 * uses, so what you see here is exactly what you walk in AR.
 */
import { Canvas } from "@react-three/fiber";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { Project } from "@/lib/db/db";
import type { PreparedPlan } from "@/lib/db/hooks";
import { formatFootprint } from "@/lib/plan";
import { downloadBlob, planToGlb, safeFilename } from "@/lib/three/exportGlb";
import { useSettings } from "@/stores/settings";
import { ProjectGate } from "../plan/ProjectGate";
import { FloorplanScene } from "./FloorplanScene";
import styles from "./viewer.module.css";

export function ViewerPage() {
  return <ProjectGate>{(ctx) => <Viewer {...ctx} />}</ProjectGate>;
}

/** WebGL is missing in some locked-down browsers and VMs; say so instead of a blank box. */
function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function Viewer({ project, prepared }: { project: Project; prepared: PreparedPlan }) {
  const units = useSettings((s) => s.units);
  const [showLabels, setShowLabels] = useState(true);
  const [seeThrough, setSeeThrough] = useState(false);
  const [exportState, setExportState] = useState<"idle" | "busy" | string>("idle");
  const [webgl] = useState(hasWebGL);
  const { plan, bounds } = prepared;

  async function exportGlb() {
    setExportState("busy");
    try {
      const blob = await planToGlb(plan, { ppm: project.ppm, wallHeightM: project.wallHeightM });
      downloadBlob(blob, safeFilename(project.name, "glb"));
      setExportState("idle");
    } catch (e) {
      setExportState((e as Error).message);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <div>
          <p className="small muted">
            <Link to={`/projects/${project.id}`}>{project.name}</Link> / 3D
          </p>
          <h1 className={styles.title}>{formatFootprint(bounds.widthPx / project.ppm, bounds.heightPx / project.ppm, units)}</h1>
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
            <span>Room names</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={seeThrough} onChange={(e) => setSeeThrough(e.target.checked)} />
            <span>See-through walls</span>
          </label>
          <button className="btn" type="button" onClick={() => void exportGlb()} disabled={exportState === "busy"}>
            {exportState === "busy" ? "Exporting…" : "Export GLB"}
          </button>
          <Link className="btn btn-primary" to={`/projects/${project.id}/ar`}>
            Walk it in AR
          </Link>
        </div>
      </header>
      {exportState !== "idle" && exportState !== "busy" && (
        <p className="notice notice-error small" role="alert">
          Export failed: {exportState}
        </p>
      )}

      <div className={styles.stage}>
        {webgl ? (
          <Canvas
            camera={{ fov: 45, near: 0.05, far: 2000, position: [0, 10, 10] }}
            dpr={[1, 2]}
            aria-label={`3D model of ${project.name}. Drag to orbit, pinch or scroll to zoom.`}
            role="img"
          >
            <FloorplanScene plan={plan} ppm={project.ppm} wallHeightM={project.wallHeightM} showLabels={showLabels} wallOpacity={seeThrough ? 0.35 : 1} />
          </Canvas>
        ) : (
          <div className="notice notice-error" role="alert">
            <strong>This browser cannot draw 3D.</strong>
            <span>WebGL is turned off or unavailable. Try Chrome or Safari, or enable hardware acceleration.</span>
          </div>
        )}
        <p className={styles.hint}>Drag to orbit. Two fingers or right-drag to pan. Pinch or scroll to zoom.</p>
      </div>
    </div>
  );
}
