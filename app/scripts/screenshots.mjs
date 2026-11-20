/**
 * Screenshots of every route, one page at a time, plus a console-error check
 * and Chrome's own PWA installability check.
 *
 * Usage (against a running preview server, which you stop afterwards):
 *   pnpm build && pnpm preview --port 4173 &
 *   node scripts/screenshots.mjs [baseUrl] [outDir]
 *
 * Uses playwright-core with the locally installed Chrome (no browser download).
 * Set CHROME_PATH if Chrome lives elsewhere. Pages run sequentially on purpose:
 * one tab at a time keeps memory use low.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:4173";
const OUT = process.argv[3] ?? "screenshots";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: "desktop", width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
];

/** Console noise that is expected in a headless run, not an app bug. */
const IGNORED = [/WebSocket connection to .* failed/i, /GPU stall/i, /WebGL/i, /Automatic fallback to software WebGL/i];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const problems = [];

try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor });
    // Demo mode so the upload flow works without the analysis server.
    await context.addInitScript(() => {
      if (!localStorage.getItem("planliftar.settings")) {
        localStorage.setItem("planliftar.settings", JSON.stringify({ state: { demoMode: true, installDismissed: true }, version: 1 }));
      }
    });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (!IGNORED.some((re) => re.test(text))) problems.push(`[${vp.name}] ${page.url()}: ${text}`);
    });
    page.on("pageerror", (err) => problems.push(`[${vp.name}] ${page.url()}: ${err.message}`));

    const shot = async (name, path, wait = 800, fullPage = false) => {
      await page.goto(BASE + path, { waitUntil: "networkidle" });
      await page.waitForTimeout(wait);
      await page.screenshot({ path: join(OUT, `${vp.name}-${name}.png`), fullPage });
      console.log(`  ${vp.name} ${name}`);
    };

    await shot("projects", "/", 1500);
    const href = await page.locator('a[href^="/projects/"]').first().getAttribute("href");
    const projectPath = href ?? "/";
    await shot("new", "/new", 800, true);
    await shot("plan", projectPath, 1200, true);
    await shot("viewer-3d", `${projectPath}/3d`, 2500);
    await shot("live-map", `${projectPath}/map`, 1200);
    await shot("ar-fallback", `${projectPath}/ar`, 3000);
    await shot("ar-test-walk", `${projectPath}/ar?fake=1`, 1200);
    await shot("learn", "/learn", 1500, true);
    await shot("settings", "/settings", 800, true);
    await shot("not-found", "/nope");

    // Demo upload: pick a sample image, analyse, land on the saved plan.
    await page.goto(BASE + "/new", { waitUntil: "networkidle" });
    await page.setInputFiles("#image-input", "public/icons/icon-512.png");
    await page.getByRole("button", { name: "Analyse plan" }).click();
    await page.waitForURL(/\/new\/job\//);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, `${vp.name}-job-progress.png`) });
    await page.waitForURL(/\/projects\/[^/]+$/, { timeout: 20_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, `${vp.name}-demo-result.png`) });
    console.log(`  ${vp.name} demo upload flow`);

    await context.close();
  }
} finally {
  await browser.close();
}

// Installability: Chrome never offers install in incognito, and every
// newContext() is incognito, so this check uses a throwaway persistent profile.
const profile = await mkdtemp(join(tmpdir(), "planliftar-pwa-"));
const persistent = await chromium.launchPersistentContext(profile, { executablePath: CHROME, headless: true });
try {
  const page = persistent.pages()[0] ?? (await persistent.newPage());
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const cdp = await persistent.newCDPSession(page);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  if (installabilityErrors.length) problems.push(`installability: ${JSON.stringify(installabilityErrors)}`);
  else console.log("  installable: yes (Chrome reports no installability errors)");
} finally {
  await persistent.close();
  await rm(profile, { recursive: true, force: true });
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n` + problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log("\nNo console errors.");
}
