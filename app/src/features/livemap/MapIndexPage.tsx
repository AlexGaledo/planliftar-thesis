/**
 * The "Live map" tab without a project in the URL: jump to the last opened
 * project, or ask which plan to follow.
 */
import { Link, Navigate } from "react-router-dom";
import { useProjects } from "@/lib/db/hooks";
import { useSettings } from "@/stores/settings";

export function MapIndexPage() {
  const lastId = useSettings((s) => s.lastProjectId);
  const projects = useProjects();

  if (projects === undefined) {
    return (
      <div className="page" aria-busy="true">
        <div className="progress progress-indeterminate" role="progressbar" aria-label="Loading projects">
          <span />
        </div>
      </div>
    );
  }
  if (lastId && projects.some((p) => p.id === lastId)) return <Navigate to={`/projects/${lastId}/map`} replace />;

  return (
    <div className="page page-narrow">
      <header className="page-header">
        <div>
          <h1>Live map</h1>
          <p className="muted">Follow a phone walking a plan in AR. Choose the plan the phone has open.</p>
        </div>
      </header>
      {projects.length === 0 ? (
        <p>
          No plans yet. <Link to="/new">Add one</Link> first.
        </p>
      ) : (
        <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {projects.map((p) => (
            <li key={p.id}>
              <Link className="btn btn-block" to={`/projects/${p.id}/map`} style={{ justifyContent: "flex-start" }}>
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
