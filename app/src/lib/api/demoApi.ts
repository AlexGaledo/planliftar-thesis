/**
 * Demo mode: an in-browser fake of the API in docs/API.md.
 *
 * Lets the whole app run with no backend, in development and in a deployed
 * demo. A job walks through the same stages the real pipeline reports and then
 * returns a bundled sample plan. The result is labelled as a demo in the UI so
 * nobody mistakes it for an analysis of their picture (the prototype's rule).
 *
 * Jobs live in a module-level Map, so they survive route changes but not a page
 * reload, the same way a real server would lose jobs on restart.
 */
import type { RawPlan } from "@/lib/plan/types";
import type { Health, Job, PlanApi } from "./types";

/** The stages the real pipeline goes through (docs/research/MODEL_EXPLAINED.md §2). */
export const DEMO_STAGES = [
  "Queued",
  "Preparing the image",
  "Finding the walls",
  "Checking the rooms with a second AI model",
  "Tracing rooms and walls",
  "Checking the two models agree",
  "Closing small wall gaps",
  "Done",
] as const;

/** Total simulated run time. */
export const DEMO_DURATION_MS = 6000;
/** The sample a demo job returns. */
export const DEMO_SAMPLE = "newri-reference";

interface DemoJob {
  id: string;
  startedAt: number;
  fileName: string;
}

const jobs = new Map<string, DemoJob>();

async function loadSamplePlan(name: string): Promise<RawPlan> {
  const res = await fetch(`/samples/${name}.json`);
  if (!res.ok) throw new Error(`The demo sample "${name}" is missing (HTTP ${res.status}).`);
  return (await res.json()) as RawPlan;
}

/** Job state at a given elapsed time. Exported for tests. */
export function demoJobStateAt(elapsedMs: number): Pick<Job, "status" | "stage" | "progress"> {
  const progress = Math.min(1, Math.max(0, elapsedMs / DEMO_DURATION_MS));
  if (progress >= 1) return { status: "done", stage: "Done", progress: 1 };
  // Skip the first ("Queued") and last ("Done") stages while running.
  const running = DEMO_STAGES.slice(1, -1);
  const index = Math.min(running.length - 1, Math.floor(progress * running.length));
  return { status: progress < 0.05 ? "queued" : "running", stage: progress < 0.05 ? "Queued" : running[index], progress };
}

export function createDemoApi(now: () => number = () => Date.now()): PlanApi {
  return {
    kind: "demo",

    async health(): Promise<Health> {
      return { ok: true, device: "cpu", engine_version: "demo", models: { mitunet: true, cubicasa: true } };
    },

    async createJob(image: File) {
      const id = `demo-${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      jobs.set(id, { id, startedAt: now(), fileName: image.name });
      return { id };
    },

    async getJob(id: string): Promise<Job> {
      const job = jobs.get(id);
      if (!job) {
        throw new Error("This demo analysis was lost when the page reloaded. Upload the plan again.");
      }
      const state = demoJobStateAt(now() - job.startedAt);
      if (state.status !== "done") return { id, ...state };
      const result = await loadSamplePlan(DEMO_SAMPLE);
      return { id, ...state, result: { ...result, demo: true, demo_source_file: job.fileName } };
    },

    overlayUrl() {
      return null;
    },
  };
}
