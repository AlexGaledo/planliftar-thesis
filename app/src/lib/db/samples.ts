/**
 * Bundled sample plans (public/samples, copied from deliverables/livemap/plans).
 *
 * On first launch they are added to the library so a new user has something to
 * open, view in 3D and walk in AR straight away, offline included (the service
 * worker precaches /samples/*.json). Seeding runs once: a `meta` flag remembers
 * it, so samples the user deletes stay deleted. Settings has "Restore samples".
 */
import { db } from "./db";
import { createProject } from "./projects";
import type { RawPlan } from "@/lib/plan/types";

export interface SampleInfo {
  id: string;
  name: string;
  description: string;
}

/** Order = library order. Names describe what the user will see, not file names. */
export const SAMPLES: SampleInfo[] = [
  { id: "newri-reference", name: "Two-bedroom flat", description: "Reference plan with doors and windows; true size is stated in the file (6.0 × 7.7 m)." },
  { id: "bungalow", name: "Bungalow", description: "Hand-drawn ground truth with five rooms. Good for checking scale." },
  { id: "cubicasa", name: "Large house (AI output)", description: "Real output of the rooms-first pipeline: 244 wall runs, 14 regions." },
  { id: "newri-mitunet-geometry", name: "Flat, walls only (line-first)", description: "Older line-based detector. Shows why gap closure exists." },
];

const SEEDED_KEY = "samplesSeeded";

export async function fetchSample(id: string): Promise<RawPlan> {
  const res = await fetch(`/samples/${encodeURIComponent(id)}.json`);
  if (!res.ok) throw new Error(`Sample "${id}" could not be loaded (HTTP ${res.status}).`);
  return (await res.json()) as RawPlan;
}

/** Add the samples to the library. Returns how many were added. */
export async function addSamples(): Promise<number> {
  let added = 0;
  const start = Date.now();
  // Reverse so the first sample gets the newest timestamp (top of the library).
  for (const sample of [...SAMPLES].reverse()) {
    const plan = await fetchSample(sample.id);
    await createProject({ name: sample.name, plan, origin: "sample", sampleId: sample.id, now: start + added });
    added++;
  }
  return added;
}

/**
 * Seed once per device. Safe to call on every launch and from React StrictMode's
 * double effects: the in-flight promise is shared.
 */
let seeding: Promise<void> | null = null;
export function seedSamplesOnce(): Promise<void> {
  seeding ??= (async () => {
    const flag = await db.meta.get(SEEDED_KEY);
    if (flag?.value) return;
    await db.meta.put({ key: SEEDED_KEY, value: true });
    try {
      await addSamples();
    } catch (e) {
      // Let a later launch try again rather than leaving an empty library forever.
      await db.meta.delete(SEEDED_KEY);
      throw e;
    }
  })().finally(() => {
    seeding = null;
  });
  return seeding;
}
