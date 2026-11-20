/**
 * Analysis progress for one job: polls GET /api/jobs/{id} about once a second
 * until it finishes, then saves the result as a project and opens it.
 *
 * The job id is in the URL and the uploaded image is in IndexedDB
 * (pendingUploads), so a reload mid-analysis picks up where it left off.
 *
 * Outcomes:
 *  - done + accepted        -> saved automatically, navigate to the plan
 *  - done + rejected        -> show the reasons; "Save anyway" if walls exist
 *  - error / unreachable    -> explain, offer to try again
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { isTerminal, usePlanApi, type Job } from "@/lib/api";
import { clearPendingUpload, getPendingUpload } from "@/lib/db/pendingUploads";
import { createProject } from "@/lib/db/projects";
import { parsePlan } from "@/lib/plan";
import { useSettings } from "@/stores/settings";
import { describeRejection } from "./rejections";
import styles from "./newProject.module.css";

const POLL_MS = 1000;

export function JobProgressPage() {
  const { jobId = "" } = useParams();
  const api = usePlanApi();
  const serverUrl = useSettings((s) => s.serverUrl);
  const navigate = useNavigate();
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);

  const job = useQuery({
    queryKey: ["job", api.kind, serverUrl, jobId],
    queryFn: () => api.getJob(jobId),
    // Keep polling until the job reaches a terminal state.
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data.status) ? false : POLL_MS),
    retry: 2,
    staleTime: 0,
  });

  const data = job.data;
  const rejected = data?.status === "done" && data.result?.acceptance?.accepted === false;

  async function save(result: NonNullable<Job["result"]>) {
    // Guard against double saves (StrictMode re-runs effects; users double-tap).
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      parsePlan(result);
      const pending = await getPendingUpload(jobId);
      const project = await createProject({
        name: pending?.name ?? "New plan",
        plan: result,
        origin: "upload",
        sourceImage: pending?.image,
        demo: pending?.demo ?? api.kind === "demo",
      });
      await clearPendingUpload(jobId);
      navigate(`/projects/${project.id}`, { replace: true });
    } catch (e) {
      savingRef.current = false;
      setSaveError((e as Error).message);
    }
  }

  useEffect(() => {
    if (data?.status === "done" && data.result && !rejected) void save(data.result);
    // save() is stable enough for this one-shot effect; listing it would re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.status, rejected]);

  const percent = Math.round((data?.progress ?? 0) * 100);

  return (
    <div className="page page-narrow">
      <header className="page-header">
        <div>
          <h1>Reading your plan</h1>
          <p className="muted">This usually takes under a minute. Keep this page open; the plan is saved to your projects when it is done.</p>
        </div>
      </header>

      {job.isPending && (
        <div className="progress progress-indeterminate" role="progressbar" aria-label="Contacting the server">
          <span />
        </div>
      )}

      {job.isError && (
        <div className="notice notice-error" role="alert">
          <strong>The analysis could not be followed.</strong>
          <span>{(job.error as Error).message}</span>
          <div className="row">
            <button className="btn" type="button" onClick={() => void job.refetch()}>
              Check again
            </button>
            <Link className="btn btn-quiet" to="/new">
              Upload again
            </Link>
          </div>
        </div>
      )}

      {data && !rejected && data.status !== "error" && (
        <section className={styles.progressCard} aria-live="polite">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <span className={styles.percent}>{percent}%</span>
            <span className="muted">{data.status === "queued" ? "Waiting for the server" : data.stage}</span>
          </div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Analysis progress">
            <span style={{ width: `${percent}%` }} />
          </div>
          {data.status === "done" && !saveError && <p role="status">Saving the plan…</p>}
        </section>
      )}

      {data?.status === "error" && (
        <div className="notice notice-error" role="alert">
          <strong>The analysis failed.</strong>
          <span>{data.error || "The server reported an error without details."}</span>
          <div className="row">
            <Link className="btn btn-primary" to="/new">
              Try another image
            </Link>
          </div>
        </div>
      )}

      {rejected && data?.result && (
        <div className="notice notice-warn" role="alert">
          <strong>The plan did not pass the quality check.</strong>
          <ul>
            {(data.result.acceptance?.reject_reasons ?? []).map((r) => (
              <li key={r}>{describeRejection(r)}</li>
            ))}
          </ul>
          <span className="small">
            The pipeline refuses to build a broken model rather than guess. A straighter, higher-resolution photo or scan usually helps.
          </span>
          <div className="row">
            <Link className="btn btn-primary" to="/new">
              Try another image
            </Link>
            {data.result.walls?.length > 0 && (
              <button className="btn" type="button" onClick={() => void save(data.result!)}>
                Save anyway
              </button>
            )}
          </div>
        </div>
      )}

      {saveError && (
        <p className="notice notice-error" role="alert">
          The result could not be saved: {saveError}
        </p>
      )}
    </div>
  );
}
