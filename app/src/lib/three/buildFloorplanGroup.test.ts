import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { loadSample } from "@/test/samples";
import { initialPpm, preparePlan } from "@/lib/plan";
import { buildFloorplanGroup, disposeGroup } from "./buildFloorplanGroup";
import { SURFACE_KINDS, THEMES, floorKind, placeholderTheme, themeByName, themeMaterialCount } from "./surfaceTheme";

function meshes(group: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

const build = (name: string, includeRooms = true, wallOpacity = 1) => {
  const raw = loadSample(name);
  return buildFloorplanGroup(preparePlan(raw), { ppm: initialPpm(raw), wallHeightM: 2.5, includeRooms, wallOpacity });
};

describe("surface themes", () => {
  it("every registered theme covers every kind and stays within the 10-material budget", () => {
    for (const theme of Object.values(THEMES)) {
      for (const kind of SURFACE_KINDS) expect(typeof theme.materials[kind]).toBe("function");
      expect(themeMaterialCount(theme)).toBeLessThanOrEqual(10);
    }
  });

  it("maps room types to floor kinds with a generic fallback", () => {
    expect(floorKind("kitchen")).toBe("floor_kitchen");
    expect(floorKind("Living_Room")).toBe("floor_living_room");
    expect(floorKind(null)).toBe("floor_generic");
    expect(floorKind("ballroom")).toBe("floor_generic");
  });

  it("themeByName falls back to the placeholder", () => {
    expect(themeByName("nope")).toBe(placeholderTheme);
    expect(themeByName(undefined)).toBe(placeholderTheme);
  });
});

describe("buildFloorplanGroup", () => {
  it.each(["cubicasa", "newri-reference", "bungalow"])("%s: matte PBR, one mesh per material, <= 10 materials", (name) => {
    const model = build(name);
    const ms = meshes(model.group);
    const mats = new Set(ms.map((m) => m.material as THREE.Material));
    expect(mats.size).toBe(ms.length);
    expect(mats.size).toBeLessThanOrEqual(10);
    for (const m of mats) {
      // GLTFExporter writes anything else as 50 % metal (dark grey in Scene Viewer).
      expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect((m as THREE.MeshStandardMaterial).metalness).toBe(0);
    }
    expect([...mats].filter((m) => m.transparent).length).toBeLessThanOrEqual(2);
    disposeGroup(model.group);
  });

  it("cubicasa renders doors, frames and glass; null room types use the generic floor", () => {
    const model = build("cubicasa");
    const names = meshes(model.group).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["walls", "skirting", "door", "window_frame", "glass", "floor", "floor_dry"]));
    expect(model.fixtures.openings).toHaveLength(11);
    const rooms = model.group.getObjectByName("rooms")!;
    expect(rooms.children).toHaveLength(1);
    expect((rooms.userData.rooms as { kind: string }[]).every((r) => r.kind === "floor_generic")).toBe(true);
  });

  it("typed rooms are merged per floor material, not one mesh per room", () => {
    const model = build("bungalow");
    const rooms = model.group.getObjectByName("rooms")!;
    // living/bedroom -> dry, bathroom/kitchen -> wet
    expect(rooms.children.map((c) => c.name).sort()).toEqual(["floor_dry", "floor_wet"]);
    expect(meshes(model.group).some((m) => m.name === "door")).toBe(false);
  });

  it("AR build (no rooms) still has openings", () => {
    const model = build("cubicasa", false);
    expect(model.group.getObjectByName("rooms")).toBeUndefined();
    expect(model.group.getObjectByName("glass")).toBeDefined();
  });

  it("see-through applies to wall and skirting, not to fixtures", () => {
    const model = build("cubicasa", false, 0.35);
    expect(model.wallMaterials.map((m) => m.name)).toEqual(["wall", "skirting"]);
    for (const m of model.wallMaterials) {
      expect(m.transparent).toBe(true);
      expect(m.opacity).toBeCloseTo(0.35);
    }
    const door = model.group.getObjectByName("door") as THREE.Mesh;
    expect((door.material as THREE.Material).transparent).toBe(false);
  });
});
