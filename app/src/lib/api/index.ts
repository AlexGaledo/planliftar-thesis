/**
 * API entry point. `usePlanApi()` returns the right client for the current
 * settings: the demo fake when Demo mode is on, otherwise the HTTP client.
 */
import { useMemo } from "react";
import { useSettings } from "@/stores/settings";
import { createDemoApi } from "./demoApi";
import { createHttpApi } from "./httpApi";
import type { PlanApi } from "./types";

export * from "./types";
export { ApiError } from "./httpApi";
export { apiBase, hubUrl, mixedContentProblem, normalizeServerUrl } from "./urls";

// One demo instance for the app's lifetime, so demo jobs survive re-renders.
const demoApi = createDemoApi();

export function getPlanApi(settings: { demoMode: boolean; serverUrl: string }): PlanApi {
  return settings.demoMode ? demoApi : createHttpApi(settings.serverUrl);
}

export function usePlanApi(): PlanApi {
  const demoMode = useSettings((s) => s.demoMode);
  const serverUrl = useSettings((s) => s.serverUrl);
  return useMemo(() => getPlanApi({ demoMode, serverUrl }), [demoMode, serverUrl]);
}
