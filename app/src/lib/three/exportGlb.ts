/**
 * GLB export with three's GLTFExporter.
 *
 * The same group the viewer and AR render is exported, so the downloaded file
 * and the iOS/Android fallback viewer (<model-viewer>) match the app exactly.
 * Units: one GLB unit = one metre (glTF convention), so `ar-scale="fixed"` in
 * model-viewer shows the building at true 1:1 size.
 */
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { Plan } from "@/lib/plan/types";
import { buildFloorplanGroup, disposeGroup } from "./buildFloorplanGroup";
import { DEFAULT_THEME, preloadTheme, type SurfaceTheme } from "./surfaceTheme";

export interface GlbOptions {
  ppm: number;
  wallHeightM: number;
  includeRooms?: boolean;
  /** defaults to the builder's default theme */
  theme?: SurfaceTheme;
}

/** Export any object as binary glTF. */
export async function exportObjectAsGlb(object: THREE.Object3D): Promise<Blob> {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(object, { binary: true, onlyVisible: true });
  if (!(result instanceof ArrayBuffer)) throw new Error("GLB export returned JSON instead of binary.");
  return new Blob([result], { type: "model/gltf-binary" });
}

/**
 * Build a fresh model from a plan and export it (no scene required). Waits for
 * the theme's textures and kit models first, so the file is never the
 * flat-colour fallback unless the assets truly failed to load.
 */
export async function planToGlb(plan: Plan, opts: GlbOptions): Promise<Blob> {
  const theme = opts.theme ?? DEFAULT_THEME;
  await preloadTheme(theme);
  const { group } = buildFloorplanGroup(plan, { ...opts, theme, includeRooms: opts.includeRooms ?? true });
  // The exporter needs world matrices; this group has no parent.
  group.updateMatrixWorld(true);
  try {
    return await exportObjectAsGlb(group);
  } finally {
    disposeGroup(group);
  }
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A filesystem-safe name from a project name. */
export function safeFilename(name: string, ext: string): string {
  const base = name.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "plan";
  return `${base}.${ext}`;
}
