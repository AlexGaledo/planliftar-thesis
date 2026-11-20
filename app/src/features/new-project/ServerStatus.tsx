/**
 * One-line server status above the upload form, so a user knows before they
 * upload whether analysis can run: ready (with GPU/CPU), demo mode, or not
 * reachable (with a link to fix it in Settings).
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { usePlanApi } from "@/lib/api";
import { useSettings } from "@/stores/settings";

export function ServerStatus() {
  const api = usePlanApi();
  const serverUrl = useSettings((s) => s.serverUrl);
  const health = useQuery({ queryKey: ["health", api.kind, serverUrl], queryFn: () => api.health(), retry: 0 });

  if (api.kind === "demo") {
    return (
      <p className="notice notice-warn small">
        <span>
          <strong>Demo mode is on.</strong> Uploads are not analysed; you get a sample plan after a short simulated run.{" "}
          <Link to="/settings">Change in Settings</Link>
        </span>
      </p>
    );
  }
  if (health.isPending) {
    return (
      <p className="small muted" role="status">
        <span className="dot" aria-hidden="true" /> Checking the analysis server…
      </p>
    );
  }
  if (health.isError) {
    return (
      <div className="notice notice-error small" role="alert">
        <strong>The analysis server is not reachable.</strong>
        <span>{(health.error as Error).message}</span>
        <span>
          You can still import a plan file or open an example. <Link to="/settings">Server settings</Link>
        </span>
      </div>
    );
  }
  const h = health.data;
  const missing = Object.entries(h.models)
    .filter(([, loaded]) => !loaded)
    .map(([name]) => name);
  return (
    <p className={`notice small ${missing.length ? "notice-warn" : "notice-live"}`} role="status">
      <span>
        <span className="dot dot-live" aria-hidden="true" /> Analysis server ready on {h.device === "cuda" ? "GPU" : "CPU"}
        {h.device === "cpu" && " (slower)"}.{missing.length > 0 && ` Missing model: ${missing.join(", ")}.`}
      </span>
    </p>
  );
}
