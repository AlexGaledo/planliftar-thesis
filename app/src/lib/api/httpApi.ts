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

/**
 * A plain-language message for a failed response. The server's own `error` /
 * `detail` text wins (it is written for users); otherwise the status code is
 * explained, never shown bare ("HTTP 500" means nothing to a client).
 */
async function readError(res: Response, where: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; detail?: string };
    if (body.error || body.detail) return (body.error || body.detail) as string;
  } catch {
    // Not JSON: fall through to the status explanation.
  }
  if (res.status >= 500)
    return `The analysis server at ${where} is not responding (error ${res.status}). Check it is running, or turn on Demo mode.`;
  if (res.status === 404 || res.status === 405)
    return `There is no analysis server at ${where}. Check the address in Settings, or turn on Demo mode.`;
  return `The analysis server at ${where} refused the request (error ${res.status}).`;
}

/** Parse a JSON body; an HTML page here means the address is a website, not our API. */
async function readJson<T>(res: Response, where: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(
      `There is no analysis server at ${where}. Check the address in Settings, or turn on Demo mode.`,
      res.status,
    );
  }
}

export function createHttpApi(serverUrl: string): PlanApi {
  const base = apiBase(serverUrl);
  const where = serverUrl || "this site";

  async function request(
    path: string,
    init: RequestInit = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
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
      if (!res.ok) throw new ApiError(await readError(res, where), res.status);
      return readJson<Health>(res, where);
    },

    async createJob(image: File, options?: JobOptions) {
      const form = new FormData();
      form.append("image", image, image.name);
      if (options) form.append("options", JSON.stringify(options));
      const res = await request("/jobs", { method: "POST", body: form }, UPLOAD_TIMEOUT_MS);
      if (res.status === 413)
        throw new ApiError("That image is too large for the server (15 MB limit).", 413);
      if (res.status === 415)
        throw new ApiError("The server only accepts PNG, JPEG or WebP images.", 415);
      if (res.status !== 202 && !res.ok)
        throw new ApiError(await readError(res, where), res.status);
      const body = await readJson<{ id?: string; job_id?: string }>(res, where);
      const id = body.id ?? body.job_id;
      if (!id) throw new ApiError("The server accepted the upload but returned no job id.");
      return { id };
    },

    async getJob(id: string) {
      const res = await request(`/jobs/${encodeURIComponent(id)}`);
      if (res.status === 404)
        throw new ApiError("This analysis is no longer on the server. Upload the plan again.", 404);
      if (!res.ok) throw new ApiError(await readError(res, where), res.status);
      return readJson<Job>(res, where);
    },

    overlayUrl(id: string) {
      return `${base}/jobs/${encodeURIComponent(id)}/overlay.png`;
    },

    async uploadModel(glb: Blob) {
      const res = await request(
        "/models",
        { method: "POST", body: glb, headers: { "Content-Type": "model/gltf-binary" } },
        UPLOAD_TIMEOUT_MS,
      );
      if (!res.ok) throw new ApiError(await readError(res, where), res.status);
      const body = await readJson<{ url?: string }>(res, where);
      if (!body.url || !/^https?:\/\//i.test(body.url))
        throw new ApiError("The server stored the model but returned no usable address.");
      return body.url;
    },
  };
}
