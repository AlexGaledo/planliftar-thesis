/**
 * Real analysis through the UI: upload the CubiCasa sample, watch the progress
 * reach done, check the overlay lines up with the image, set the scale and
 * check it survives a reload. Needs the real backend with models loaded.
 *
 * The full preset (MitUNet + CubiCasa, ~45-65 s) runs in the phone project and
 * the fast preset (MitUNet only, ~4 s) in the desktop project, so each GPU job
 * runs once per suite.
 */
import type { Page } from "@playwright/test";
import { expect, SAMPLE_PATH, test, waitForModels } from "./fixtures";

interface RunResult {
  jobId: string;
  projectId: string;
  progress: number[];
  seconds: number;
}

async function uploadAndWait(page: Page, opts: { name: string; full: boolean; file?: { name: string; mimeType: string; buffer: Buffer } }): Promise<RunResult> {
  await page.goto("/new");
  await page.locator("#image-input").setInputFiles(opts.file ?? SAMPLE_PATH);
  await page.getByLabel("Project name").fill(opts.name);
  const check = page.getByRole("checkbox", { name: /second AI model/ });
  if ((await check.isChecked()) !== opts.full) await check.click();
  const t0 = Date.now();
  await page.getByRole("button", { name: "Analyse plan" }).click();
  await expect(page).toHaveURL(/\/new\/job\//);
  const jobId = decodeURIComponent(page.url().split("/new/job/")[1]);

  const progress: number[] = [];
  const bar = page.getByRole("progressbar", { name: "Analysis progress" });
  while (!/\/projects\//.test(page.url())) {
    const v = await bar.getAttribute("aria-valuenow", { timeout: 1000 }).catch(() => null);
    if (v !== null && Number(v) !== progress.at(-1)) progress.push(Number(v));
    await expect(page.getByRole("alert")).toHaveCount(0);
    // 77 s on an idle laptop; 340 s seen while other work shared the CPU (post-processing is CPU-bound).
    if (Date.now() - t0 > 420_000) throw new Error(`job ${jobId} did not finish; progress ${progress}`);
    await page.waitForTimeout(250);
  }
  const seconds = (Date.now() - t0) / 1000;
  const projectId = page.url().split("/projects/")[1];
  return { jobId, projectId, progress, seconds };
}

/** Bounding box of the wall layer in drawing px, plus the SVG's viewBox and plan->image factor. */
async function overlayGeometry(page: Page) {
  const svg = page.getByRole("img", { name: /^Extracted plan/ });
  await expect(svg).toHaveAttribute("aria-label", /drawn over the source image/);
  return svg.evaluate((el) => {
    const g = el.querySelector("g[transform]") as SVGGElement;
    const lines = [...g.querySelectorAll("line")];
    const xs = lines.flatMap((l) => [l.x1.baseVal.value, l.x2.baseVal.value]);
    const ys = lines.flatMap((l) => [l.y1.baseVal.value, l.y2.baseVal.value]);
    const img = el.querySelector("image") as SVGImageElement;
    return {
      viewBox: el.getAttribute("viewBox"),
      transform: g.getAttribute("transform"),
      image: { w: img.width.baseVal.value, h: img.height.baseVal.value },
      bbox: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
      walls: lines.length,
    };
  });
}

test.describe("upload with the real backend", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(540_000);
    await waitForModels(page);
  });

  test("full preset: progress, overlay alignment, scale, library persistence", async ({ page }, info) => {
    test.skip(info.project.name !== "phone", "the full GPU job runs once, in the phone project");
    const run = await uploadAndWait(page, { name: "E2E full", full: true });
    info.annotations.push({ type: "timing", description: `full preset: ${run.seconds.toFixed(1)} s, progress ${run.progress.join(",")}` });
    expect(run.progress.length).toBeGreaterThan(2);
    expect([...run.progress].sort((a, b) => a - b)).toEqual(run.progress); // monotonic

    const job = await (await page.request.get(`/api/jobs/${run.jobId}`)).json();
    expect(job.status).toBe("done");
    expect(job.result.engine.mode).toBe("mitunet+cubicasa");
    expect(job.result.acceptance.accepted).toBe(true);
    const ov = await page.request.get(`/api/jobs/${run.jobId}/overlay.png`);
    expect(ov.headers()["content-type"]).toBe("image/png");

    // Overlay alignment: the drawing space is the image's own pixels and plan px map 1:1.
    const geo = await overlayGeometry(page);
    expect(geo.viewBox).toBe("0 0 2730 2048");
    expect(geo.transform).toBe("scale(1)");
    expect(geo.image).toEqual({ w: 2730, h: 2048 });
    expect(geo.walls).toBeGreaterThanOrEqual(job.result.walls.length);
    expect(geo.bbox.minX).toBeGreaterThanOrEqual(0);
    expect(geo.bbox.minY).toBeGreaterThanOrEqual(0);
    expect(geo.bbox.maxX).toBeLessThanOrEqual(2730);
    expect(geo.bbox.maxY).toBeLessThanOrEqual(2048);
    expect(geo.bbox.maxX - geo.bbox.minX).toBeGreaterThan(2730 * 0.5);

    // Set the scale, then reload: it must persist (IndexedDB).
    await page.getByRole("button", { name: "Building length" }).click();
    await page.locator("#real-length").fill("21.5");
    await page.locator("#wall-height").fill("2.7");
    await page.getByRole("button", { name: "Save size" }).click();
    await expect(page.getByRole("status").filter({ hasText: /./ }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText("(estimated, not yet measured)")).toHaveCount(0);
    await expect(page.locator("#real-length")).toHaveValue(/21\.5/);
    await expect(page.locator("#wall-height")).toHaveValue(/2\.7/);

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Open E2E full" })).toBeVisible();
  });

  test("fast preset reaches done and saves to the library", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the fast GPU job runs once, in the desktop project");
    const run = await uploadAndWait(page, { name: "E2E fast", full: false });
    info.annotations.push({ type: "timing", description: `fast preset: ${run.seconds.toFixed(1)} s, progress ${run.progress.join(",")}` });
    const job = await (await page.request.get(`/api/jobs/${run.jobId}`)).json();
    expect(job.result.engine.mode).toBe("mitunet_only");
    const geo = await overlayGeometry(page);
    expect(geo.viewBox).toBe("0 0 2730 2048");
    expect(geo.transform).toBe("scale(1)");
    await page.reload();
    await expect(page.getByRole("heading", { name: "E2E fast", level: 1 })).toBeVisible();
  });

  test("an image over 4096 px comes back in full-image coordinates", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "GPU job, desktop project only");
    await page.goto("/");
    // Upscale the sample 2.2x in the browser: 6006 x 4506 px, analysed at 4096 px.
    const b64 = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * 2.2);
      c.height = Math.round(img.height * 2.2);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, `data:image/png;base64,${(await import("node:fs")).readFileSync(SAMPLE_PATH).toString("base64")}`);
    const buffer = Buffer.from(b64, "base64");
    const run = await uploadAndWait(page, { name: "E2E upscaled", full: false, file: { name: "upscaled.png", mimeType: "image/png", buffer } });
    info.annotations.push({ type: "timing", description: `upscaled fast: ${run.seconds.toFixed(1)} s, ${(buffer.length / 1e6).toFixed(1)} MB` });
    const job = await (await page.request.get(`/api/jobs/${run.jobId}`)).json();
    expect(job.result.source.image_width_px).toBe(6006);
    expect(job.result.source.input_scale).toBeLessThan(1);
    const geo = await overlayGeometry(page);
    expect(geo.viewBox).toBe("0 0 6006 4506");
    expect(geo.transform).toBe("scale(1)");
    // Walls span the full image, not the 4096 px analysis frame.
    expect(geo.bbox.maxX).toBeGreaterThan(4096 * 1.1);
    expect(geo.bbox.maxX).toBeLessThanOrEqual(6006);
  });
});
