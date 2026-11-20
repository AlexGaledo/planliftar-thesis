import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSample } from "@/test/samples";
import { DEMO_DURATION_MS, createDemoApi, demoJobStateAt } from "./demoApi";
import { createHttpApi } from "./httpApi";
import { checkImageFile } from "./types";
import { apiBase, hubUrl, mixedContentProblem, normalizeServerUrl } from "./urls";

const page = {
  protocol: "https:",
  host: "planliftar.vercel.app",
  hostname: "planliftar.vercel.app",
  origin: "https://planliftar.vercel.app",
};

describe("urls", () => {
  it("defaults to same-origin /api and /ws", () => {
    expect(apiBase("")).toBe("/api");
    expect(hubUrl({ serverUrl: "", hubMode: "auto", hubUrl: "" }, page)).toBe("wss://planliftar.vercel.app/ws");
  });

  it("targets a LAN laptop server", () => {
    const serverUrl = "https://192.168.1.42:8443/";
    expect(apiBase(serverUrl)).toBe("https://192.168.1.42:8443/api");
    expect(hubUrl({ serverUrl, hubMode: "auto", hubUrl: "" }, page)).toBe("wss://192.168.1.42:8443/ws");
    expect(hubUrl({ serverUrl, hubMode: "legacy", hubUrl: "" }, page)).toBe("wss://192.168.1.42:8765");
  });

  it("uses a custom hub URL verbatim", () => {
    expect(hubUrl({ serverUrl: "", hubMode: "custom", hubUrl: " ws://10.0.0.2:9000 " }, page)).toBe("ws://10.0.0.2:9000");
  });

  it("adds https:// when the scheme is missing", () => {
    expect(normalizeServerUrl("192.168.1.5:8443")).toBe("https://192.168.1.5:8443");
  });

  it("flags http servers from an https page", () => {
    expect(mixedContentProblem("http://192.168.1.5:8000", page)).toMatch(/blocks/);
    expect(mixedContentProblem("https://192.168.1.5:8443", page)).toBeNull();
  });
});

describe("checkImageFile", () => {
  it("accepts png/jpeg/webp up to 15 MB", () => {
    expect(checkImageFile(new File(["x"], "a.png", { type: "image/png" }))).toBeNull();
    expect(checkImageFile(new File(["x"], "a.gif", { type: "image/gif" }))).toMatch(/not a PNG/);
    const big = new File(["x"], "big.jpg", { type: "image/jpeg" });
    Object.defineProperty(big, "size", { value: 16 * 1024 * 1024 });
    expect(checkImageFile(big)).toMatch(/limit is 15 MB/);
  });
});

describe("demo API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("walks queued -> running -> done with monotonic progress", () => {
    const states = [0, 1000, 3000, 5900, DEMO_DURATION_MS].map(demoJobStateAt);
    expect(states[0].status).toBe("queued");
    expect(states[2].status).toBe("running");
    expect(states[4]).toEqual({ status: "done", stage: "Done", progress: 1 });
    const progress = states.map((s) => s.progress);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it("returns a labelled sample plan when done", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(loadSample("newri-reference")))));
    let t = 0;
    const api = createDemoApi(() => t);
    const { id } = await api.createJob(new File(["x"], "my-house.png", { type: "image/png" }));
    expect((await api.getJob(id)).status).toBe("queued");
    t = DEMO_DURATION_MS + 1;
    const job = await api.getJob(id);
    expect(job.status).toBe("done");
    expect(job.result?.walls.length).toBe(9);
    expect(job.result?.demo).toBe(true);
    expect(api.overlayUrl(id)).toBeNull();
  });

  it("explains a lost job", async () => {
    await expect(createDemoApi().getJob("nope")).rejects.toThrow(/Upload the plan again/);
  });
});

describe("HTTP API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts multipart to /api/jobs and reads the id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "j1" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createHttpApi("");
    const res = await api.createJob(new File(["x"], "a.png", { type: "image/png" }), { use_cubicasa: true });
    expect(res).toEqual({ id: "j1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/jobs");
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("options")).toBe('{"use_cubicasa":true}');
    expect(body.get("image")).toBeInstanceOf(File);
  });

  it("turns network failures into an actionable message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(createHttpApi("https://10.0.0.9:8443").health()).rejects.toThrow(/Check the address in Settings/);
  });

  it("explains 413 and 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 413 })));
    const api = createHttpApi("");
    await expect(api.createJob(new File(["x"], "a.png", { type: "image/png" }))).rejects.toThrow(/too large/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(api.getJob("x")).rejects.toThrow(/no longer on the server/);
  });
});
