/** "How it works" charts and the Settings page. */
import vizData from "../src/content/model_viz_data.json" with { type: "json" };
import { expect, test } from "./fixtures";

test("How it works renders every chart", async ({ page }) => {
  await page.goto("/learn");
  await expect(page.getByRole("heading", { name: "How it works", level: 1 })).toBeVisible();
  const figures = page.locator("#results figure");
  await figures.first().scrollIntoViewIfNeeded();
  const n = await figures.count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual((vizData as { charts: unknown[] }).charts.length);
  for (let i = 0; i < n; i++) {
    const f = figures.nth(i);
    await f.scrollIntoViewIfNeeded();
    // "table" charts (e.g. glb_output_size) render an open data table instead
    // of an SVG. (Every chart also has a collapsed "Show the numbers" table.)
    await expect.poll(() => f.locator(".recharts-wrapper, table").count()).toBeGreaterThan(0);
    if ((await f.locator(".recharts-wrapper").count()) === 0) {
      await expect(f.locator("table tbody tr").first()).toBeVisible();
      continue;
    }
    // Recharts draws an <svg class="recharts-surface"> with real marks once it has a size.
    const surface = f.locator(".recharts-wrapper > svg.recharts-surface");
    await expect(surface).toBeVisible();
    await expect
      .poll(() => surface.locator(".recharts-cartesian-grid, .recharts-line, .recharts-bar, .recharts-scatter, .recharts-area").count())
      .toBeGreaterThan(0);
    // No chart may be empty: it must draw at least one data mark.
    await expect
      .poll(() => surface.locator(".recharts-line-curve, .recharts-rectangle, .recharts-scatter-symbol, .recharts-area-area, .recharts-dot").count())
      .toBeGreaterThan(0);
  }
  // Diagrams on the same page.
  await expect(page.getByRole("heading", { name: "The pipeline" })).toBeVisible();
});

test("settings: real backend mode, connection test, units persist", async ({ page }) => {
  await page.goto("/settings");
  const demo = page.getByRole("checkbox", { name: /Demo mode/ });
  await expect(demo).not.toBeChecked();
  await page.getByRole("button", { name: /Test connection/i }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected. Engine" })).toContainText("on GPU", { timeout: 15_000 });

  const feet = page.getByRole("button", { name: "Feet", exact: true });
  const metres = page.getByRole("button", { name: "Metres", exact: true });
  await feet.click();
  await page.reload();
  await expect(feet).toHaveAttribute("aria-pressed", "true");
  await metres.click();
  await expect(feet).toHaveAttribute("aria-pressed", "false");
});
