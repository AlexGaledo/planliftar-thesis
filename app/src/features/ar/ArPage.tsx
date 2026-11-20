/**
 * AR page (full screen, no app navigation over the camera).
 *
 * Owns one ArController per project for the page's lifetime. React only draws
 * the overlay from the controller's `ArUiState` snapshots. When the browser
 * cannot run WebXR AR, the page switches to <ModelViewerFallback>.
 *
 * Query: ?fake=1 runs the scripted "test walk" (no camera), as in ar.html.
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Project } from "@/lib/db/db";
import type { PreparedPlan } from "@/lib/db/hooks";
import { setProjectScale } from "@/lib/db/projects";
import { longestSidePx } from "@/lib/plan";
import { useHubUrl } from "@/lib/hub/useHubUrl";
import { ProjectGate } from "../plan/ProjectGate";
import { ArController, type ArUiState } from "./ArController";
import { ArOverlay } from "./ArOverlay";
import { ModelViewerFallback } from "./ModelViewerFallback";
import styles from "./ar.module.css";

export function ArPage() {
  return <ProjectGate>{(ctx) => <ArSession {...ctx} />}</ProjectGate>;
}

/** Wait this long after the last building-length change before saving it. */
const SAVE_SCALE_DELAY_MS = 800;

function ArSession({ project, prepared }: { project: Project; prepared: PreparedPlan }) {
  const [params] = useSearchParams();
  const fake = params.get("fake") === "1";
  const hubUrl = useHubUrl();
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ArController | null>(null);
  const [ui, setUi] = useState<ArUiState | null>(null);

  // The controller must survive re-renders: saving the scale updates the
  // project in IndexedDB, which re-renders this component with a new object.
  // Recreating the controller then would end the AR session. So it is created
  // once per project id, from the values at that moment (kept in a ref).
  const initial = useRef({ plan: prepared.plan, ppm: project.ppm, wallHeightM: project.wallHeightM, hubUrl, fake });

  useEffect(() => {
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const projectId = project.id;
    const longestPx = longestSidePx(prepared.bounds);
    const controller = new ArController({
      ...initial.current,
      onUi: setUi,
      onPpmChange: (ppm) => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void setProjectScale(projectId, ppm, { kind: "longest", meters: longestPx / ppm }), SAVE_SCALE_DELAY_MS);
      },
    });
    controllerRef.current = controller;
    if (containerRef.current) void controller.init(containerRef.current);
    return () => {
      clearTimeout(saveTimer);
      controller.dispose();
      controllerRef.current = null;
    };
    // Deliberately keyed on the id only; see the comment on `initial` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  if (ui?.stage === "unsupported" && !fake) {
    return <ModelViewerFallback project={project} prepared={prepared} reason={ui.unsupportedReason} />;
  }

  return (
    <div className={styles.root}>
      <div ref={containerRef} className={styles.scene} aria-hidden="true" />
      <div ref={overlayRef} className={styles.overlay} data-stage={ui?.stage ?? "loading"}>
        <ArOverlay
          project={project}
          ui={ui}
          controller={controllerRef}
          onStart={() => void controllerRef.current?.start(overlayRef.current)}
        />
      </div>
    </div>
  );
}
