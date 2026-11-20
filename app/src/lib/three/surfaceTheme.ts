/**
 * The ONE seam between geometry and appearance (docs/research/TEXTURES_ASSETS.md §4).
 *
 * The builder only knows surface KINDS ("wall", "door", "floor_kitchen", ...).
 * A SurfaceTheme maps each kind to a material factory. Every texture option in
 * the bake-off (Procedural Plus, CC0 Photo PBR, Kit Fixtures) is just another
 * SurfaceTheme; the geometry, the GLB export and AR stay untouched.
 *
 * Material budget: Scene Viewer recommends at most 10 materials (2 alpha), one
 * mesh per material. Kinds that map to the SAME factory function share one
 * material and one merged mesh, so a theme controls its budget by reusing
 * factories (e.g. every dry room floor -> one wood factory). `themeMaterialCount`
 * is the number a theme will produce at most; tests hold it to <= 10.
 */
import * as THREE from "three";
import type { OpeningKind } from "@/lib/plan/fixtures";
import { homeTheme } from "./homeTheme";
import type { FitMode, KitFixture } from "./kitFixtures";
import { getWallTexture } from "./materials";

/** Room types the engine emits (backend cubicasa.py). Anything else is "generic". */
export const ROOM_TYPES = ["bedroom", "living_room", "bathroom", "kitchen", "entry", "storage", "garage", "room"] as const;
export type RoomType = (typeof ROOM_TYPES)[number] | "generic";
export type FloorKind = `floor_${RoomType}`;

export type RequiredSurfaceKind = "wall" | "slab" | "skirting" | "door" | "window_frame" | "glass" | FloorKind;
/**
 * Kinds a theme MAY cover. "hardware" is only emitted by kit fixture models
 * (door handles); a theme without kit fixtures never needs it.
 */
export type OptionalSurfaceKind = "hardware";
export type SurfaceKind = RequiredSurfaceKind | OptionalSurfaceKind;

/** Every kind a theme must cover. */
export const SURFACE_KINDS: readonly RequiredSurfaceKind[] = [
  "wall",
  "slab",
  "skirting",
  "door",
  "window_frame",
  "glass",
  ...ROOM_TYPES.map((t) => `floor_${t}` as FloorKind),
  "floor_generic",
];

/**
 * Builds a fresh material for a kind. Called at most once per factory per model
 * build; the model owns (and disposes) what it returns. Shared textures should
 * be cached by the theme, not recreated here.
 */
export type MaterialFactory = (kind: SurfaceKind) => THREE.Material;

export interface SurfaceTheme {
  /** registry key, used by ?theme= and the bake-off output folder */
  readonly name: string;
  readonly materials: Readonly<Record<RequiredSurfaceKind, MaterialFactory>> &
    Readonly<Partial<Record<OptionalSurfaceKind, MaterialFactory>>>;
  /**
   * Optional async warm-up (image textures, kit models) that callers await
   * before the first build. Memoised: every call returns the same promise.
   * Must never reject: assets that fail to load leave the build on flat
   * colours and box fixtures instead of blocking it (works offline).
   */
  preload?(): Promise<void>;
  /** true once preload() has settled (or the theme has no preload) */
  isReady?(): boolean;
  /** Optional numbers for the bake-off metrics (load times, failures, ...). */
  stats?(): Record<string, unknown>;
  /** a kit model that fills openings of this kind instead of the box fixtures */
  fixtureModel?(kind: OpeningKind): KitFixture | null;
  /** how fixture models are fitted into openings (default "slice") */
  fixtureFit?: FitMode;
}

export function themeHas(theme: SurfaceTheme, kind: SurfaceKind): boolean {
  return typeof theme.materials[kind] === "function";
}

/** Await a theme's assets. Resolves immediately for synchronous themes; never rejects. */
export function preloadTheme(theme: SurfaceTheme = DEFAULT_THEME): Promise<void> {
  return theme.preload ? theme.preload().catch(() => undefined) : Promise.resolve();
}

/** Has the theme finished loading (successfully or not)? */
export function themeReady(theme: SurfaceTheme = DEFAULT_THEME): boolean {
  return theme.isReady ? theme.isReady() : !theme.preload;
}

