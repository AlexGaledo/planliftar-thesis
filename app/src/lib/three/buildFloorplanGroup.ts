/**
 * Builds the three.js model of a plan: extruded walls + floor slab (+ rooms).
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
 *  - All wall boxes are merged into ONE geometry (244 draw calls -> 1 on the
 *    cubicasa plan, which is what made the phone crawl before).
 *  - Exact duplicate walls (A->B and B->A) are dropped; coincident boxes z-fight.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { boundsCenter, computeBounds, planToLocal } from "@/lib/plan/geometry";
import type { Plan } from "@/lib/plan/types";
import { applyWallOpacity, createWallMaterial, getWallTexture, scaleBoxUVs } from "./materials";

export interface BuildOptions {
  /** plan px per real metre (from the user's reference dimension) */
  ppm: number;
  /** real wall height in metres (ar.html default 2.5) */
  wallHeightM: number;
  /** 0.05..1; 1 = solid */
  wallOpacity?: number;
  /** add coloured room floor tiles (viewer/GLB); AR leaves them out */
  includeRooms?: boolean;
}

/** The pieces callers may want to reach into after building. */
export interface FloorplanModel {
  group: THREE.Group;
  wallMaterial: THREE.MeshLambertMaterial;
  /** footprint size in metres */
  widthM: number;
  depthM: number;
}

/** Walls thinner than this (metres) are thickened so they stay visible. */
const MIN_WALL_THICKNESS_M = 0.02;
const SLAB_THICKNESS_M = 0.02;
const SLAB_MARGIN = 1.04;

/** A soft, print-like categorical palette for room floors (works on white and black). */
export const ROOM_COLORS = ["#c9d8e8", "#e6d3b3", "#cfe3cf", "#e8c9cf", "#d9d0e8", "#e3e1c4", "#c7e0e0", "#e0cbbd"];

export function roomColor(index: number): string {
  return ROOM_COLORS[index % ROOM_COLORS.length];
}

export function buildFloorplanGroup(plan: Plan, opts: BuildOptions): FloorplanModel {
  const { ppm, wallHeightM, wallOpacity = 1, includeRooms = false } = opts;
  const bounds = computeBounds(plan);
  const center = boundsCenter(bounds);
  const toLocal = (px: number, py: number) => {
    const l = planToLocal(px, py, center, ppm);
    return new THREE.Vector3(l.x, 0, l.z);
  };

  const group = new THREE.Group();
  group.name = "floorplan";
  const material = createWallMaterial(getWallTexture());
  applyWallOpacity(material, wallOpacity);

  const wallGeoms: THREE.BufferGeometry[] = [];
  const UP = new THREE.Vector3(0, 1, 0);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const unit = new THREE.Vector3(1, 1, 1);
  const seen = new Set<string>();
  const endKey = (p: { x: number; y: number }) => `${Math.round(p.x)},${Math.round(p.y)}`;

  for (const w of plan.walls) {
    if (!w.start || !w.end) continue;
    // Key on the unordered endpoint pair so A->B and B->A collapse to one.
    const a = endKey(w.start);
    const b = endKey(w.end);
    const key = (a < b ? `${a}|${b}` : `${b}|${a}`) + `|${Math.round((w.thickness || 4) * 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const p1 = toLocal(w.start.x, w.start.y);
    const p2 = toLocal(w.end.x, w.end.y);
    const delta = new THREE.Vector3().subVectors(p2, p1);
    const length = Math.max(0.0001, delta.length()); // zero-length wall guard
    const thicknessM = Math.max(MIN_WALL_THICKNESS_M, (w.thickness || 4) / ppm);

    const geom = new THREE.BoxGeometry(thicknessM, wallHeightM, length);
    scaleBoxUVs(geom, thicknessM, wallHeightM, length);
    const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
    // Align the box's +Z (length axis) with the wall direction.
    q.setFromAxisAngle(UP, Math.atan2(delta.x, delta.z));
    m.compose(new THREE.Vector3(mid.x, wallHeightM / 2, mid.z), q, unit);
    geom.applyMatrix4(m);
    wallGeoms.push(geom);
  }

  if (wallGeoms.length) {
    const merged = mergeGeometries(wallGeoms, false);
    if (merged) {
      wallGeoms.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = "walls";
      group.add(mesh);
    } else {
      // Cannot realistically happen (identical attributes), but never drop walls.
      wallGeoms.forEach((g) => group.add(new THREE.Mesh(g, material)));
    }
  }

  // Slab at y = 0: without it the walls read as boxes floating in space.
  const widthM = bounds.widthPx / ppm;
  const depthM = bounds.heightPx / ppm;
  if (widthM > 0 && depthM > 0) {
    const slabGeom = new THREE.BoxGeometry(widthM * SLAB_MARGIN, SLAB_THICKNESS_M, depthM * SLAB_MARGIN);
    scaleBoxUVs(slabGeom, widthM * SLAB_MARGIN, SLAB_THICKNESS_M, depthM * SLAB_MARGIN);
    const slab = new THREE.Mesh(
      slabGeom,
      new THREE.MeshLambertMaterial({ color: 0x9a9a9a, map: getWallTexture(), side: THREE.DoubleSide }),
    );
    slab.position.set(0, -SLAB_THICKNESS_M / 2, 0);
    slab.name = "floor";
    group.add(slab);
  }

  if (includeRooms) {
    (plan.rooms || []).forEach((room, i) => {
      if (!room.polygon || room.polygon.length < 3) return;
      // ShapeGeometry is built in XY; rotate to lie flat. Shape y = -localZ so the
      // rotation maps it back onto the plan's orientation.
      const shape = new THREE.Shape(room.polygon.map((p) => {
        const l = toLocal(p.x, p.y);
        return new THREE.Vector2(l.x, -l.z);
      }));
      const geom = new THREE.ShapeGeometry(shape);
      geom.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(
        geom,
        new THREE.MeshLambertMaterial({ color: roomColor(i), side: THREE.DoubleSide }),
      );
      mesh.position.y = 0.002; // just above the slab, avoids z-fighting
      mesh.name = `room:${room.id ?? i}`;
      mesh.userData = { roomId: room.id, roomType: room.type };
      group.add(mesh);
    });
  }

  return { group, wallMaterial: material, widthM, depthM };
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
      // The shared wall texture is reused across builds, so only materials go.
      mats.forEach((mat) => mat?.dispose());
    }
  });
}
