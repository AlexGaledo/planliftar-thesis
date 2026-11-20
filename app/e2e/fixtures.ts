/**
 * Shared Playwright fixtures for the e2e specs.
 *
 * Every test collects uncaught page errors and console errors. Uncaught page
 * errors always fail the test; console errors fail it unless the test expects
 * them (`allowConsole`), e.g. the 400 a corrupt upload is supposed to cause.
 */
import { test as base, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SAMPLE_PATH = fileURLToPath(new URL("../../backend/samples/cubicasa_10052_F1_original.png", import.meta.url));
export const SAMPLE_PNG = readFileSync(SAMPLE_PATH);

interface Diagnostics {
  pageErrors: string[];
  consoleErrors: string[];
  /** substrings of console errors this test expects */
  allowConsole: (...patterns: string[]) => void;
}

export const test = base.extend<{ diag: Diagnostics }>({
  diag: [
    async ({ page }, use) => {
      const allowed: string[] = [];
      const d: Diagnostics = {
        pageErrors: [],
        consoleErrors: [],
        allowConsole: (...p) => allowed.push(...p),
      };
      page.on("pageerror", (e) => d.pageErrors.push(String(e)));
      page.on("console", (m) => {
        if (m.type() === "error") d.consoleErrors.push(m.text());
      });
      await use(d);
      expect(d.pageErrors, "uncaught page errors").toEqual([]);
      const unexpected = d.consoleErrors.filter((t) => !allowed.some((a) => t.includes(a)));
      expect(unexpected, "console errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Wait until the server reports its models loaded (first start can take a minute). */
export async function waitForModels(page: Page, timeoutMs = 180_000): Promise<{ device: string }> {
  const t0 = Date.now();
  for (;;) {
    const res = await page.request.get("/api/health");
    const h = (await res.json()) as { ok: boolean; loading?: boolean; device: string; models: { mitunet: boolean; cubicasa: boolean } };
    if (h.models.mitunet && h.models.cubicasa && !h.loading) return h;
    if (Date.now() - t0 > timeoutMs) throw new Error(`models not loaded: ${JSON.stringify(h)}`);
    await page.waitForTimeout(1000);
  }
}

/** Open the library (seeds the bundled examples on first visit) and open the named project. */
export async function openSample(page: Page, name = "Two-bedroom flat"): Promise<string> {
  await page.goto("/");
  const link = page.getByRole("link", { name: `Open ${name}` });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  return page.url().split("/projects/")[1];
}
