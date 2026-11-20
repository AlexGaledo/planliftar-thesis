/**
 * The live map canvas: the plan, plus the phone's dot, heading and trail.
 *
 * Performance note (worth reading): the plan is drawn ONCE into an offscreen
 * canvas, and each animation frame only copies that image and draws the dot.
 * Pose data is read from a ref (`track`), not props, so 10 poses/second never
 * re-render React; the requestAnimationFrame loop picks them up.
 *
 * @param plan   prepared plan (same walls the 3D model uses)
 * @param track  mutable { latest, trail } filled by the hub callback
 * @param label  accessible description of the map
 */
import { useEffect, useRef } from "react";
import type { PoseMessage } from "@/lib/hub/protocol";
import type { Plan, PlanPoint } from "@/lib/plan";
import { drawPlan, drawPlayer, fitTransform, type MapColors } from "./mapDrawing";
import styles from "./livemap.module.css";

export interface LiveTrack {
  latest: PoseMessage | null;
  trail: PlanPoint[];
}

interface MapCanvasProps {
  plan: Plan;
  track: React.MutableRefObject<LiveTrack>;
  label: string;
}

function readColors(el: Element): MapColors {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const ink = v("--ink", "#000000");
  return {
    paper: v("--paper", "#ffffff"),
    ink,
    roomFill: v("--wash", "#f2f2f2"),
    roomStroke: v("--rule", "#d6d6d6"),
    live: v("--live", "#13804b"),
  };
}

export function MapCanvas({ plan, track, label }: MapCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!stage || !canvas || !ctx) return;

    let dpr = 1;
    let transform = fitTransform(plan, 1, 1);
    let staticLayer: HTMLCanvasElement | null = null;
    let frame = 0;
    // getComputedStyle every frame is wasteful; colours refresh on resize and theme change.
    let colors = readColors(stage);

    // Size to the stage (not the window) and re-render the cached plan layer,
    // otherwise it goes stale and misaligns with the dot after a resize.
    const resize = () => {
      colors = readColors(stage);
      dpr = Math.max(1, window.devicePixelRatio || 1);
      const w = Math.max(1, stage.clientWidth);
      const h = Math.max(1, stage.clientHeight);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      transform = fitTransform(plan, canvas.width, canvas.height);
      staticLayer = document.createElement("canvas");
      staticLayer.width = canvas.width;
      staticLayer.height = canvas.height;
      const sctx = staticLayer.getContext("2d");
      if (sctx) drawPlan(sctx, plan, transform, colors);
    };

    const loop = (now: number) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (staticLayer) ctx.drawImage(staticLayer, 0, 0);
      drawPlayer(ctx, track.current.trail, track.current.latest, transform, colors, dpr, now);
      frame = requestAnimationFrame(loop);
    };

    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", resize);
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scheme.removeEventListener("change", resize);
    };
  }, [plan, track]);

  return (
    <div ref={stageRef} className={styles.stage}>
      <canvas ref={canvasRef} className={styles.canvas} role="img" aria-label={label} />
    </div>
  );
}
