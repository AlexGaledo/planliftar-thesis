/**
 * Builds the three.js model of a plan: walls with door/window openings, the
 * fixtures that fill them, skirting, the floor slab (+ room floors).
 *
 * Port of ar.html's buildFloorplanGroup(), shared by the AR session, the 3D
 * viewer and GLB export so all three show the exact same geometry.
 *
 * Coordinate mapping (see lib/plan/geometry.ts): the model origin is the plan's
 * footprint centre, plan px map to local metres through ppm, plan +Y becomes
 * local -Z, and walls stand on y = 0. The 1:N miniature factor is NOT applied
 * here; callers scale the returned group.
 *
 * Performance notes carried over from the prototype:
 *  - Boxes are merged into ONE geometry per material (244 draw calls -> 1 for the
 *    cubicasa walls, which is what made the phone crawl before).
 *  - Exact duplicate walls (A->B and B->A) are dropped; coincident boxes z-fight.
 *
 * Appearance is never decided here: each surface has a kind ("wall", "door",
 * "floor_kitchen", ...) and the SurfaceTheme (surfaceTheme.ts) supplies its
 * material. Doors and windows come from lib/plan/fixtures.ts (normalisation)
 * and wallLayout.ts (openings as boxes).
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { normalizeFixtures, type FixtureReport, type OpeningKind } from "@/lib/plan/fixtures";
import { boundsCenter, computeBounds, planToLocal } from "@/lib/plan/geometry";
import type { Plan } from "@/lib/plan/types";
import { applyWallOpacity, scaleBoxUVs } from "./materials";
import { placeKitFixture } from "./kitFixtures";
import { DEFAULT_THEME, floorKind, ThemeMaterials, type SurfaceKind, type SurfaceTheme } from "./surfaceTheme";
import { fixtureSlots, layoutWalls, type BoxSpec } from "./wallLayout";

export interface BuildOptions {
  /** plan px per real metre (from the user's reference dimension) */
  ppm: number;
  /** real wall height in metres (ar.html default 2.5) */
  wallHeightM: number;
  /** 0.05..1; 1 = solid */
  wallOpacity?: number;
  /** add room floors (viewer/GLB); AR leaves them out */
  includeRooms?: boolean;
  /** surface kind -> material (+ kit fixtures); defaults to DEFAULT_THEME ("home") */
  theme?: SurfaceTheme;
}

/** The pieces callers may want to reach into after building. */
export interface FloorplanModel {
  group: THREE.Group;
  /** the wall material (walls, lintels, sills, headers) */
  wallMaterial: THREE.Material;
  /** materials that follow the see-through setting: wall + skirting */
  wallMaterials: THREE.Material[];
  /** footprint size in metres */
  widthM: number;
  depthM: number;
  /** doors/windows that were placed, and the ones dropped (with why) */
  fixtures: FixtureReport;
}

const SLAB_THICKNESS_M = 0.02;
const SLAB_MARGIN = 1.04;

/** A soft, print-like categorical palette for room fills in the 2D overlay. */
export const ROOM_COLORS = ["#c9d8e8", "#e6d3b3", "#cfe3cf", "#e8c9cf", "#d9d0e8", "#e3e1c4", "#c7e0e0", "#e0cbbd"];

export function roomColor(index: number): string {
  return ROOM_COLORS[index % ROOM_COLORS.length];
}

/** One BoxGeometry per spec, UVs in metres, placed and rotated. */
function boxGeometry(b: BoxSpec): THREE.BufferGeometry {
  const geom = new THREE.BoxGeometry(b.thickness, b.height, b.length);
  scaleBoxUVs(geom, b.thickness, b.height, b.length);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(b.x, b.y, b.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw),
    new THREE.Vector3(1, 1, 1),
  );
  geom.applyMatrix4(m);
  return geom;
}

/** Merge geometries into one mesh (one draw call, one GLB mesh per material). */
function mergedMesh(geoms: THREE.BufferGeometry[], material: THREE.Material, name: string): THREE.Object3D {
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
  if (merged) {
    if (merged !== geoms[0]) geoms.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    return mesh;
  }
  // Cannot realistically happen (identical attributes), but never drop geometry.
  const g = new THREE.Group();
  g.name = name;
  geoms.forEach((geom) => g.add(new THREE.Mesh(geom, material)));
  return g;
}

/** Bucket items by the material their kind resolves to, then merge each bucket. */
function addByMaterial<T>(
  parent: THREE.Object3D,
  mats: ThemeMaterials,
  items: T[],
  kindOf: (item: T) => SurfaceKind,
  geometryOf: (item: T) => THREE.BufferGeometry,
): void {
  const buckets = new Map<THREE.Material, { kinds: Set<SurfaceKind>; geoms: THREE.BufferGeometry[] }>();
  for (const item of items) {
    const kind = kindOf(item);
    const mat = mats.get(kind);
    let bucket = buckets.get(mat);
    if (!bucket) {
      bucket = { kinds: new Set(), geoms: [] };
      buckets.set(mat, bucket);
    }
    bucket.kinds.add(kind);
    bucket.geoms.push(geometryOf(item));
  }
  for (const [mat, bucket] of buckets) {
    const mesh = mergedMesh(bucket.geoms, mat, mat.name);
    mesh.userData = { surfaceKinds: [...bucket.kinds] };
    parent.add(mesh);
  }
}

