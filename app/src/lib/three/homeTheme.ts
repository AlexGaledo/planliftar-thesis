/**
 * The "home" surface theme: the app's default look, the texture bake-off winner
 * "Photo + Kit" (docs/research/bakeoff/DECISION.md).
 *
 *   - Bundled ambientCG photo colour maps (CC0, public/textures/CREDITS.txt),
 *     512 px JPEG q80: reprocessed plaster walls, oak floors, stone tile,
 *     concrete, a wood door veneer.
 *   - CC0 Kenney door and window models (public/models/CREDITS.txt) fitted into
 *     the wall openings by kitFixtures.ts (9-slice), with a lever handle.
 *   - Flat paint for trim (skirting, door and window frames), satin metal for
 *     the handle, translucent glass.
 *
 * 9 materials at most, 1 alpha (glass): wall, slab, trim, door, glass,
 * hardware, floor_wood, floor_tile, floor_concrete. Colour maps only, so the
 * GLB (Scene Viewer / model-viewer), AR and the viewer get the same materials.
 *
 * Images and models load asynchronously: preload() fetches all of them in
 * parallel, once (memoised), and never rejects. The service worker precaches
 * them, so it also works offline. Until it resolves, or for any asset that
 * failed, the build uses a flat fallback colour and the P0 box fixtures.
 *
 * Only `import type` from surfaceTheme: it registers this module in THEMES, so a
 * value import would be a cycle.
 */
import * as THREE from "three";
import type { OpeningKind } from "@/lib/plan/fixtures";
import { loadKitFixture, type KitFixture } from "./kitFixtures";
import type { MaterialFactory, RequiredSurfaceKind, SurfaceTheme } from "./surfaceTheme";

const BASE = "/textures/";

/** Every bundled map: real-world size of one image in metres (u, v). */
const MAPS = {
  plaster_color: { size: [2, 2] },
  door_color: { size: [0.8, 0.8] },
  wood_color: { size: [1.8, 1.8] },
  tile_color: { size: [2, 2] },
  concrete_color: { size: [1.1, 0.55] },
} as const satisfies Record<string, { size: readonly [number, number] }>;
type MapName = keyof typeof MAPS;
const MAP_NAMES = Object.keys(MAPS) as MapName[];

const textures = new Map<MapName, THREE.Texture>();
const failedMaps = new Set<MapName>();
const fixtures: Partial<Record<OpeningKind, KitFixture>> = {};
const failedFixtures: string[] = [];

function configure(name: MapName, tex: THREE.Texture): THREE.Texture {
  const spec = MAPS[name];
  tex.name = name;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // UVs are metres (scaleBoxUVs, ShapeGeometry, kit box projection), so one
  // repeat = one image size. Non-1 m sets export as KHR_texture_transform.
  tex.repeat.set(1 / spec.size[0], 1 / spec.size[1]);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  // GLTFExporter re-encodes through a canvas: JPEG, not PNG.
  tex.userData.mimeType = "image/jpeg";
  return tex;
}

async function loadMap(name: MapName): Promise<void> {
  try {
    textures.set(name, configure(name, await new THREE.TextureLoader().loadAsync(`${BASE}${name}.jpg`)));
  } catch {
    failedMaps.add(name);
  }
}

async function loadFixture(kind: OpeningKind): Promise<void> {
  try {
    fixtures[kind] = await loadKitFixture(kind);
  } catch (e) {
    failedFixtures.push(`${kind}: ${(e as Error).message}`);
  }
}

let loading: Promise<void> | null = null;
let ready = false;
let preloadMs: number | null = null;

/** Fetch every map and both kit models in parallel, once. Never rejects. */
function preload(): Promise<void> {
  loading ??= (async () => {
    const t0 = performance.now();
    await Promise.all([...MAP_NAMES.map(loadMap), loadFixture("door"), loadFixture("window")]);
    preloadMs = Math.round((performance.now() - t0) * 10) / 10;
    ready = true;
  })();
  return loading;
}

