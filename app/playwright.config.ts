/**
 * End-to-end tests against the REAL backend (docs/audit/E2E_REPORT.md).
 *
 *   pnpm build                          # app/dist, served by the backend
 *   python ../backend/run_server.py     # http://127.0.0.1:8000, real models (GPU)
 *   pnpm e2e                            # E2E_BASE_URL overrides the address
 *
 * One worker on purpose: the server runs one GPU job at a time and the dev
 * laptop has 16 GB of RAM. Each spec runs twice, as a phone (Pixel 7, touch)
 * and as a 1440x900 desktop; a few GPU-heavy tests run in one project only.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["json", { outputFile: "e2e-results/results.json" }]],
  outputDir: "e2e-results/artifacts",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8000",
    headless: true,
    trace: "retain-on-failure",
    launchOptions: { args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] },
  },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"], browserName: "chromium" } },
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
  ],
});
