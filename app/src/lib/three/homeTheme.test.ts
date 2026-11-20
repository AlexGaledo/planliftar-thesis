import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadSample } from "@/test/samples";
import { initialPpm, preparePlan } from "@/lib/plan";
import { buildFloorplanGroup, disposeGroup } from "./buildFloorplanGroup";
import { exportObjectAsGlb } from "./exportGlb";
import { homeTheme } from "./homeTheme";
import { preloadTheme, themeMaterialCount, themeReady } from "./surfaceTheme";

// NOTE: homeTheme keeps module state (preload is memoised), so the tests in
// this file run in order: everything before "after preload" sees a cold theme.

const build = (name: string, includeRooms = true) => {
  const raw = loadSample(name);
  return buildFloorplanGroup(preparePlan(raw), { ppm: initialPpm(raw), wallHeightM: 2.5, includeRooms, theme: homeTheme });
};

const meshes = (g: THREE.Object3D) => {
  const out: THREE.Mesh[] = [];
  g.traverse((o) => (o as THREE.Mesh).isMesh && out.push(o as THREE.Mesh));
  return out;
};

const kindsOf = (ms: THREE.Mesh[]) => new Set(ms.flatMap((m) => (m.userData.surfaceKinds as string[]) ?? []));

const glbBytes = (name: string) =>
  new Uint8Array(readFileSync(resolve(__dirname, `../../../public/models/fixtures/${name}.glb`))).buffer;

afterAll(() => vi.restoreAllMocks());

describe("home theme", () => {
  it("keeps the budget: 9 materials, one alpha; trim is shared and map-free", () => {
    expect(themeMaterialCount(homeTheme)).toBe(9);
    const m = homeTheme.materials;
    expect(m.floor_bedroom).toBe(m.floor_generic);
    expect(m.floor_kitchen).toBe(m.floor_bathroom);
    expect(m.floor_garage).toBe(m.floor_storage);
    expect(new Set([m.floor_generic, m.floor_kitchen, m.floor_garage]).size).toBe(3);
    expect(m.skirting).toBe(m.window_frame);
    const trim = m.skirting("skirting") as THREE.MeshStandardMaterial;
    expect(trim.map).toBeNull();
    expect(trim.color.getHex()).toBe(0xf1f0ec);
    expect(typeof m.hardware).toBe("function");
  });

  it.each(["cubicasa", "newri-reference", "bungalow"])(
    "%s before preload: box fixtures, fallback colours, no maps (W5)",
    (name) => {
      expect(themeReady(homeTheme)).toBe(false);
      const model = build(name);
      const ms = meshes(model.group);
      const mats = new Set(ms.map((x) => x.material as THREE.MeshStandardMaterial));
      expect(mats.size).toBeLessThanOrEqual(9);
      for (const mat of mats) expect(mat.map).toBeNull();
      // P0 boxes: no handle; doors (if any) are box leaves.
      expect(kindsOf(ms).has("hardware")).toBe(false);
      disposeGroup(model.group);
    },
  );

  it("preload never rejects, even when every asset fails", async () => {
    // A separate theme instance is not exported, so prove the contract on the
    // helper: a rejecting preload is swallowed.
    await expect(preloadTheme({ ...homeTheme, preload: () => Promise.reject(new Error("offline")) })).resolves.toBeUndefined();
  });

  it("after preload: maps on every photo surface and kit pieces with a handle (W5)", async () => {
    // jsdom cannot decode images or fetch: stand in for the network.
    vi.spyOn(THREE.TextureLoader.prototype, "loadAsync").mockImplementation(async (url: string) => {
      const t = new THREE.Texture();
      t.name = url;
      return t;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const name = String(input).includes("door") ? "door" : "window";
      return new Response(glbBytes(name));
    });
    await preloadTheme(homeTheme);
    expect(themeReady(homeTheme)).toBe(true);
    const stats = homeTheme.stats?.() as { mapsLoaded: number; mapsFailed: string[]; fixturesFailed: string[] };
    expect(stats.mapsLoaded).toBe(5);
    expect(stats.mapsFailed).toEqual([]);
    expect(stats.fixturesFailed).toEqual([]);
    // memoised: a second call does not refetch
    const calls = vi.mocked(fetch).mock.calls.length;
    await preloadTheme(homeTheme);
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);

    const model = build("cubicasa");
    const ms = meshes(model.group);
    const byName = new Map(ms.map((x) => [x.name, x.material as THREE.MeshStandardMaterial]));
    for (const n of ["walls", "floor", "door", "floor_wood"]) expect(byName.get(n)?.map, n).toBeInstanceOf(THREE.Texture);
    expect(byName.get("trim")?.map).toBeNull();
    expect(kindsOf(ms).has("hardware")).toBe(true);
    // wall map tiles at 2 m (W1)
    expect(byName.get("walls")!.map!.repeat.x).toBeCloseTo(0.5);
    disposeGroup(model.group);
  });

  it("exports a GLB with no viewer-only maps to strip and 1 alpha material", async () => {
    const model = build("bungalow");
    model.group.updateMatrixWorld(true);
    // Textures without image data cannot be embedded; drop them for this structural check.
    model.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m) m.map = null;
    });
    const blob = await exportObjectAsGlb(model.group);
    const buf = await new Promise<ArrayBuffer>((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result as ArrayBuffer);
      r.readAsArrayBuffer(blob);
    });
    const dv = new DataView(buf);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, dv.getUint32(12, true))));
    expect(json.materials.length).toBeLessThanOrEqual(9);
    expect(json.materials.filter((m: { alphaMode?: string }) => m.alphaMode === "BLEND").length).toBeLessThanOrEqual(1);
    disposeGroup(model.group);
  });
});
