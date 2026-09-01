/* Service worker for the PlanLiftAR PWA.
 *
 * Two jobs, and the second matters more than the install prompt:
 *
 *   1. Installability. Chrome wants a manifest AND a fetch-handling service
 *      worker before it offers a real app install on Android.
 *   2. Offline. three.js loads from a CDN, so on a laptop hotspot with no
 *      internet - which is the normal case for a site walkthrough - the AR
 *      view would fail to boot. Caching it makes the whole thing work off the
 *      LAN alone.
 *
 * NOTE: a service worker will not register on an origin whose TLS certificate
 * Chrome does not trust, even after you click through the interstitial. Run
 * the server with --tls and install its certificate on the phone (see
 * README.md) or none of this applies.
 */
const VERSION = "planliftar-v1";
const SHELL = VERSION + "-shell";

// Same-origin app shell. Kept explicit rather than globbed: a typo here is a
// failed install, and there are only a handful of files.
const SHELL_URLS = [
  "./",
  "./index.html",
  "./ar.html",
  "./plan_ops.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-192.png",
  "./icons/maskable-512.png",
];

// Cross-origin, and the one dependency the AR view cannot boot without.
const THREE_URL =
  "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Individually, not addAll: addAll rejects the whole install if any single
    // request fails, and the CDN one is exactly the one that can.
    await Promise.all(SHELL_URLS.map((u) => cache.add(u).catch(() => {})));
    await cache.add(new Request(THREE_URL, { mode: "no-cors" })).catch(() => {});
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only GET is cacheable, and the plan-upload job stub is a POST. Letting
  // anything else fall through untouched keeps /jobs working unchanged.
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Plans change while you are working on them, and both pages already fetch
  // them with cache: "no-store" expecting fresh bytes. Network first, cache
  // only as the offline fallback - the reverse would serve a stale floorplan
  // and look like the upload silently did nothing.
  if (sameOrigin && url.pathname.includes("/plans/")) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const hit = await caches.match(req);
        if (hit) return hit;
        throw e;
      }
    })());
    return;
  }

  // The pose hub is a WebSocket on another port; nothing here can or should
  // touch it. Anything else off-origin that is not three.js goes to network.
  if (!sameOrigin && req.url !== THREE_URL) return;

  // App shell: serve from cache immediately, refresh in the background. The
  // page you get is the one you had last time, which on a demo is a feature -
  // no spinner between tapping the icon and seeing the UI.
  event.respondWith((async () => {
    const hit = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && (res.ok || res.type === "opaque")) {
        caches.open(SHELL).then((c) => c.put(req, res.clone()));
      }
      return res;
    }).catch(() => null);
    return hit || network || Response.error();
  })());
});
