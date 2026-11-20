/**
 * App entry: global styles, React root, providers and router.
 * Kept tiny on purpose; the route table lives in app/router.tsx.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Warm the 3D theme (textures + door/window models) once the shell is up, so
// the viewer, AR and GLB export find it ready. Idle-time and lazy: the three.js
// chunk is not part of the first download. preloadTheme() never rejects.
// Not on /bakeoff, which measures a cold preload itself.
const warmTheme = () => void import("./lib/three/surfaceTheme").then((m) => m.preloadTheme());
if (!window.location.pathname.startsWith("/bakeoff")) {
  if ("requestIdleCallback" in window) window.requestIdleCallback(warmTheme, { timeout: 3000 });
  else setTimeout(warmTheme, 1000);
}
