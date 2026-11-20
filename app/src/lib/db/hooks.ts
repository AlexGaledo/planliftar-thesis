/**
 * React hooks over the project store.
 *
 * `useLiveQuery` (dexie-react-hooks) runs the query and re-runs it whenever the
 * tables it read change, in this tab or another. It returns `undefined` while
 * the first result is loading, which is how pages tell "loading" apart from
 * "not found" (null) and "empty" ([]).
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useMemo } from "react";
import { computeBounds, preparePlan, type Plan, type PlanBounds } from "@/lib/plan";
import { useSettings } from "@/stores/settings";
import { db, type Project } from "./db";

/** All projects, newest first. undefined while loading. */
export function useProjects(): Project[] | undefined {
  return useLiveQuery(() => db.projects.orderBy("updatedAt").reverse().toArray(), []);
}

/** One project. undefined = loading, null = no such project. */
export function useProject(id: string | undefined): Project | null | undefined {
  return useLiveQuery(async () => (id ? ((await db.projects.get(id)) ?? null) : null), [id]);
}

export interface PreparedPlan {
  plan: Plan;
  bounds: PlanBounds;
}

/**
 * The project's plan, normalised and gap-closed (per the Settings toggle), with
 * its bounds. Memoised on the stored plan object, so gap closure runs once per
 * plan rather than on every render.
 */
export function usePreparedPlan(project: Project | null | undefined): PreparedPlan | null {
  const closeGaps = useSettings((s) => s.closeGaps);
  const raw = project?.plan;
  return useMemo(() => {
    if (!raw) return null;
    const plan = preparePlan(raw, { closeGaps });
    return { plan, bounds: computeBounds(plan) };
  }, [raw, closeGaps]);
}
