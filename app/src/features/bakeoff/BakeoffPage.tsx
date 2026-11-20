/**
 * Texture bake-off render target (docs/research/TEXTURES_ASSETS.md §5).
 *
 *   /bakeoff?plan=cubicasa&theme=home            (theme defaults to "home")
 *   /bakeoff?plan=cubicasa&theme=home&lights=ar  (AR lighting: no env map, no tone mapping)
 *
 * Not linked from the UI. It renders a bundled sample plan with a SurfaceTheme
 * into a fixed-size canvas, with fixed camera poses, so screenshots from
 * different themes are directly comparable. scripts/bakeoff/run.mjs drives it
 * through `window.__bakeoff` (poses, GLB export, renderer stats).
 *
 * Plain three.js instead of R3F: the harness needs synchronous, deterministic
 * frames (render once per pose, no animation loop), but the lights
 * (lib/three/lighting), tone mapping and builder are the same as the 3D viewer's.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { boundsCenter, computeBounds, initialPpm, planToLocal, polygonArea, polygonCentroid, preparePlan, type Plan } from "@/lib/plan";
import { openingCenter, type Opening } from "@/lib/plan/fixtures";
import { buildFloorplanGroup, disposeGroup, type FloorplanModel } from "@/lib/three/buildFloorplanGroup";
import { planToGlb } from "@/lib/three/exportGlb";
import { addLights, AR_LIGHTS, createRoomEnvironment, VIEWER_LIGHTS } from "@/lib/three/lighting";
import { preloadTheme, themeByName, type SurfaceTheme } from "@/lib/three/surfaceTheme";

export const BAKEOFF_WIDTH = 1280;
export const BAKEOFF_HEIGHT = 800;
const WALL_HEIGHT_M = 2.5;
// "window" (widest window close-up) was added with Option 3 for fit checks.
const POSES = ["aerial", "eye", "closeup", "window"] as const;
type Pose = (typeof POSES)[number];

export interface BakeoffStats {
  theme: string;
  plan: string;
  ppm: number;
  wallHeightM: number;
  buildMs: number;
  firstFrameMs: number;
  /** theme.preload() (image fetch + decode, kit models), 0 for synchronous themes */
  preloadMs: number;
  /** PMREM environment generation (viewer lighting); made with the canvas, before preload */
  envMs: number;
  /** the first render call (shader compile + texture upload) */
  renderMs: number;
  /** preload + build + first render: the first frame with textures on screen */
  firstTexturedFrameMs: number;
  /** "viewer" (environment map + ACES) or "ar" (hemisphere, no tone mapping) */
  lights: "viewer" | "ar";
  /** UNMASKED_RENDERER_WEBGL, to tell SwiftShader from a hardware GPU */
  gpu: string | null;
  /** theme.stats(), when the theme has one */
  themeStats?: Record<string, unknown>;
  drawCalls: number;
  triangles: number;
  textures: number;
  /** sum of w*h*4*1.33 over distinct textures (GPU estimate with mipmaps) */
  textureGpuBytes: number;
  openings: { id: string; kind: string }[];
  droppedFixtures: { id: string; reason: string }[];
}

export interface BakeoffApi {
  ready: boolean;
  error?: string;
  poses: readonly Pose[];
  /** render a fixed pose; false when the plan has nothing to show for it */
  setPose(pose: Pose): boolean;
  stats(): BakeoffStats;
  /** mean 8-bit luminance (Rec. 709) of a canvas rectangle in the current frame */
  luminance(x0: number, y0: number, x1: number, y1: number): number;
  /** GLB of the same plan and theme, base64 */
  exportGlb(): Promise<string>;
}

declare global {
  interface Window {
    __bakeoff?: BakeoffApi;
  }
}

