/**
 * Loading / not-found handling shared by every per-project page.
 *
 * Usage:
 *   <ProjectGate>{({ project, prepared }) => <MyPage ... />}</ProjectGate>
 *
 * The child only renders once the project exists and its plan is prepared, so
 * pages never have to repeat the undefined/null checks. Also records the
 * project as "last opened" for the Live map tab.
 */
import { useEffect, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type { Project } from "@/lib/db/db";
import { usePreparedPlan, useProject, type PreparedPlan } from "@/lib/db/hooks";
import { useSettings } from "@/stores/settings";

interface ProjectGateProps {
  children: (ctx: { project: Project; prepared: PreparedPlan }) => ReactNode;
}

export function ProjectGate({ children }: ProjectGateProps) {
  const { id } = useParams();
  const project = useProject(id);
  const prepared = usePreparedPlan(project);
  const update = useSettings((s) => s.update);

  useEffect(() => {
    if (project) update({ lastProjectId: project.id });
  }, [project, update]);

  if (project === undefined) {
    return (
      <div className="page" aria-busy="true">
        <div className="progress progress-indeterminate" role="progressbar" aria-label="Loading project">
          <span />
        </div>
      </div>
    );
  }
  if (project === null || !prepared) {
    return (
      <div className="page page-narrow">
        <h1>Project not found</h1>
        <p className="muted">It may have been deleted, or it was saved on a different device. Projects live in this browser only.</p>
        <div className="row">
          <Link className="btn btn-primary" to="/">
            Go to projects
          </Link>
        </div>
      </div>
    );
  }
  return <>{children({ project, prepared })}</>;
}