export function buildFloorplanGroup(plan: Plan, opts: BuildOptions): FloorplanModel {
  const { ppm, wallHeightM, wallOpacity = 1, includeRooms = false, theme = DEFAULT_THEME } = opts;
  const bounds = computeBounds(plan);
  const center = boundsCenter(bounds);
  const mats = new ThemeMaterials(theme);

  const group = new THREE.Group();
  group.name = "floorplan";
  group.userData = { theme: theme.name };

  // Walls, openings and fixtures: boxes merged per material. Lintels, sills and
  // headers are kind "wall", so they share the wall mesh and its see-through.
  const fixtures = normalizeFixtures(plan, ppm);
  // Kit fixtures: a model fills the opening instead of the frame/leaf/glass
  // boxes. Only when the theme has the model loaded; otherwise the boxes stay.
  const kitKinds = new Set<OpeningKind>((["door", "window"] as const).filter((k) => theme.fixtureModel?.(k)));
  const boxes = layoutWalls(plan.walls || [], fixtures.openings, { ppm, wallHeightM, center, kitKinds });
  const pieces: { kind: SurfaceKind; geometry: () => THREE.BufferGeometry }[] = boxes.map((b) => ({
    kind: b.kind,
    geometry: () => boxGeometry(b),
  }));
  if (kitKinds.size) {
    for (const slot of fixtureSlots(fixtures.openings, { ppm, wallHeightM, center })) {
      const model = kitKinds.has(slot.kind) ? theme.fixtureModel?.(slot.kind) : null;
      if (!model) continue;
      for (const p of placeKitFixture(model, slot, theme.fixtureFit)) pieces.push({ kind: p.surface, geometry: () => p.geometry });
    }
  }
  addByMaterial(group, mats, pieces, (p) => p.kind, (p) => p.geometry());
  const wallMaterial = mats.get("wall");
  const wallMesh = group.children.find((c) => (c as THREE.Mesh).material === wallMaterial);
  if (wallMesh) wallMesh.name = "walls";
  const wallMaterials = [wallMaterial];
  if (boxes.some((b) => b.kind === "skirting")) {
    const skirting = mats.get("skirting");
    if (skirting !== wallMaterial) wallMaterials.push(skirting);
  }
  wallMaterials.forEach((m) => applyWallOpacity(m, wallOpacity));

  // Slab at y = 0: without it the walls read as boxes floating in space.
  const widthM = bounds.widthPx / ppm;
  const depthM = bounds.heightPx / ppm;
  if (widthM > 0 && depthM > 0) {
    const sx = widthM * SLAB_MARGIN;
    const sz = depthM * SLAB_MARGIN;
    const slabGeom = new THREE.BoxGeometry(sx, SLAB_THICKNESS_M, sz);
    scaleBoxUVs(slabGeom, sx, SLAB_THICKNESS_M, sz);
    const slab = new THREE.Mesh(slabGeom, mats.get("slab"));
    slab.position.set(0, -SLAB_THICKNESS_M / 2, 0);
    slab.name = "floor";
    group.add(slab);
  }

  // Room floors: one merged mesh per floor material, not one per room (Scene
  // Viewer: <= 10 materials, one mesh each). ShapeGeometry UVs are the shape
  // coordinates, i.e. already metres, so textures tile like the walls do.
  if (includeRooms) {
    const rooms = (plan.rooms || []).filter((r) => r.polygon && r.polygon.length >= 3);
    const floors = new THREE.Group();
    floors.name = "rooms";
    floors.position.y = 0.002; // just above the slab, avoids z-fighting
    addByMaterial(
      floors,
      mats,
      rooms,
      (r) => floorKind(r.type),
      (room) => {
        // ShapeGeometry is built in XY; rotate to lie flat. Shape y = -localZ so
        // the rotation maps it back onto the plan's orientation.
        const shape = new THREE.Shape(
          room.polygon.map((p) => {
            const l = planToLocal(p.x, p.y, center, ppm);
            return new THREE.Vector2(l.x, -l.z);
          }),
        );
        const geom = new THREE.ShapeGeometry(shape);
        geom.rotateX(-Math.PI / 2);
        return geom;
      },
    );
    floors.userData = {
      rooms: rooms.map((r, i) => ({ roomId: r.id ?? String(i), roomType: r.type ?? null, kind: floorKind(r.type) })),
    };
    if (floors.children.length) group.add(floors);
  }

  return { group, wallMaterial, wallMaterials, widthM, depthM, fixtures };
}

/**
 * Dropping a group from the scene does not free GPU buffers. Rebuilding on every
 * scale edit without this leaks a full copy of the wall geometry each time.
 */
export function disposeGroup(group: THREE.Object3D | null | undefined): void {
  if (!group) return;
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // Theme textures are shared across builds, so only materials go.
      mats.forEach((mat) => mat?.dispose());
    }
  });
}
