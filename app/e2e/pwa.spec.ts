/** Install readiness and offline use of the shell and the library. */
import { expect, test } from "./fixtures";

test("install readiness: manifest and service worker", async ({ page }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBeTruthy();
  const res = await page.request.get(new URL(href!, page.url()).toString());
  expect(res.ok()).toBe(true);
  const m = (await res.json()) as {
    name: string;
    start_url: string;
    display: string;
    icons: { sizes: string; purpose?: string }[];
  };
  expect(m.name).toBeTruthy();
  expect(m.start_url).toBeTruthy();
  expect(["standalone", "fullscreen", "minimal-ui"]).toContain(m.display);
  expect(m.icons.some((i) => i.sizes.includes("192x192"))).toBe(true);
  expect(m.icons.some((i) => i.sizes.includes("512x512"))).toBe(true);

  const scope = await page.evaluate(async () => {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
    ]);
    return reg ? reg.scope : null;
  });
  expect(scope).toBe(new URL("/", page.url()).toString());
});

test("offline reload keeps the shell and the library", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Open Two-bedroom flat" })).toBeVisible();
  // Wait for the service worker to take control and finish precaching.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Two-bedroom flat" })).toBeVisible();
    // A project page, its drawing and the lazy 3D chunk also work offline.
    await page.getByRole("link", { name: "Open Two-bedroom flat" }).click();
    await expect(page.getByRole("heading", { name: "Two-bedroom flat", level: 1 })).toBeVisible();
    await page.goto("/learn");
    await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
