/**
 * Live map across two browsers: a phone context runs the AR test walk
 * (?fake=1), which shares its plan and streams poses through the server's /ws
 * hub; a separate viewer context (its own, different library) follows it.
 */
import { devices, type Page } from "@playwright/test";
import { expect, openSample, test } from "./fixtures";

/** Green "live" pixels on the map canvas (the dot, its cone and trail). */
async function livePixels(page: Page): Promise<number> {
  return page.locator("canvas").first().evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext("2d");
    if (!ctx) return -1;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 1] > d[i] + 50 && d[i + 1] > d[i + 2] + 25 && d[i + 3] > 0) n++;
    return n;
  });
}

test("viewer auto-loads the phone's shared plan and shows the live dot", async ({ browser, page }, info) => {
  test.skip(info.project.name !== "desktop", "two-context test; the viewer is the laptop");
  // The hub accepts one plan update per 2 s per address; earlier specs opened AR too.
  await page.waitForTimeout(2100);
  const phoneCtx = await browser.newContext({ ...devices["Pixel 7"] });
  const phone = await phoneCtx.newPage();
  const phoneErrors: string[] = [];
  phone.on("pageerror", (e) => phoneErrors.push(String(e)));
  try {
    const phoneProjectId = await openSample(phone, "Bungalow");
    await phone.goto(`/projects/${phoneProjectId}/ar?fake=1`);
    await expect(phone.getByText(/\(([1-9]\d*) sent\)/)).toBeVisible({ timeout: 15_000 });

    // The viewer never had this project: /map gets the plan from the hub.
    await page.goto("/map");
    const header = page.getByTestId("shared-plan");
    await expect(header).toContainText("Bungalow");
    await expect(header).toContainText("shared from the phone");
    await expect(page.getByRole("status").filter({ hasText: "Phone live" })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => livePixels(page), { timeout: 10_000 }).toBeGreaterThan(20);

    // The control panel shows the phone's reported state (xr "fake").
    await expect(page.getByText(/fake|test walk/i).first()).toBeVisible();

    // Save it to this device's library; it keeps the phone's project id.
    await page.getByRole("button", { name: "Save to library" }).click();
    await page.getByRole("link", { name: "Saved. Open it" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${phoneProjectId}$`));
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Open Bungalow" })).toHaveCount(2); // seeded example + saved copy

    // A project map for a different plan says the phone has another plan open.
    await openSample(page, "Two-bedroom flat");
    await page.goto(page.url() + "/map");
    await expect(page.getByTestId("other-plan")).toContainText("Bungalow");
  } finally {
    await phoneCtx.close();
  }
  expect(phoneErrors).toEqual([]);
});
