/**
 * IndexedDB database (Dexie).
 *
 * Why IndexedDB and not localStorage: projects carry plan JSON (up to ~60 KB)
 * and the source image Blob (up to 15 MB). localStorage is ~5 MB of strings;
 * IndexedDB stores Blobs natively and is available offline.
 *
 * Why Dexie: the raw IndexedDB API is callback-based and verbose. Dexie gives a
 * promise API, typed tables, schema versioning, and `useLiveQuery` (a hook that
 * re-renders when the data changes, even from another tab).
 *
 * Schema rule: only INDEXED fields are listed in `stores()`. The rest of each
 * record is stored but not indexed. Never edit a past version; add a new one.
 */
import Dexie, { type EntityTable } from "dexie";
import type { RawPlan } from "@/lib/plan/types";

export type ProjectOrigin = "sample" | "upload" | "import";

/** How the user set the real-world size. */
export interface ScaleReference {
  kind: "longest" | "wall";
  /** the wall used, when kind = "wall" */
  wallId?: string;
  /** the real length the user typed, in metres */
  meters: number;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  origin: ProjectOrigin;
  /** bundled sample file name, when origin = "sample" */
  sampleId?: string;
  /** the plan as received; normalised at read time (normalisation is idempotent) */
  plan: RawPlan;
  /** ink line drawing for the library card */
  thumbnailSvg: string;
  /** the uploaded image, when there was one */
  sourceImage?: Blob;
  /** plan px per real metre */
  ppm: number;
  scaleReference?: ScaleReference;
  wallHeightM: number;
  /** produced by Demo mode rather than real analysis */
  demo?: boolean;
}

/** Small key/value table for app bookkeeping (e.g. "samples seeded"). */
export interface MetaEntry {
  key: string;
  value: unknown;
}

export class PlanLiftDb extends Dexie {
  projects!: EntityTable<Project, "id">;
  meta!: EntityTable<MetaEntry, "key">;

  constructor(name = "planliftar") {
    super(name);
    this.version(1).stores({
      projects: "id, updatedAt, createdAt, name",
      meta: "key",
    });
  }
}

export const db = new PlanLiftDb();
