/**
 * Vite config for the PlanLiftAR PWA.
 *
 * - `@` aliases `src/` so imports read `@/lib/plan` instead of `../../../lib/plan`.
 * - vite-plugin-pwa generates the service worker (Workbox) and the web manifest.
 * - The dev server proxies `/api` and `/ws` to the local inference server so the
 *   app can use same-origin URLs in development exactly as in production.
 * - Vitest reads the `test` block (jsdom + Testing Library setup).
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

  return {
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
        includeAssets: ["icons/*.png"],
        manifest: {
          id: "/",
          name: "PlanLiftAR",
          short_name: "PlanLift",
          description: "Turn a floor plan picture into a 3D model and walk it at 1:1 in AR.",
          start_url: "/",
          scope: "/",
          display: "standalone",
          orientation: "any",
          background_color: "#ffffff",
          theme_color: "#000000",
          categories: ["productivity", "utilities"],
          icons: [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
            { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
          shortcuts: [
            { name: "New project", short_name: "New", url: "/new", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
            { name: "Live map", short_name: "Map", url: "/map", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
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
          navigateFallback: "/index.html",
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