/** Where a camera goes for each pose, in local metres. */
function poseCamera(pose: Pose, plan: Plan, ppm: number, model: FloorplanModel): { pos: THREE.Vector3; look: THREE.Vector3; fov: number } | null {
  const center = boundsCenter(computeBounds(plan));
  const size = Math.max(model.widthM, model.depthM, 1);
  if (pose === "aerial") {
    // 45 degrees down, from the south-east, far enough to frame the footprint.
    const d = size * 1.25;
    return { pos: new THREE.Vector3(d * 0.7071, d, d * 0.7071), look: new THREE.Vector3(0, 0, 0), fov: 45 };
  }
  if (pose === "eye") {
    // 1.6 m eye height in the largest room, looking at the footprint centre
    // (or along -Z when the room already is the centre).
    const rooms = (plan.rooms ?? []).filter((r) => r.polygon.length >= 3);
    const room = rooms.sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))[0];
    const c = room ? polygonCentroid(room.polygon) : center;
    const l = planToLocal(c.x, c.y, center, ppm);
    const pos = new THREE.Vector3(l.x, 1.6, l.z);
    const toCentre = new THREE.Vector3(-l.x, 0, -l.z);
    const dir = toCentre.length() > 0.5 ? toCentre.normalize() : new THREE.Vector3(0, 0, -1);
    return { pos, look: pos.clone().add(new THREE.Vector3(dir.x, -0.15, dir.z)), fov: 70 };
  }
  // closeup: the widest door (else window), "window": the widest window; up to
  // 3 m in front of it, on the side with more free space (a ray test, so no
  // wall sits in between).
  const openings = [...model.fixtures.openings].sort((a, b) => b.s1 - b.s0 - (a.s1 - a.s0));
  const isWindow = pose === "window";
  const o: Opening | undefined = isWindow
    ? openings.find((x) => x.kind === "window")
    : (openings.find((x) => x.kind === "door") ?? openings[0]);
  if (!o) return null;
  const c = openingCenter(o);
  const l = planToLocal(c.x, c.y, center, ppm);
  const along = new THREE.Vector3(o.dir.x, 0, -o.dir.y);
  const target = new THREE.Vector3(l.x, isWindow ? 1.5 : 1.1, l.z);
  const half = (o.thicknessPx / ppm) / 2 + 0.05;
  const free = (n: THREE.Vector3) => {
    const ray = new THREE.Raycaster(target.clone().addScaledVector(n, half).setY(1.5), n, 0, 3);
    const hit = ray.intersectObject(model.group, true)[0];
    return hit ? hit.distance - 0.3 : 3;
  };
  const n1 = new THREE.Vector3(-along.z, 0, along.x);
  const n2 = n1.clone().negate();
  const [normal, dist] = free(n1) >= free(n2) ? [n1, free(n1)] : [n2, free(n2)];
  return {
    pos: target.clone().addScaledVector(normal, half + Math.max(isWindow ? 1.6 : 0.8, dist)).setY(1.5),
    look: target,
    fov: 60,
  };
}

function textureGpuBytes(group: THREE.Object3D): { count: number; bytes: number } {
  const seen = new Set<THREE.Texture>();
  group.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) seen.add(v);
    }
  });
  let bytes = 0;
  for (const t of seen) {
    const img = t.image as { width?: number; height?: number } | undefined;
    bytes += (img?.width ?? 0) * (img?.height ?? 0) * 4 * 1.33;
  }
  return { count: seen.size, bytes: Math.round(bytes) };
}

