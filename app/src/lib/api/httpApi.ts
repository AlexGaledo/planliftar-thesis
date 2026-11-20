/**
 * The real API client: fetch() calls against the server in docs/API.md.
 *
 * Every failure becomes an ApiError whose message tells the user what to do,
 * because "TypeError: Failed to fetch" helps nobody at a demo.
 */
import { apiBase } from "./urls";
import type { Health, Job, JobOptions, PlanApi } from "./types";

export class ApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** How long a request may hang before we call the server unreachable. */
const REQUEST_TIMEOUT_MS = 20_000;
/** Uploads of 15 MB over hotel Wi-Fi need longer. */
const UPLOAD_TIMEOUT_MS = 120_000;

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; detail?: string };
    return body.error || body.detail || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export function createHttpApi(serverUrl: string): PlanApi {
  const base = apiBase(serverUrl);
  const where = serverUrl || "this site's /api";

  async function request(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      throw new ApiError(
        aborted
          ? `The server at ${where} did not answer in time. Check it is running.`
          : `Cannot reach the server at ${where}. Check the address in Settings, or turn on Demo mode.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kind: "server",

    async health() {
      const res = await request("/health");
      if (!res.ok) throw new ApiError(await readError(res), res.status);
      return (await res.json()) as Health;
    },

    async createJob(image: File, options?: JobOptions) {
      const form = new FormData();
      form.append("image", image, image.name);
      if (options) form.append("options", JSON.stringify(options));
      const res = await request("/jobs", { method: "POST", body: form }, UPLOAD_TIMEOUT_MS);
      if (res.status === 413) throw new ApiError("That image is too large for the server (15 MB limit).", 413);
      if (res.status === 415) throw new ApiError("The server only accepts PNG, JPEG or WebP images.", 415);
      if (res.status !== 202 && !res.ok) throw new ApiError(await readError(res), res.status);
      const body = (await res.json()) as { id?: string; job_id?: string };
      const id = body.id ?? body.job_id;
      if (!id) throw new ApiError("The server accepted the upload but returned no job id.");
      return { id };
    },

    async getJob(id: string) {
      const res = await request(`/jobs/${encodeURIComponent(id)}`);
      if (res.status === 404) throw new ApiError("This analysis is no longer on the server. Upload the plan again.", 404);
      if (!res.ok) throw new ApiError(await readError(res), res.status);
      return (await res.json()) as Job;
    },

    overlayUrl(id: string) {
      return `${base}/jobs/${encodeURIComponent(id)}/overlay.png`;
    },
  };
}
