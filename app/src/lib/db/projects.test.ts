import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSample } from "@/test/samples";
import { db } from "./db";
import { clearAllData, createProject, deleteProject, listProjects, renameProject, setProjectScale } from "./projects";
import { SAMPLES, seedSamplesOnce } from "./samples";

beforeEach(async () => {
  await clearAllData();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const name = String(url).split("/").pop()!.replace(".json", "");
    return new Response(JSON.stringify(loadSample(name)));
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("project repository", () => {
  it("creates a project with thumbnail and initial scale", async () => {
    const p = await createProject({ name: "  Flat ", plan: loadSample("newri-reference"), origin: "import" });
    expect(p.name).toBe("Flat");
    expect(p.thumbnailSvg).toContain("<svg");
    expect(p.ppm).toBeCloseTo(100);
    expect(await db.projects.count()).toBe(1);
  });

  it("renames, rescales and deletes", async () => {
    const p = await createProject({ name: "A", plan: loadSample("bungalow"), origin: "import" });
    await renameProject(p.id, "B");
    await setProjectScale(p.id, 80, { kind: "longest", meters: 15 });
    const [saved] = await listProjects();
    expect(saved.name).toBe("B");
    expect(saved.ppm).toBe(80);
    await expect(renameProject(p.id, "  ")).rejects.toThrow(/needs a name/);
    await expect(setProjectScale(p.id, 0)).rejects.toThrow();
    await deleteProject(p.id);
    expect(await db.projects.count()).toBe(0);
  });

  it("seeds the samples exactly once", async () => {
    await Promise.all([seedSamplesOnce(), seedSamplesOnce()]);
    expect(await db.projects.count()).toBe(SAMPLES.length);
    const [first] = await listProjects();
    expect(first.name).toBe(SAMPLES[0].name);
    // Deleted samples stay deleted.
    await deleteProject(first.id);
    await seedSamplesOnce();
    expect(await db.projects.count()).toBe(SAMPLES.length - 1);
  });
});
