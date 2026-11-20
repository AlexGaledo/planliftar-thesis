/**
 * New project: three ways in.
 *  1. Upload an image (file picker, or camera on phones) -> server analysis job.
 *  2. Import a plan JSON file -> saved straight away (no server needed).
 *  3. Add a bundled example.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createProject } from "@/lib/db/projects";
import { SAMPLES, fetchSample } from "@/lib/db/samples";
import { parsePlan, type RawPlan } from "@/lib/plan";
import { ImageUploadForm } from "./ImageUploadForm";
import { ServerStatus } from "./ServerStatus";
import styles from "./newProject.module.css";

/** Plan files over this size are almost certainly not plans (largest sample: 60 KB). */
const MAX_JSON_BYTES = 10 * 1024 * 1024;

export function NewProjectPage() {
  const navigate = useNavigate();
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [busySample, setBusySample] = useState<string | null>(null);

  async function importJson(file: File) {
    setJsonError(null);
    if (file.size > MAX_JSON_BYTES) {
      setJsonError(`"${file.name}" is larger than 10 MB, which is too big for a plan file.`);
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      setJsonError(`"${file.name}" is not valid JSON: ${(e as Error).message}`);
      return;
    }
    try {
      parsePlan(data); // validate only; the raw form is what gets stored
      const project = await createProject({
        name: file.name.replace(/\.json$/i, ""),
        plan: data as RawPlan,
        origin: "import",
      });
      navigate(`/projects/${project.id}`);
    } catch (e) {
      setJsonError(`"${file.name}": ${(e as Error).message}`);
    }
  }

  async function addSample(id: string, name: string) {
    setBusySample(id);
    try {
      const plan = await fetchSample(id);
      const project = await createProject({ name, plan, origin: "sample", sampleId: id });
      navigate(`/projects/${project.id}`);
    } catch (e) {
      setJsonError((e as Error).message);
      setBusySample(null);
    }
  }

  return (
    <div className="page page-narrow">
      <header className="page-header">
        <div>
          <h1>New project</h1>
          <p className="muted">Start from a picture of a floor plan. The AI finds the walls and rooms for you.</p>
        </div>
      </header>

      <section className={styles.section} aria-labelledby="upload-heading">
        <h2 id="upload-heading">From a picture</h2>
        <ServerStatus />
        <ImageUploadForm />
      </section>

      <section className={styles.section} aria-labelledby="import-heading">
        <h2 id="import-heading">From a plan file</h2>
        <p className="muted">
          Already have walls and rooms as JSON (from the notebook or another device)? Open it here. Nothing is uploaded.
        </p>
        <label className="btn" htmlFor="json-input">
          Open a plan file (.json)
        </label>
        <input
          id="json-input"
          className="visually-hidden"
          type="file"
          accept=".json,application/json"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // so picking the same file again still fires change
            if (file) void importJson(file);
          }}
        />
        {jsonError && (
          <p className="notice notice-error" role="alert">
            {jsonError}
          </p>
        )}
      </section>

      <section className={styles.section} aria-labelledby="examples-heading">
        <h2 id="examples-heading">From an example</h2>
        <ul className={styles.samples}>
          {SAMPLES.map((s) => (
            <li key={s.id}>
              <div>
                <strong>{s.name}</strong>
                <p className="small muted">{s.description}</p>
              </div>
              <button
                className="btn"
                type="button"
                disabled={busySample !== null}
                onClick={() => void addSample(s.id, s.name)}
                aria-label={`Add example: ${s.name}`}
              >
                {busySample === s.id ? "Adding…" : "Add"}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