/** Test hook: install fixtures parsed elsewhere (no fetch in vitest). */
export function setHomeFixtures(fx: Partial<Record<OpeningKind, KitFixture>>): void {
  for (const k of ["door", "window"] as const) {
    if (k in fx) {
      if (fx[k]) fixtures[k] = fx[k];
      else delete fixtures[k];
    }
  }
}

const tex = (name: MapName): THREE.Texture | null => textures.get(name) ?? null;

interface Surface {
  name: string;
  /** colour multiplied with the map */
  color: string;
  /** colour when the map is missing (close to the photo's average) */
  fallback: string;
  map: MapName;
  roughness: number;
  side?: THREE.Side;
}

function photoFactory(s: Surface): MaterialFactory {
  return () => {
    const map = tex(s.map);
    return new THREE.MeshStandardMaterial({
      name: s.name,
      // Non-metallic: GLTFExporter writes non-Standard materials as 50 % metal.
      metalness: 0,
      roughness: s.roughness,
      color: map ? s.color : s.fallback,
      map,
      side: s.side ?? THREE.FrontSide,
    });
  };
}

const SURFACES = {
  wall: { name: "wall", color: "#ffffff", fallback: "#ecebe7", map: "plaster_color", roughness: 0.9 },
  slab: { name: "slab", color: "#9a9a9a", fallback: "#8a8a88", map: "concrete_color", roughness: 0.9, side: THREE.DoubleSide },
  door: { name: "door", color: "#ffffff", fallback: "#8a6a4c", map: "door_color", roughness: 0.7 },
  wood: { name: "floor_wood", color: "#ffffff", fallback: "#a07a55", map: "wood_color", roughness: 0.75, side: THREE.DoubleSide },
  tile: { name: "floor_tile", color: "#ffffff", fallback: "#b9a58c", map: "tile_color", roughness: 0.4, side: THREE.DoubleSide },
  concrete: {
    name: "floor_concrete",
    color: "#ffffff",
    fallback: "#b5b3ae",
    map: "concrete_color",
    roughness: 0.9,
    side: THREE.DoubleSide,
  },
} as const satisfies Record<string, Surface>;

const f = Object.fromEntries(Object.entries(SURFACES).map(([k, s]) => [k, photoFactory(s)])) as Record<
  keyof typeof SURFACES,
  MaterialFactory
>;

/** Skirting, door and window frames: flat white paint, no map (fix W3). */
const trim: MaterialFactory = () =>
  new THREE.MeshStandardMaterial({ name: "trim", color: 0xf1f0ec, roughness: 0.5, metalness: 0 });
/** Door handles. A high metalness renders black without an env map (AR, GLB viewers vary). */
const hardware: MaterialFactory = () =>
  new THREE.MeshStandardMaterial({ name: "hardware", color: 0xb9bec4, metalness: 0.35, roughness: 0.35 });
const glass: MaterialFactory = () =>
  new THREE.MeshStandardMaterial({
    name: "glass",
    color: 0xbcd6e6,
    metalness: 0,
    roughness: 0.1,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });

const materials: Record<RequiredSurfaceKind | "hardware", MaterialFactory> = {
  wall: f.wall,
  slab: f.slab,
  skirting: trim,
  door: f.door,
  window_frame: trim,
  glass,
  hardware,
  floor_bedroom: f.wood,
  floor_living_room: f.wood,
  floor_room: f.wood,
  floor_entry: f.wood,
  floor_generic: f.wood,
  floor_kitchen: f.tile,
  floor_bathroom: f.tile,
  floor_garage: f.concrete,
  floor_storage: f.concrete,
};

export const homeTheme: SurfaceTheme = {
  name: "home",
  materials,
  preload,
  isReady: () => ready,
  fixtureModel: (kind) => fixtures[kind] ?? null,
  fixtureFit: "slice",
  stats: () => ({
    preloadMs,
    maps: MAP_NAMES.length,
    mapsLoaded: MAP_NAMES.filter((m) => textures.has(m)).length,
    mapsFailed: MAP_NAMES.filter((m) => failedMaps.has(m)),
    fixtureFit: "slice",
    fixtureTriangles: { door: fixtures.door?.triangles ?? null, window: fixtures.window?.triangles ?? null },
    fixturesFailed: [...failedFixtures],
  }),
};
