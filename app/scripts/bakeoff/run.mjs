/**
 * Texture bake-off harness (docs/research/TEXTURES_ASSETS.md §5).
 *
 *   pnpm bakeoff [theme] [--skip-build]       # theme also via BAKEOFF_THEME
 *
 * For one SurfaceTheme it:
 *  1. builds the app (unless --skip-build) and measures the Workbox precache
 *     from dist/sw.js (metric 3),
 *  2. starts `vite preview` on 127.0.0.1:4173 (and always kills it),
 *  3. opens /bakeoff?plan=<sample>&theme=<theme> for cubicasa, newri-reference
 *     and bungalow, one page at a time, and screenshots the fixed camera poses
 *     (aerial 45 deg, eye level 1.6 m, door/window close-up) (metrics 8, 9),
 *  4. exports the GLB in the page and inspects it: size, materials, alpha
 *     materials, extensions, UV sets, vertex colours, texture bytes and
 *     dimensions, plus the Khronos glTF Validator (metrics 1, 2, 7),
 *  5. measures the mean wall luminance of the eye-level shot (metric 8a),
 *  6. with the service worker allowed: installs it, then (a) reloads each plan
 *     5 times and takes the median first textured frame (metric 11, warm SW),
 *     once in SwiftShader and once with the default (hardware) GPU, and
 *     (b) goes offline and checks cubicasa and bungalow still load every map
 *     and fixture model with the same triangles (metric 4),
 *  7. writes docs/research/bakeoff/<theme>/metrics.json and the PNGs.
 *
 * Not part of `pnpm e2e` (that suite lives in e2e/ and targets the backend).
 * Uses playwright-core with the locally installed Chrome; set CHROME_PATH if it
 * lives elsewhere. Everything runs sequentially to keep memory low.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { validateBytes } from "gltf-validator";

const APP = resolve(fileURLToPath(import.meta.url), "../../..");
const REPO = resolve(APP, "..");
const args = process.argv.slice(2);
const THEME = args.find((a) => !a.startsWith("--")) ?? process.env.BAKEOFF_THEME ?? "home";
const SKIP_BUILD = args.includes("--skip-build");
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const PLANS = ["cubicasa", "newri-reference", "bungalow"];
const OUT = join(REPO, "docs", "research", "bakeoff", THEME);
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const log = (...m) => console.log("[bakeoff]", ...m);
/** The cubicasa-eye wall patch from DECISION.md (metric 8a). */
const WALL_PATCH = [150, 250, 550, 450];
const TIMING_RUNS = 5;
const OFFLINE_PLANS = ["cubicasa", "bungalow"];
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/** Open the bakeoff page and wait until it is ready; returns its stats. */
async function openBakeoff(page, plan) {
  await page.goto(`${BASE}/bakeoff?plan=${plan}&theme=${encodeURIComponent(THEME)}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__bakeoff && (window.__bakeoff.ready || window.__bakeoff.error), null, { timeout: 60_000 });
  const err = await page.evaluate(() => window.__bakeoff.error ?? null);
  if (err) throw new Error(`${plan}: ${err}`);
  return page.evaluate(() => window.__bakeoff.stats());
}

/** A context with the service worker installed and controlling the page. */
async function swContext(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    // wait for the install (precache) to finish
    if (!reg.active || reg.installing || reg.waiting) await new Promise((r) => setTimeout(r, 2000));
  });
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });
  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
    return urls.filter((u) => u.startsWith("/textures/") || u.startsWith("/models/"));
  });
  return { context, page, cached };
}

/** Median first textured frame over TIMING_RUNS warm-SW reloads, per plan. */
async function timing(browser, label) {
  const { context, page } = await swContext(browser);
  const out = { label, plans: {} };
  try {
    for (const plan of PLANS) {
      const runs = [];
      for (let i = 0; i < TIMING_RUNS; i++) {
        const s = await openBakeoff(page, plan);
        runs.push({ firstTexturedFrameMs: s.firstTexturedFrameMs, preloadMs: s.preloadMs, buildMs: s.buildMs });
        out.gpu = s.gpu;
      }
      out.plans[plan] = {
        medianFirstTexturedFrameMs: median(runs.map((r) => r.firstTexturedFrameMs)),
        medianPreloadMs: median(runs.map((r) => r.preloadMs)),
        medianBuildMs: median(runs.map((r) => r.buildMs)),
        runs,
      };
      log(`timing ${label} ${plan}: median first textured frame ${out.plans[plan].medianFirstTexturedFrameMs} ms (${out.gpu})`);
    }
  } finally {
    await context.close();
  }
  return out;
}

/** Metric 4: SW installed, network off, the theme still loads everything. */
async function offline(browser, onlineTriangles) {
  const { context, page, cached } = await swContext(browser);
  const out = { cachedAssets: cached.sort(), plans: {} };
  try {
    await context.setOffline(true);
    for (const plan of OFFLINE_PLANS) {
      const s = await openBakeoff(page, plan);
      const ts = s.themeStats ?? {};
      out.plans[plan] = {
        mapsLoaded: ts.mapsLoaded ?? null,
        mapsFailed: ts.mapsFailed ?? [],
        fixturesFailed: ts.fixturesFailed ?? [],
        triangles: s.triangles,
        sameTrianglesAsOnline: s.triangles === onlineTriangles[plan],
      };
      log(`offline ${plan}: ${JSON.stringify(out.plans[plan])}`);
    }
  } finally {
    await context.close();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build + precache
// ---------------------------------------------------------------------------
function build() {
  log("pnpm build ...");
  const r = spawnSync("pnpm build", { cwd: APP, shell: true, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error("build failed");
  }
  const m = /precache\s+(\d+)\s+entries\s+\(([\d.]+)\s*KiB\)/i.exec(r.stdout);
  return m ? { entries: Number(m[1]), kib: Number(m[2]) } : null;
}

/** Sum the files Workbox precaches, straight from the generated service worker. */
async function precacheFromSw() {
  const dist = join(APP, "dist");
  if (!(await readdir(dist)).includes("sw.js")) return null;
  // generateSW inlines the precache manifest as {url:"...",revision:...} entries.
  const sw = await readFile(join(dist, "sw.js"), "utf-8");
  const urls = [...sw.matchAll(/url:"([^"]+)"/g)].map((m) => m[1]);
  let bytes = 0;
  for (const u of urls) {
    try {
      bytes += (await stat(join(dist, decodeURIComponent(u)))).size;
    } catch {
      /* listed but not on disk: ignore */
    }
  }
  return { entries: urls.length, bytes };
}

// ---------------------------------------------------------------------------
// Preview server
// ---------------------------------------------------------------------------
async function startPreview() {
  const vite = join(APP, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [vite, "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: APP,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(BASE + "/");
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) throw new Error(`vite preview exited:\n${output}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  stopPreview(child);
  throw new Error(`vite preview did not start:\n${output}`);
}

function stopPreview(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

// ---------------------------------------------------------------------------
// GLB inspection
// ---------------------------------------------------------------------------
function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)));
  const binStart = 20 + jsonLen + 8;
  return { json, bin: buf.subarray(binStart) };
}

