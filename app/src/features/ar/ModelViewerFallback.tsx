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
import { usePlanApi } from "@/lib/api";
import { downloadBlob, planToGlb, safeFilename } from "@/lib/three/exportGlb";
import styles from "./ar.module.css";

interface ModelViewerFallbackProps {
  project: Project;
  prepared: PreparedPlan;
  /** why WebXR AR is unavailable, from the controller */
  reason: string | null;
}

/** A phone or tablet: the OS AR viewer may exist. A laptop has none. */
const isHandheld =
  typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

export function ModelViewerFallback({ project, prepared, reason }: ModelViewerFallbackProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const api = usePlanApi();

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        // Register the <model-viewer> element, then build the GLB (real metres).
        await import("@google/model-viewer");
        const glb = await planToGlb(prepared.plan, {
          ppm: project.ppm,
          wallHeightM: project.wallHeightM,
        });
        if (cancelled) return;
        setBlob(glb);
        // Scene Viewer (Android) is a separate app and cannot open blob: URLs, so
        // host the GLB on the server briefly and use its https URL. Demo mode or a
        // failed upload keeps the blob URL (in-page viewer, Quick Look, download).
        const hosted = await api.uploadModel(glb).catch(() => null);
        if (cancelled) return;
        if (hosted) {
          setSrc(hosted);
        } else {
          url = URL.createObjectURL(glb);
          setSrc(url);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, prepared.plan, project.ppm, project.wallHeightM]);

  return (
    <div className={`page page-narrow ${styles.fallback}`}>
      <header className="page-header">
        <div>
          <p className="small muted crumbs">
            <Link to={`/projects/${project.id}`}>{project.name}</Link> / AR
          </p>
          <h1>{isHandheld ? "View it in your room" : "AR needs a phone"}</h1>
        </div>
      </header>

      {isHandheld ? (
        <div className="notice notice-warn">
          <strong>The live AR walk does not run in this browser.</strong>
          <span>{reason}</span>
          <span>
            You can still place the model at full size with your phone&apos;s own AR viewer: tap{" "}
            <strong>Open in AR</strong> below. The live map cannot follow you in that mode. For the
            full walk, use Chrome on an Android phone with Google Play Services for AR.
          </span>
        </div>
      ) : (
        <div className="notice">
          <strong>Open this project on a phone to walk through it.</strong>
          <span>
            The full walk needs Chrome on an Android phone; other phones get a simpler AR view. The
            phone keeps its own project list, so add the same plan there first. Meanwhile you can
            turn the model around below.
          </span>
        </div>
      )}

      {error && (
        <p className="notice notice-error" role="alert">
          The model could not be prepared: {error}
        </p>
      )}

      {!src && !error && (
        <div
          className="progress progress-indeterminate"
          role="progressbar"
          aria-label="Preparing the 3D model"
        >
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

      {isHandheld && (
        <p className="small muted">
          If Open in AR does nothing on Android, download the model and open it from your files.
        </p>
      )}
      <div className="row">
        <button
          className="btn"
          type="button"
          disabled={!blob}
          onClick={() => blob && downloadBlob(blob, safeFilename(project.name, "glb"))}
        >
          Download model (.glb)
        </button>
        <Link className="btn" to={`/projects/${project.id}/3d`}>
          Open the 3D viewer
        </Link>
        <Link className="btn btn-quiet" to={`/projects/${project.id}`}>
          Back to the plan
        </Link>
      </div>
    </div>
  );
}
