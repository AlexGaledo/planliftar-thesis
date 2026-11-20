/** 3D viewer, GLB export and the AR route (fallback + scripted test walk). */
import { readFileSync } from "node:fs";
import { expect, openSample, test } from "./fixtures";

test("3D viewer renders a WebGL canvas and exports a GLB", async ({ page, diag }) => {
  const id = await openSample(page);
  await page.goto(`/projects/${id}/3d`);
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  const ctx = await canvas.evaluate((c: HTMLCanvasElement) => {
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    return gl ? { ok: true, lost: gl.isContextLost(), w: c.width, h: c.height } : { ok: false };
  });
  expect(ctx).toMatchObject({ ok: true, lost: false });
  expect(diag.consoleErrors.filter((t) => /webgl|THREE/i.test(t))).toEqual([]);

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export GLB" }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.glb$/);
  const bytes = readFileSync(await download.path());
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("glTF");
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
});

test("AR without WebXR shows the fallback with a server-hosted GLB", async ({ page }, info) => {
  const id = await openSample(page);
  const uploaded = page.waitForResponse((r) => r.url().endsWith("/api/models") && r.request().method() === "POST");
  await page.goto(`/projects/${id}/ar`);
  const heading = info.project.name === "phone" ? "View it in your room" : "AR needs a phone";
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 20_000 });
  expect((await uploaded).status()).toBe(201);
  const mv = page.locator("model-viewer");
  await expect(mv).toHaveAttribute("src", /^http:\/\/127\.0\.0\.1:8000\/api\/models\/[\w-]+\.glb$/);
  const src = (await mv.getAttribute("src"))!;
  const glb = await page.request.get(src);
  expect(glb.headers()["content-type"]).toBe("model/gltf-binary");
  expect((await glb.body()).subarray(0, 4).toString("latin1")).toBe("glTF");
  // The download fallback is still offered.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download model (.glb)" }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.glb$/);
});

test("AR ?fake=1 runs the scripted walk and streams poses", async ({ page }) => {
  const id = await openSample(page);
  await page.goto(`/projects/${id}/ar?fake=1`);
  await expect(page.getByText(/\(\d+ sent\)/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/\(([1-9]\d*) sent\)/)).toBeVisible({ timeout: 10_000 });
});