export function BakeoffPage() {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const planName = params.get("plan") ?? "cubicasa";
    const theme: SurfaceTheme = themeByName(params.get("theme"));
    const lights = params.get("lights") === "ar" ? "ar" : "viewer";
    let disposed = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let env: THREE.WebGLRenderTarget | null = null;
    let model: FloorplanModel | null = null;

    (async () => {
      const res = await fetch(`/samples/${encodeURIComponent(planName)}.json`);
      if (!res.ok) throw new Error(`sample ${planName}: HTTP ${res.status}`);
      const raw = await res.json();
      if (disposed) return;
      const plan = preparePlan(raw);
      const ppm = initialPpm(raw);

      // The canvas, renderer and environment exist before the model, as in the
      // viewer (the R3F canvas and its environment mount while the theme
      // loads), so the first textured frame is preload + build + render only.
      const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer = r;
      r.setPixelRatio(1);
      r.setSize(BAKEOFF_WIDTH, BAKEOFF_HEIGHT);
      // Same output as the R3F viewer's defaults (AR: no tone mapping).
      r.toneMapping = lights === "ar" ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.domElement.id = "bakeoff-canvas";
      host.current?.appendChild(r.domElement);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#f4f4f4");
      const tEnv = performance.now();
      if (lights === "viewer") {
        env = createRoomEnvironment(r);
        scene.environment = env.texture;
      }
      const envMs = performance.now() - tEnv;

      const tPreload = performance.now();
      await preloadTheme(theme);
      if (disposed) return;
      const t0 = performance.now();
      const preloadMs = t0 - tPreload;
      const built = buildFloorplanGroup(plan, { ppm, wallHeightM: WALL_HEIGHT_M, includeRooms: true, theme });
      model = built;
      const buildMs = performance.now() - t0;

      const size = Math.max(built.widthM, built.depthM, 1);
      if (lights === "ar") addLights(scene, AR_LIGHTS, new THREE.Vector3(1.0, 2.0, 0.6));
      else addLights(scene, VIEWER_LIGHTS, new THREE.Vector3(size, size * 2, size * 0.6));
      scene.add(built.group);
      const camera = new THREE.PerspectiveCamera(45, BAKEOFF_WIDTH / BAKEOFF_HEIGHT, 0.05, 2000);

      const setPose = (pose: Pose): boolean => {
        const p = poseCamera(pose, plan, ppm, built);
        if (!p) return false;
        camera.fov = p.fov;
        camera.position.copy(p.pos);
        camera.lookAt(p.look);
        camera.updateProjectionMatrix();
        r.render(scene, camera);
        return true;
      };
      const tRender = performance.now();
      setPose("aerial");
      const renderMs = performance.now() - tRender;
      const firstFrameMs = performance.now() - t0;
      const firstTexturedFrameMs = performance.now() - tPreload;
      const gl = r.getContext();
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null;
      const info = { calls: r.info.render.calls, triangles: r.info.render.triangles };
      const tex = textureGpuBytes(built.group);

      window.__bakeoff = {
        ready: true,
        poses: POSES,
        setPose,
        stats: () => ({
          theme: theme.name,
          plan: planName,
          ppm,
          wallHeightM: WALL_HEIGHT_M,
          buildMs: Math.round(buildMs * 10) / 10,
          firstFrameMs: Math.round(firstFrameMs * 10) / 10,
          preloadMs: Math.round(preloadMs * 10) / 10,
          envMs: Math.round(envMs * 10) / 10,
          renderMs: Math.round(renderMs * 10) / 10,
          firstTexturedFrameMs: Math.round(firstTexturedFrameMs * 10) / 10,
          lights,
          gpu,
          themeStats: theme.stats?.(),
          drawCalls: info.calls,
          triangles: info.triangles,
          textures: tex.count,
          textureGpuBytes: tex.bytes,
          openings: built.fixtures.openings.map((o) => ({ id: o.id, kind: o.kind })),
          droppedFixtures: built.fixtures.dropped,
        }),
        luminance: (x0, y0, x1, y1) => {
          const c = document.createElement("canvas");
          c.width = x1 - x0;
          c.height = y1 - y0;
          const ctx = c.getContext("2d")!;
          ctx.drawImage(r.domElement, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          return Math.round((sum / (d.length / 4)) * 10) / 10;
        },
        exportGlb: async () => {
          const blob = await planToGlb(plan, { ppm, wallHeightM: WALL_HEIGHT_M, includeRooms: true, theme });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let bin = "";
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(bin);
        },
      };
      setStatus(`${planName} / ${theme.name}`);
    })().catch((e: Error) => {
      window.__bakeoff = { ready: false, error: e.message } as BakeoffApi;
      setStatus(`error: ${e.message}`);
    });

    return () => {
      disposed = true;
      delete window.__bakeoff;
      if (model) disposeGroup(model.group);
      env?.dispose();
      if (renderer) {
        renderer.domElement.remove();
        renderer.dispose();
      }
    };
  }, []);

  return (
    <div style={{ background: "#f4f4f4", minHeight: "100vh" }}>
      <div ref={host} style={{ width: BAKEOFF_WIDTH, height: BAKEOFF_HEIGHT }} />
      <p className="small muted" data-testid="bakeoff-status" style={{ margin: 8 }}>
        {status}
      </p>
    </div>
  );
}
