/**
 * Vite config for the PlanVisAR PWA.
 *
 * - `@` aliases `src/` so imports read `@/lib/plan` instead of `../../../lib/plan`.
 * - vite-plugin-pwa generates the service worker (Workbox) and the web manifest.
 * - The dev server proxies `/api` and `/ws` to the local inference server so the
 *   app can use same-origin URLs in development exactly as in production.
 * - Vitest reads the `test` block (jsdom + Testing Library setup).
 *
 * Two deploy targets share this same config:
 *   - `backend/server` serves `dist/` from its own domain root (LAN/local demo) -> base "/".
 *   - GitHub Pages serves it as a project page under a subpath (for the Bubblewrap/TWA
 *     wrapper, see `features/offline-apk.md`) -> base "/planliftar-thesis/".
 * Set VITE_BASE_PATH to override (must start and end with "/"); everything that needs
 * the base (PWA manifest start_url/scope/id/icons, the router's basename via
 * import.meta.env.BASE_URL, the SW's navigateFallback) derives from this one value.
 */
/// <reference types="vitest" />
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Where `pnpm dev` forwards /api and /ws. Override with VITE_DEV_BACKEND in .env.local,
// e.g. VITE_DEV_BACKEND=https://localhost:8443 for a TLS backend.
const DEFAULT_DEV_BACKEND = "http://127.0.0.1:8000";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backend = env.VITE_DEV_BACKEND || DEFAULT_DEV_BACKEND;
  const base = env.VITE_BASE_PATH || "/";
  const withBase = (path: string) => `${base}${path}`.replace(/\/{2,}/g, "/");

  return {
    base,
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      host: true,
      proxy: {
        "/api": { target: backend, changeOrigin: true, secure: false },
        "/ws": { target: backend.replace(/^http/, "ws"), ws: true, secure: false },
      },
    },
    build: {
      // three.js and model-viewer are big on purpose (they are 3D engines). They are
      // split into lazy route chunks, so the warning threshold is raised to match.
      chunkSizeWarningLimit: 1600,
    },
    plugins: [
      react(),
      VitePWA({
        // "prompt": a new version waits until the user taps Reload in the toast,
        // so an update never swaps the code under someone mid-walkthrough.
        registerType: "prompt",
        includeAssets: ["icons/*.png", "icons/*.svg"],
        manifest: {
          id: base,
          name: "PlanVisAR",
          short_name: "PlanVisAR",
          description: "Turn a floor plan picture into a 3D model and walk it at 1:1 in AR.",
          start_url: base,
          scope: base,
          display: "standalone",
          orientation: "any",
          background_color: "#fafaf7",
          theme_color: "#12302f",
          categories: ["productivity", "utilities"],
          icons: [
            { src: withBase("icons/icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
            { src: withBase("icons/icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
            { src: withBase("icons/maskable-192.png"), sizes: "192x192", type: "image/png", purpose: "maskable" },
            { src: withBase("icons/maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
          shortcuts: [
            { name: "New project", short_name: "New", url: withBase("new"), icons: [{ src: withBase("icons/icon-192.png"), sizes: "192x192" }] },
            { name: "Live map", short_name: "Map", url: withBase("map"), icons: [{ src: withBase("icons/icon-192.png"), sizes: "192x192" }] },
          ],
        },
        workbox: {
          // App shell + bundled sample plans. Fonts are self-hosted, so they are
          // precached too and the whole UI renders on a LAN with no internet.
          // jpg/glb: the "home" theme's CC0 textures and door/window models
          // (public/textures, public/models), so 3D, AR and GLB export work offline.
          globPatterns: ["**/*.{js,css,html,png,jpg,glb,svg,woff2,json,webmanifest}"],
          // The model-viewer chunk (iOS fallback) is ~1 MB; allow it into the precache.
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          navigateFallback: withBase("index.html"),
          // Never answer API calls, the hub socket or the asset licence files
          // (linked from /learn#credits) with the SPA shell.
          navigateFallbackDenylist: [/^\/api\//, /^\/ws/, /\/CREDITS\.txt$/],
          runtimeCaching: [
            { urlPattern: ({ url }) => url.pathname.startsWith("/api/"), handler: "NetworkOnly" },
          ],
          cleanupOutdatedCaches: true,
        },
        devOptions: { enabled: false },
      }),
    ],
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"], // e2e/ is Playwright's (pnpm e2e)
      css: false,
    },
  };
});