/** Width/height from a PNG or JPEG header. */
function imageSize(b) {
  if (b[0] === 0x89 && b[1] === 0x50) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + len;
    }
  }
  return null;
}

function inspectGlb(buf) {
  const { json, bin } = parseGlb(buf);
  const materials = json.materials ?? [];
  const images = json.images ?? [];
  let textureBytes = 0;
  let maxTextureDim = 0;
  const imageInfo = images.map((img) => {
    const bv = json.bufferViews[img.bufferView];
    const bytes = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    textureBytes += bv.byteLength;
    const size = imageSize(bytes);
    if (size) maxTextureDim = Math.max(maxTextureDim, size.w, size.h);
    return { mimeType: img.mimeType, bytes: bv.byteLength, ...(size ?? {}) };
  });
  let triangles = 0;
  let uvSets = 0;
  let vertexColors = false;
  let primitives = 0;
  for (const mesh of json.meshes ?? []) {
    for (const p of mesh.primitives) {
      primitives++;
      const count = p.indices !== undefined ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count;
      triangles += Math.floor(count / 3);
      uvSets = Math.max(uvSets, Object.keys(p.attributes).filter((k) => k.startsWith("TEXCOORD_")).length);
      if (Object.keys(p.attributes).some((k) => k.startsWith("COLOR_"))) vertexColors = true;
    }
  }
  return {
    glbBytes: buf.byteLength,
    materials: materials.length,
    materialNames: materials.map((m) => m.name),
    alphaMaterials: materials.filter((m) => m.alphaMode === "BLEND" || m.alphaMode === "MASK").length,
    metallicMaterials: materials.filter((m) => (m.pbrMetallicRoughness?.metallicFactor ?? 1) > 0).length,
    extensionsUsed: json.extensionsUsed ?? [],
    meshes: (json.meshes ?? []).length,
    primitives,
    triangles,
    uvSets,
    vertexColors,
    textures: (json.textures ?? []).length,
    images: imageInfo,
    textureBytesGlb: textureBytes,
    maxTextureDim,
  };
}

