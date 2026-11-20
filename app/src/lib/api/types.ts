/**
 * Types for the HTTP API in docs/API.md, plus the client interface both the real
 * HTTP client and the demo fake implement. Features only ever see `PlanApi`, so
 * switching to demo mode needs no changes in any page.
 */
import type { RawPlan } from "@/lib/plan/types";

export interface Health {
  ok: boolean;
  device: "cuda" | "cpu";
  engine_version: string;
  models: { mitunet: boolean; cubicasa: boolean };
}

export type JobStatus = "queued" | "running" | "done" | "error";

export interface Job {
  id: string;
  status: JobStatus;
  /** Human-readable; shown verbatim. */
  stage: string;
  /** 0..1 */
  progress: number;
  error?: string;
  result?: RawPlan;
}

export interface JobOptions {
  use_cubicasa?: boolean;
}

export interface PlanApi {
  /** "demo" or "server", for labelling results honestly. */
  readonly kind: "demo" | "server";
  health(): Promise<Health>;
  createJob(image: File, options?: JobOptions): Promise<{ id: string }>;
  getJob(id: string): Promise<Job>;
  /** URL of the optional debug overlay, or null when the client has none. */
  overlayUrl(id: string): string | null;
}

export const isTerminal = (status: JobStatus) => status === "done" || status === "error";

/** Accepted upload types and size (docs/API.md). */
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Client-side check before upload. Returns a problem message or null. */
export function checkImageFile(file: File): string | null {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return `"${file.name}" is not a PNG, JPEG or WebP image.`;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return `"${file.name}" is ${mb} MB. The limit is 15 MB; export a smaller image and try again.`;
  }
  return null;
}
