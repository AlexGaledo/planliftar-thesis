/**
 * Home: the project library ("drawing register").
 *
 * Projects come from IndexedDB through useProjects() and update live, so a
 * rename/delete (or a save from another tab) appears without a refresh.
 * States: loading (skeleton sheets), empty (invite to add a plan), list.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Dialog } from "@/components/Dialog";
import type { Project } from "@/lib/db/db";
import { useProjects } from "@/lib/db/hooks";
import { deleteProject, renameProject } from "@/lib/db/projects";
import { addSamples } from "@/lib/db/samples";
import { InstallBanner } from "./InstallBanner";
import { ProjectCard } from "./ProjectCard";
import styles from "./projects.module.css";

const SKELETON_COUNT = 3;

export function ProjectsPage() {
  const projects = useProjects();
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="muted">Your floor plans, saved on this device.</p>
        </div>
        <Link className="btn btn-primary" to="/new">
          New project
        </Link>
      </header>

      <InstallBanner />

      {projects === undefined && (
        <ul className={styles.grid} aria-busy="true" aria-label="Loading projects">
          {Array.from({ length: SKELETON_COUNT }, (_, i) => (
            <li key={i} className={styles.skeleton} />
          ))}
        </ul>
      )}

      {projects?.length === 0 && <EmptyLibrary />}

      {projects && projects.length > 0 && (
        <ul className={styles.grid}>
          {projects.map((p) => (
            <li key={p.id}>
              <ProjectCard project={p} onRename={() => setRenaming(p)} onDelete={() => setDeleting(p)} />
            </li>
          ))}
        </ul>
      )}

      <RenameDialog project={renaming} onClose={() => setRenaming(null)} />
      <DeleteDialog project={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function EmptyLibrary() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className={styles.empty}>
      <h2>No plans yet</h2>
      <p className="muted">Upload a photo or scan of a floor plan, or start from one of the bundled examples.</p>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <Link className="btn btn-primary" to="/new">
          Upload a plan
        </Link>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await addSamples();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Adding examples…" : "Add the examples"}
        </button>
      </div>
    </section>
  );
}

function RenameDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={!!project} title="Rename project" onClose={() => { setError(null); onClose(); }}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const name = String(new FormData(e.currentTarget).get("name") ?? "");
          try {
            await renameProject(project!.id, name);
            setError(null);
            onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <div className="field">
          <label htmlFor="rename-input">Name</label>
          <input
            id="rename-input"
            name="name"
            className="input"
            defaultValue={project?.name}
            autoFocus
            maxLength={120}
            aria-invalid={!!error}
            aria-describedby={error ? "rename-error" : undefined}
          />
          {error && (
            <span id="rename-error" className="field-error">
              {error}
            </span>
          )}
        </div>
        <div className="row">
          <button className="btn btn-primary" type="submit">
            Save name
          </button>
          <button className="btn btn-quiet" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  return (
    <Dialog open={!!project} title="Delete this project?" onClose={onClose}>
      <p>
        <strong>{project?.name}</strong> and its source image will be removed from this device. This cannot be undone.
      </p>
      <div className="row">
        <button
          className="btn btn-danger"
          type="button"
          onClick={async () => {
            if (project) await deleteProject(project.id);
            onClose();
          }}
        >
          Delete project
        </button>
        <button className="btn btn-quiet" type="button" onClick={onClose} autoFocus>
          Keep it
        </button>
      </div>
    </Dialog>
  );
}