async function validate(buf) {
  const report = await validateBytes(new Uint8Array(buf), { maxIssues: 50 });
  const { numErrors, numWarnings, numInfos, numHints, messages } = report.issues;
  return {
    validatorVersion: report.validatorVersion,
    errors: numErrors,
    warnings: numWarnings,
    infos: numInfos,
    hints: numHints,
    messages: messages.filter((m) => m.severity <= 1).slice(0, 20).map((m) => `${m.code} ${m.pointer ?? ""}: ${m.message}`),
  };
}

/** Scene Viewer rules (docs §3) as pass/fail gates. */
function sceneViewerGate(g, v) {
  const allowed = new Set(["KHR_materials_unlit", "KHR_texture_transform"]);
  const problems = [];
  if (v.errors > 0) problems.push(`${v.errors} validator errors`);
  for (const e of g.extensionsUsed) if (!allowed.has(e)) problems.push(`extension ${e}`);
  if (g.materials > 10) problems.push(`${g.materials} materials > 10`);
  if (g.alphaMaterials > 2) problems.push(`${g.alphaMaterials} alpha materials > 2`);
  if (g.uvSets > 1) problems.push(`${g.uvSets} UV sets`);
  if (g.vertexColors) problems.push("vertex colours");
  if (g.maxTextureDim > 2048) problems.push(`texture ${g.maxTextureDim}px > 2048`);
  if (g.triangles > 100_000) problems.push(`${g.triangles} triangles > 100k`);
  if (g.glbBytes > 10 * 1024 * 1024) problems.push("GLB > 10 MB");
  return { pass: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_PATH`);
  const buildLine = SKIP_BUILD ? null : build();
  if (!existsSync(join(APP, "dist", "index.html"))) throw new Error("no dist/: run without --skip-build");
  const precache = await precacheFromSw();

  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, "glb"), { recursive: true });

  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf-8" });
  const metrics = {
    theme: THEME,
    generatedAt: new Date().toISOString(),
    commit: git.stdout.trim() || null,
    wallHeightM: 2.5,
    viewport: { width: 1280, height: 800, dpr: 1, renderer: "headless Chrome, SwiftShader" },
    precache: { ...precache, kib: precache ? Math.round((precache.bytes / 1024) * 10) / 10 : null, workboxLine: buildLine },
    plans: {},
  };

  const preview = await startPreview();
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  try {
    for (const plan of PLANS) {
      log(`${plan} ...`);
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, serviceWorkers: "block" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await openBakeoff(page, plan);

      const canvas = page.locator("#bakeoff-canvas");
      const screenshots = [];
      let wallLuminance = null;
      const poses = await page.evaluate(() => [...window.__bakeoff.poses]);
      for (const pose of poses) {
        const ok = await page.evaluate((p) => window.__bakeoff.setPose(p), pose);
        if (!ok) continue;
        if (pose === "eye") wallLuminance = await page.evaluate((r) => window.__bakeoff.luminance(...r), WALL_PATCH);
        const file = `${plan}-${pose}.png`;
        await canvas.screenshot({ path: join(OUT, file) });
        screenshots.push(file);
      }
      const render = await page.evaluate(() => window.__bakeoff.stats());
      const b64 = await page.evaluate(() => window.__bakeoff.exportGlb());
      const glb = Buffer.from(b64, "base64");
      await writeFile(join(OUT, "glb", `${plan}.glb`), glb);
      const gltf = inspectGlb(glb);
      const validator = await validate(glb);
      metrics.plans[plan] = {
        gltf,
        validator,
        sceneViewer: sceneViewerGate(gltf, validator),
        render,
        wallLuminance: { patch: WALL_PATCH, pose: "eye", mean: wallLuminance },
        screenshots,
        pageErrors: errors,
      };
      log(`${plan}: ${gltf.glbBytes} B, ${gltf.materials} materials, ${validator.errors} validator errors`);
      await context.close();
    }
    const onlineTriangles = Object.fromEntries(Object.entries(metrics.plans).map(([k, v]) => [k, v.render.triangles]));
    metrics.offline = await offline(browser, onlineTriangles);
    metrics.timing = { swiftshader: await timing(browser, "swiftshader") };
    // Default GPU (hardware where headless Chrome gets one); recorded, gated by DECISION.md §4.4.
    const hw = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      metrics.timing.defaultGpu = await timing(hw, "default-gpu");
    } finally {
      await hw.close();
    }
  } finally {
    await browser.close();
    stopPreview(preview);
  }

  await writeFile(join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
  log(`wrote ${join(OUT, "metrics.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
