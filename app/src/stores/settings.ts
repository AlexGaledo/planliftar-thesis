/**
 * App settings, persisted to localStorage with zustand's `persist` middleware.
 *
 * Why zustand: settings are read all over the app (API client, hub, units) and
 * written in one place. A zustand store is a hook (`useSettings(s => s.units)`)
 * that only re-renders components using the slice they selected, with no
 * provider to wire up. `persist` saves it so the server address survives reloads.
 *
 * Read outside React with `useSettings.getState()`.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Units } from "@/lib/plan/scale";

/**
 * How to reach the live-map hub:
 *  - "auto": same origin as the API server, path /ws (the new backend merges the hub)
 *  - "legacy": the standalone server.py hub on port 8765 of the API host
 *  - "custom": exactly `hubUrl`
 */
export type HubMode = "auto" | "legacy" | "custom";

export interface SettingsState {
  /** Empty = same origin as the app. Otherwise e.g. "https://192.168.1.42:8443". */
  serverUrl: string;
  hubMode: HubMode;
  /** Used when hubMode is "custom", e.g. "wss://192.168.1.42:8765". */
  hubUrl: string;
  /** Use the in-browser fake API instead of a real server. */
  demoMode: boolean;
  units: Units;
  /** Run wall-gap closure on plans (on by default, like the prototype). */
  closeGaps: boolean;
  /** Last project opened, so "Live map" knows what to show. */
  lastProjectId: string | null;
  /** The user dismissed the install banner. */
  installDismissed: boolean;

  update: (patch: Partial<Omit<SettingsState, "update" | "reset">>) => void;
  reset: () => void;
}

export const DEFAULT_SETTINGS = {
  serverUrl: "",
  hubMode: "auto" as HubMode,
  hubUrl: "",
  // A build deployed without a backend (e.g. a Vercel preview) can default to demo
  // mode by setting VITE_DEFAULT_DEMO_MODE=true at build time.
  demoMode: import.meta.env.VITE_DEFAULT_DEMO_MODE === "true",
  units: "metric" as Units,
  closeGaps: true,
  lastProjectId: null as string | null,
  installDismissed: false,
};

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      update: (patch) => set(patch),
      reset: () => set({ ...DEFAULT_SETTINGS }),
    }),
    {
      name: "planliftar.settings",
      version: 1,
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