/** null / unknown room types fall back to the generic floor. */
export function floorKind(roomType: string | null | undefined): FloorKind {
  const t = (roomType ?? "").toLowerCase();
  return (ROOM_TYPES as readonly string[]).includes(t) ? (`floor_${t}` as FloorKind) : "floor_generic";
}

/** Distinct materials a theme can produce (= distinct factories). */
export function themeMaterialCount(theme: SurfaceTheme): number {
  return new Set(Object.values(theme.materials).filter(Boolean)).size;
}

/**
 * Per-build memo: one material per factory, named after the first kind that
 * asked for it unless the factory named it itself.
 */
export class ThemeMaterials {
  private byFactory = new Map<MaterialFactory, THREE.Material>();
  constructor(readonly theme: SurfaceTheme) {}

  get(kind: SurfaceKind): THREE.Material {
    const factory = this.theme.materials[kind];
    if (!factory) throw new Error(`theme ${this.theme.name} has no material for ${kind}`);
    let mat = this.byFactory.get(factory);
    if (!mat) {
      mat = factory(kind);
      if (!mat.name) mat.name = kind;
      this.byFactory.set(factory, mat);
    }
    return mat;
  }
}

// ---------------------------------------------------------------------------
// Placeholder theme: neutral colours, the procedural plaster map on walls and
// slab, P0 box fixtures, no async assets. It was the bake-off baseline; it stays
// registered for comparison (?theme=placeholder) and for tests.
// ---------------------------------------------------------------------------

/** Non-metallic PBR: GLTFExporter writes non-Standard materials as 50 % metal. */
export function matte(params: THREE.MeshStandardMaterialParameters & { name: string }): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ metalness: 0, roughness: 0.9, ...params });
}

const wall: MaterialFactory = () => matte({ name: "wall", color: 0xffffff, map: getWallTexture() });
const slab: MaterialFactory = () => matte({ name: "slab", color: 0x9a9a9a, map: getWallTexture(), side: THREE.DoubleSide });
const skirting: MaterialFactory = () => matte({ name: "skirting", color: 0xd9d6cf, roughness: 0.7 });
const door: MaterialFactory = () => matte({ name: "door", color: 0xb89a74, roughness: 0.75 });
const frame: MaterialFactory = () => matte({ name: "window_frame", color: 0xf2f2f0, roughness: 0.6 });
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
// Three floor groups keep the budget: dry rooms, wet rooms, utility rooms.
const floorDry: MaterialFactory = () => matte({ name: "floor_dry", color: 0xd8c4a3, side: THREE.DoubleSide });
const floorWet: MaterialFactory = () => matte({ name: "floor_wet", color: 0xc9d6dc, roughness: 0.6, side: THREE.DoubleSide });
const floorUtility: MaterialFactory = () => matte({ name: "floor_utility", color: 0xb5b3ae, side: THREE.DoubleSide });

export const placeholderTheme: SurfaceTheme = {
  name: "placeholder",
  materials: {
    wall,
    slab,
    skirting,
    door,
    window_frame: frame,
    glass,
    floor_bedroom: floorDry,
    floor_living_room: floorDry,
    floor_room: floorDry,
    floor_entry: floorDry,
    floor_generic: floorDry,
    floor_kitchen: floorWet,
    floor_bathroom: floorWet,
    floor_garage: floorUtility,
    floor_storage: floorUtility,
  },
};

/** Themes selectable by name (?theme= in the bake-off). */
export const THEMES: Readonly<Record<string, SurfaceTheme>> = {
  home: homeTheme,
  placeholder: placeholderTheme,
};

/**
 * The app's theme (viewer, AR, GLB export): "home", the bake-off winner
 * (docs/research/bakeoff/DECISION.md). Its assets load asynchronously, so
 * every consumer awaits preloadTheme() before its first build.
 */
export const DEFAULT_THEME: SurfaceTheme = homeTheme;

export function themeByName(name: string | null | undefined): SurfaceTheme {
  return (name && THEMES[name]) || DEFAULT_THEME;
}
