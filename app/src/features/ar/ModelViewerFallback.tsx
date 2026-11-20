/**
 * Fallback when the browser cannot run WebXR AR (iPhone Safari, desktop,
 * Android without ARCore in Chrome).
 *
 * Uses Google's <model-viewer> web component: it shows the model in 3D and
 * offers the phone's own AR viewer where one exists:
 *  - iOS: Quick Look. model-viewer converts the GLB to USDZ on the fly, so no
 *    separate .usdz file is needed.
 *  - Android: Scene Viewer.
 * `ar-scale="fixed"` keeps the model at true size (no pinch-to-resize), so
 * "life-size" really means life-size.
 *
 * The live map does NOT work in this mode: the OS viewer does not tell the
 * page where the phone is. The page says so plainly.
 *
 * The model-viewer library (~1 MB) is imported lazily, only when this
 * fallback actually shows.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Project } from "@/lib/db/db";
import type { PreparedPlan } from "@/lib/db/hooks";
import { downloadBlob, planToGlb, safeFilename } from "@/lib/three/exportGlb";
import styles from "./ar.module.css";

interface ModelViewerFallbackProps {
  project: Project;
  prepared: PreparedPlan;
  /** why WebXR AR is unavailable, from the controller */
  reason: string | null;
}

export function ModelViewerFallback({ project, prepared, reason }: ModelViewerFallbackProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        // Register the <model-viewer> element, then build the GLB (real metres).
        await import("@google/model-viewer");
        const glb = await planToGlb(prepared.plan, { ppm: project.ppm, wallHeightM: project.wallHeightM });
        if (cancelled) return;
        url = URL.createObjectURL(glb);
        setBlob(glb);
        setSrc(url);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [prepared.plan, project.ppm, project.wallHeightM]);

  return (
    <div className={`page page-narrow ${styles.fallback}`}>
      <header className="page-header">
        <div>
          <p className="small muted">
            <Link to={`/projects/${project.id}`}>{project.name}</Link> / AR
          </p>
          <h1>View in your phone&apos;s AR</h1>
        </div>
      </header>

      <div className="notice notice-warn">
        <strong>The live AR walk is not available in this browser.</strong>
        <span>{reason}</span>
        <span>
          You can still place the model life-size with your phone&apos;s own AR viewer. The live map will not follow you in that
          mode. For the full experience, open this page in Chrome on an Android phone with Google Play Services for AR.
        </span>
      </div>

      {error && (
        <p className="notice notice-error" role="alert">
          The model could not be prepared: {error}
        </p>
      )}

      {!src && !error && (
        <div className="progress progress-indeterminate" role="progressbar" aria-label="Preparing the 3D model">
          <span />
        </div>
      )}

      {src && (
        <model-viewer
          src={src}
          alt={`3D model of ${project.name}`}
          ar=""
          ar-modes="webxr scene-viewer quick-look"
          ar-scale="fixed"
          camera-controls=""
          touch-action="pan-y"
          shadow-intensity="0.6"
          class={styles.modelViewer}
        >
          <button slot="ar-button" className={`btn btn-primary ${styles.arButton}`} type="button">
            Open in AR
          </button>
        </model-viewer>
      )}

      <p className="small muted">
        On Android, Scene Viewer opens models from a web address; a model made on this device may not open there. Download it and open
        it from your files instead if the AR button does nothing.
      </p>
      <div className="row">
        <button className="btn" type="button" disabled={!blob} onClick={() => blob && downloadBlob(blob, safeFilename(project.name, "glb"))}>
          Download model (.glb)
        </button>
        <Link className="btn btn-quiet" to={`/projects/${project.id}/3d`}>
          Open the 3D viewer
        </Link>
      </div>
    </div>
  );
}
