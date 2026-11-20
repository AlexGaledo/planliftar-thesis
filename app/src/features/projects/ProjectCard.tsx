/**
 * One project in the library, styled as a drawing sheet with a title block:
 * the plan drawing on top, then name, date and real size in a ruled box, like
 * the corner block of an architectural sheet.
 *
 * @param project   the stored project
 * @param onRename  open the rename dialog
 * @param onDelete  open the delete confirmation
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { PlanDrawing } from "@/components/PlanDrawing";
import type { Project } from "@/lib/db/db";
import { computeBounds, formatFootprint, normalizePlan } from "@/lib/plan";
import { useSettings } from "@/stores/settings";
import styles from "./projects.module.css";

interface ProjectCardProps {
  project: Project;
  onRename: () => void;
  onDelete: () => void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

const ORIGIN_LABEL: Record<Project["origin"], string> = {
  sample: "Example",
  upload: "From image",
  import: "Imported file",
};

export function ProjectCard({ project, onRename, onDelete }: ProjectCardProps) {
  const units = useSettings((s) => s.units);
  // Normalisation is cheap (no gap closure), enough for size and counts.
  const facts = useMemo(() => {
    const plan = normalizePlan(project.plan);
    const b = computeBounds(plan);
    return {
      size: formatFootprint(b.widthPx / project.ppm, b.heightPx / project.ppm, units),
      walls: plan.walls.length,
      rooms: plan.rooms?.length ?? 0,
    };
  }, [project.plan, project.ppm, units]);

  return (
    <article className={styles.card}>
      <Link to={`/projects/${project.id}`} className={styles.sheet} aria-label={`Open ${project.name}`}>
        <PlanDrawing svg={project.thumbnailSvg} label="" className={styles.drawing} />
      </Link>
      <div className={styles.titleBlock}>
        <h2 className={styles.name}>
          <Link to={`/projects/${project.id}`}>{project.name}</Link>
        </h2>
        <dl className={styles.facts}>
          <div>
            <dt>Size</dt>
            <dd>{facts.size}</dd>
          </div>
          <div>
            <dt>Rooms</dt>
            <dd>{facts.rooms}</dd>
          </div>
          <div>
            <dt>Saved</dt>
            <dd>
              <time dateTime={new Date(project.updatedAt).toISOString()}>{dateFormat.format(project.updatedAt)}</time>
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{project.demo ? "Demo result" : ORIGIN_LABEL[project.origin]}</dd>
          </div>
        </dl>
        <div className={styles.actions}>
          <button type="button" className="btn btn-quiet" onClick={onRename}>
            Rename
          </button>
          <button type="button" className="btn btn-quiet" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
    </article>
  );
}
