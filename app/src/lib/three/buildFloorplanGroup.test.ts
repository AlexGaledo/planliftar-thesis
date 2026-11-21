import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSample } from "@/test/samples";
import { initialPpm, preparePlan } from "@/lib/plan";
import { buildFloorplanGroup, disposeGroup } from "./buildFloorplanGroup";
import { homeTheme, setHomeFixtures } from "./homeTheme";
import { parseKitFixture } from "./kitFixtures";
import {
  DEFAULT_THEME,
  SURFACE_KINDS,
  THEMES,
  floorKind,
  placeholderTheme,
  themeByName,
  themeMaterialCount,
  type SurfaceTheme,
} from "./surfaceTheme";

function meshes(group: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

// The P0 cases below pin the placeholder theme (box fixtures, its own names).
const build = (name: string, includeRooms = true, wallOpacity = 1, theme: SurfaceTheme = placeholderTheme) => {
  const raw = loadSample(name);
  return buildFloorplanGroup(preparePlan(raw), { ppm: initialPpm(raw), wallHeightM: 2.5, includeRooms, wallOpacity, theme });
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

  it("home is the default; themeByName falls back to it; placeholder stays registered", () => {
    expect(DEFAULT_THEME).toBe(homeTheme);
    expect(themeByName("nope")).toBe(homeTheme);
    expect(themeByName(undefined)).toBe(homeTheme);
    expect(themeByName("placeholder")).toBe(placeholderTheme);
    expect(Object.keys(THEMES).sort()).toEqual(["home", "placeholder"]);
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

describe("home theme with kit fixtures", () => {
  const glb = (name: string) =>
    new Uint8Array(readFileSync(resolve(__dirname, `../../../public/models/fixtures/${name}.glb`))).buffer;
  beforeAll(async () => {
    setHomeFixtures({ door: await parseKitFixture("door", glb("door")), window: await parseKitFixture("window", glb("window")) });
  });
  afterAll(() => setHomeFixtures({ door: undefined, window: undefined }));

  it.each(["cubicasa", "newri-reference", "bungalow"])("%s: kit pieces merge into <= 9 materials, 1 alpha, no extra meshes", (name) => {
    const model = build(name, true, 1, homeTheme);
    const ms = meshes(model.group);
    const mats = new Set(ms.map((m) => m.material as THREE.Material));
    expect(mats.size).toBe(ms.length); // one mesh per material
    expect(mats.size).toBeLessThanOrEqual(9);
    expect([...mats].filter((m) => m.transparent).length).toBeLessThanOrEqual(1);
    for (const m of ms) expect(m.geometry.attributes.uv).toBeDefined();
    for (const m of mats) expect((m as THREE.MeshStandardMaterial).metalness).toBeLessThanOrEqual(0.35);
    if (model.fixtures.openings.some((o) => o.kind === "door")) expect(ms.some((m) => m.name === "hardware")).toBe(true);
    // Same plan, placeholder theme: the kit adds triangles, not meshes per opening.
    const base = build(name, true, 1, placeholderTheme);
    expect(ms.length).toBeLessThanOrEqual(meshes(base.group).length + 2);
    disposeGroup(base.group);
    disposeGroup(model.group);
  });

  it("cubicasa: kit frames replace the box frames, the wall cut and lintel stay", () => {
    const model = build("cubicasa", false, 1, homeTheme);
    const names = meshes(model.group).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["walls", "trim", "door", "hardware", "glass"]));
    expect(names).not.toContain("base_shade");
    disposeGroup(model.group);
  });
});
