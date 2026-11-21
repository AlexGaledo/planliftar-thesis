/**
 * Kit fixtures (bake-off Option 3, part of the "home" theme, see
 * docs/research/bakeoff/DECISION.md): CC0 door/window models fitted into the
 * wall openings.
 *
 * The GLBs in public/models/fixtures/ were normalised once
 * (scripts/models/normalize_fixtures.mjs): a 1 x 1 x 1 unit box, pivot at the
 * bottom centre, width on +X, depth on Z, two nodes ("frame", "leaf"), and the
 * material names ARE the SurfaceKind they map to (door, window_frame, glass,
 * hardware). Their own materials are thrown away: only the geometry is used.
 *
 * Fitting: every opening gets its own transformed COPY of the geometry (not an
 * instance), so it merges into the theme's per-material meshes and exports
 * like any box. Two modes:
 *  - "slice"   (default) frame-preserving 9-slice: edge bands keep their size
 *              in metres, only the middle stretches, so a 2.4 m window keeps
 *              5 cm frame members and the door handle keeps its shape;
 *  - "stretch" plain non-uniform scale of the unit box to the hole.
 * Depth: the "frame" part fills the wall thickness (+1 cm, like the box
 * frames), the "leaf" part (door leaf, handle, sash, glass) keeps a fixed
 * depth so thick walls do not give fat doors and huge handles.
 */
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { OpeningKind } from "@/lib/plan/fixtures";
import type { SurfaceKind } from "./surfaceTheme";
import type { FixtureSlot } from "./wallLayout";

export type FitMode = "slice" | "stretch";
type Part = "frame" | "leaf";

export interface KitFixture {
  kind: OpeningKind;
  /** unit-box geometry per (surface kind, part); position + normal, indexed */
  pieces: { surface: SurfaceKind; part: Part; geometry: THREE.BufferGeometry }[];
  /** the model's size in metres at the kit's design scale (unit box -> metres) */
  design: { width: number; height: number; depth: number };
  /** 9-slice bands, as a fraction of the unit box (x: each side; y: bottom, top) */
  bands: { x: number; bottom: number; top: number };
  triangles: number;
}

export const FIXTURE_URLS: Record<OpeningKind, string> = {
  door: "/models/fixtures/door.glb",
  window: "/models/fixtures/window.glb",
};

/** Kenney Furniture Kit is modelled at about half scale (a 1.01 m door). */
export const KIT_SCALE = 2;
/** Leaf/sash/handle depth scale: a 4 cm kit leaf becomes ~5 cm, not 8 cm. */
export const LEAF_DEPTH_SCALE = 1.2;
/** Frames stand this far proud of the wall in total, like the box frames. */
const FRAME_PROUD_M = 0.01;

/**
 * Bands chosen from the geometry (see NOTES.md): door x 0.3 keeps the lever
 * handle (unit x 0.21..0.40) and the jamb in the fixed band; window x 0.22 / y
 * 0.15 keep casing + sash rails, so only the glass and the panel middles stretch.
 */
const BANDS: Record<OpeningKind, KitFixture["bands"]> = {
  door: { x: 0.3, bottom: 0.12, top: 0.12 },
  window: { x: 0.22, bottom: 0.15, top: 0.15 },
};

const VALID_SURFACES = new Set<string>(["door", "window_frame", "glass", "hardware"]);

/** Turn a parsed fixture GLB scene into a KitFixture. */
export function kitFixtureFromScene(kind: OpeningKind, scene: THREE.Object3D, nativeSize: number[]): KitFixture {
  const pieces: KitFixture["pieces"] = [];
  let triangles = 0;
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // GLTFLoader: node "frame" -> Group "frame" -> one Mesh per primitive (or the node is the mesh).
    let part: Part | null = null;
    for (let p: THREE.Object3D | null = mesh; p; p = p.parent) {
      if (p.name === "frame" || p.name === "leaf") {
        part = p.name;
        break;
      }
    }
    const surface = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material).name;
    if (!part || !VALID_SURFACES.has(surface)) throw new Error(`fixture ${kind}: unexpected mesh ${mesh.name} (${surface})`);
    let g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    // Weld shared corners once at load (DECISION.md W6): every placed copy
    // inherits the index, which roughly halves the kit's vertex data in the GLB.
    g = mergeVertices(g);
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    pieces.push({ surface: surface as SurfaceKind, part, geometry: g });
  });
  const [w, h, d] = nativeSize;
  return {
    kind,
    pieces,
    design: { width: w * KIT_SCALE, height: h * KIT_SCALE, depth: d },
    bands: BANDS[kind],
    triangles,
  };
}

