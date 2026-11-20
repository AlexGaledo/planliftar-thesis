/**
 * Project repository: every read/write of projects goes through here, so pages
 * never touch Dexie directly and the rules (thumbnail regeneration, timestamps,
 * id generation) live in one place.
 */
import { initialPpm, planThumbnailSvg, preparePlan, type RawPlan } from "@/lib/plan";
import { db, type Project, type ProjectOrigin, type ScaleReference } from "./db";

/** ar.html's default wall height. */
export const DEFAULT_WALL_HEIGHT_M = 2.5;

function newId(): string {
  // crypto.randomUUID exists in every secure context; fall back for http:// LAN use.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface NewProjectInput {
  name: string;
  plan: RawPlan;
  origin: ProjectOrigin;
  sampleId?: string;
  sourceImage?: Blob;
  demo?: boolean;
  /** timestamp override (seeding gives each sample a distinct, ordered time) */
  now?: number;
}

/** Build a project record (not saved). Throws if the plan cannot be prepared. */
export function makeProject(input: NewProjectInput, now = input.now ?? Date.now()): Project {
  const prepared = preparePlan(input.plan);
  return {
    id: newId(),
    name: input.name.trim() || "Untitled plan",
    createdAt: now,
    updatedAt: now,
    origin: input.origin,
    sampleId: input.sampleId,
    plan: input.plan,
    thumbnailSvg: planThumbnailSvg(prepared),
    sourceImage: input.sourceImage,
    ppm: initialPpm(input.plan),
    wallHeightM: DEFAULT_WALL_HEIGHT_M,
    demo: input.demo,
  };
}

export async function createProject(input: NewProjectInput): Promise<Project> {
  const project = makeProject(input);
  await db.projects.add(project);
  return project;
}

/** What a phone shares over the hub (PROTOCOL.md "Plan"); see lib/hub/protocol.ts. */
export interface SharedPlanInput {
  plan_id: string;
  name: string;
  plan: RawPlan;
  ppm?: number;
  wall_height_m?: number;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A project record for a plan shared by the phone (not saved). It keeps the
 * phone's project id when that id is safe, so the phone's AR link and this
 * device's library agree once saved.
 */
export function sharedPlanProject(shared: SharedPlanInput): Project {
  const p = makeProject({ name: shared.name, plan: shared.plan, origin: "import" });
  if (SAFE_ID.test(shared.plan_id)) p.id = shared.plan_id;
  if (shared.ppm) p.ppm = shared.ppm;
  if (shared.wall_height_m) p.wallHeightM = shared.wall_height_m;
  return p;
}

/** Save a shared plan to this device's library; returns the existing copy if already saved. */
export async function saveSharedPlan(shared: SharedPlanInput): Promise<Project> {
  const project = sharedPlanProject(shared);
  const existing = await db.projects.get(project.id);
  if (existing) return existing;
  await db.projects.add(project);
  return project;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new Error("A project needs a name.");
  await db.projects.update(id, { name: clean, updatedAt: Date.now() });
}

export async function setProjectScale(id: string, ppm: number, reference?: ScaleReference): Promise<void> {
  if (!(ppm > 0) || !Number.isFinite(ppm)) throw new Error("That scale is not a positive number.");
  await db.projects.update(id, { ppm, scaleReference: reference, updatedAt: Date.now() });
}

export async function setWallHeight(id: string, wallHeightM: number): Promise<void> {
  await db.projects.update(id, { wallHeightM, updatedAt: Date.now() });
}

export async function deleteProject(id: string): Promise<void> {
  await db.projects.delete(id);
}

export async function getProject(id: string): Promise<Project | undefined> {
  return db.projects.get(id);
}

/** Newest first. */
export async function listProjects(): Promise<Project[]> {
  return db.projects.orderBy("updatedAt").reverse().toArray();
}

/** Remove every project and bookkeeping entry (Settings > Clear data). */
export async function clearAllData(): Promise<void> {
  await db.transaction("rw", db.projects, db.meta, async () => {
    await db.projects.clear();
    await db.meta.clear();
  });
}
