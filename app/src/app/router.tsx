/**
 * Route table (docs/APP_PLAN.md §2).
 *
 * `lazy` routes return `{ Component }` from a dynamic import, so Vite emits one
 * chunk per page and heavy dependencies stay out of the first download. Light
 * pages (library, new project, settings) are lazy too, to keep the shell small.
 */
import { createBrowserRouter } from "react-router-dom";
import { AppShell } from "./AppShell";
import { RouteError } from "./RouteError";

export const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <AppShell />,
      errorElement: <RouteError />,
      children: [
        { index: true, lazy: () => import("@/features/projects/ProjectsPage").then((m) => ({ Component: m.ProjectsPage })) },
        { path: "new", lazy: () => import("@/features/new-project/NewProjectPage").then((m) => ({ Component: m.NewProjectPage })) },
        { path: "new/job/:jobId", lazy: () => import("@/features/new-project/JobProgressPage").then((m) => ({ Component: m.JobProgressPage })) },
        { path: "projects/:id", lazy: () => import("@/features/plan/PlanPage").then((m) => ({ Component: m.PlanPage })) },
        { path: "projects/:id/3d", lazy: () => import("@/features/viewer/ViewerPage").then((m) => ({ Component: m.ViewerPage })) },
        { path: "projects/:id/map", lazy: () => import("@/features/livemap/LiveMapPage").then((m) => ({ Component: m.LiveMapPage })) },
        { path: "map", lazy: () => import("@/features/livemap/MapIndexPage").then((m) => ({ Component: m.MapIndexPage })) },
        { path: "learn", lazy: () => import("@/features/learn/LearnPage").then((m) => ({ Component: m.LearnPage })) },
        { path: "settings", lazy: () => import("@/features/settings/SettingsPage").then((m) => ({ Component: m.SettingsPage })) },
        { path: "*", lazy: () => import("./NotFoundPage").then((m) => ({ Component: m.NotFoundPage })) },
      ],
    },
    // AR is full-bleed: no nav chrome over the camera.
    {
      path: "/projects/:id/ar",
      errorElement: <RouteError />,
      lazy: () => import("@/features/ar/ArPage").then((m) => ({ Component: m.ArPage })),
    },
    // Texture bake-off render target (scripts/bakeoff). Unlinked, no chrome.
    {
      path: "/bakeoff",
      errorElement: <RouteError />,
      lazy: () => import("@/features/bakeoff/BakeoffPage").then((m) => ({ Component: m.BakeoffPage })),
    },
  ],
  {
    // GitHub Pages serves the app under a subpath (see vite.config.ts `base`);
    // the router must strip that prefix the same way the SW's navigateFallback does.
    basename: import.meta.env.BASE_URL,
    future: { v7_relativeSplatPath: true, v7_fetcherPersist: true, v7_normalizeFormMethod: true, v7_partialHydration: true, v7_skipActionErrorRevalidation: true },
  },
);