export async function parseKitFixture(kind: OpeningKind, data: ArrayBuffer): Promise<KitFixture> {
  const gltf = await new GLTFLoader().parseAsync(data, "");
  const native = (gltf.scene.userData?.nativeSize ?? gltf.scenes[0]?.userData?.nativeSize) as number[] | undefined;
  if (!native || native.length !== 3) throw new Error(`fixture ${kind}: no nativeSize in scene extras`);
  return kitFixtureFromScene(kind, gltf.scene, native);
}

export async function loadKitFixture(kind: OpeningKind): Promise<KitFixture> {
  const res = await fetch(FIXTURE_URLS[kind]);
  if (!res.ok) throw new Error(`fixture ${kind}: HTTP ${res.status}`);
  return parseKitFixture(kind, await res.arrayBuffer());
}

/**
 * Map one unit-box axis into metres. `u` runs from `lo` to `lo + 1` (x: -0.5..0.5,
 * y: 0..1). In "slice" mode the bands b0/b1 (unit) keep b * design metres and
 * the middle stretches; if the target is too small for both bands, the whole
 * axis shrinks uniformly instead.
 */
export function sliceAxis(u: number, lo: number, design: number, target: number, b0: number, b1: number, mode: FitMode): number {
  const t = u - lo; // 0..1
  if (mode === "stretch") return lo * target + t * target;
  const m0 = b0 * design;
  const m1 = b1 * design;
  const start = lo * target;
  if (m0 + m1 >= target || b0 + b1 >= 1) return start + t * target;
  if (t <= b0) return start + t * design;
  if (t >= 1 - b1) return start + target - (1 - t) * design;
  const mid = (t - b0) / (1 - b0 - b1);
  return start + m0 + mid * (target - m0 - m1);
}

/**
 * Metre UVs by box projection in the fixture's own frame (x along the wall,
 * y up, z through the wall), one tile per metre like scaleBoxUVs, so the
 * theme's door grain runs vertically on the leaf.
 */
function boxProjectUVs(g: THREE.BufferGeometry): void {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    const [a, b] = nz >= nx && nz >= ny ? [pos.getX(i), pos.getY(i)] : nx >= ny ? [pos.getZ(i), pos.getY(i)] : [pos.getX(i), pos.getZ(i)];
    uv[2 * i] = a;
    uv[2 * i + 1] = b;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/**
 * Copies of the fixture's pieces fitted into one slot, in model-local metres,
 * indexed (so they merge with the box geometry). One entry per piece.
 */
export function placeKitFixture(fx: KitFixture, slot: FixtureSlot, mode: FitMode = "slice"): { surface: SurfaceKind; geometry: THREE.BufferGeometry }[] {
  const { width: dw, height: dh, depth: nd } = fx.design;
  const frameDepth = slot.thickness + FRAME_PROUD_M;
  const leafDepth = nd * LEAF_DEPTH_SCALE;
  // Kit +X (width) -> wall direction (+Z before yaw), kit Z (depth) -> -X; then the wall yaw.
  const place = new THREE.Matrix4().compose(
    new THREE.Vector3(slot.x, slot.y, slot.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), slot.yaw - Math.PI / 2),
    new THREE.Vector3(1, 1, 1),
  );
  return fx.pieces.map(({ surface, part, geometry }) => {
    const src = geometry.attributes.position;
    const srcN = geometry.attributes.normal;
    const n = src.count;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const depth = part === "frame" ? frameDepth : leafDepth;
    // Approximate normals for the non-uniform map: scale by the inverse local
    // stretch of each axis (exact for the axis-aligned faces this kit has).
    const sx = mode === "stretch" ? slot.width : dw;
    const sy = mode === "stretch" ? slot.height : dh;
    for (let i = 0; i < n; i++) {
      pos[3 * i] = sliceAxis(src.getX(i), -0.5, dw, slot.width, fx.bands.x, fx.bands.x, mode);
      pos[3 * i + 1] = sliceAxis(src.getY(i), 0, dh, slot.height, fx.bands.bottom, fx.bands.top, mode);
      pos[3 * i + 2] = src.getZ(i) * depth;
      nor[3 * i] = srcN.getX(i) / sx;
      nor[3 * i + 1] = srcN.getY(i) / sy;
      nor[3 * i + 2] = srcN.getZ(i) / depth;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    g.normalizeNormals();
    boxProjectUVs(g);
    g.applyMatrix4(place);
    g.setIndex(geometry.index ? Array.from(geometry.index.array) : [...Array(n).keys()]);
    return { surface, geometry: g };
  });
}
