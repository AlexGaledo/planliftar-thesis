/**
 * Shown when a route throws while loading or rendering (including a lazy chunk
 * that failed to download, which happens offline right after an update).
 */
import { Link, isRouteErrorResponse, useRouteError } from "react-router-dom";

export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Unknown error";
  const chunkFailed = /dynamically imported module|Failed to fetch|Importing a module script failed/i.test(message);

  return (
    <div className="page page-narrow">
      <h1>This page did not load</h1>
      <div className="notice notice-error" role="alert">
        <strong>{chunkFailed ? "Part of the app could not be downloaded." : "Something went wrong."}</strong>
        <span>
          {chunkFailed
            ? "You may be offline, or the app was just updated. Reload the page; if you are offline, open a page you have used before."
            : message}
        </span>
      </div>
      <div className="row">
        <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
        <Link className="btn" to="/">
          Go to projects
        </Link>
      </div>
    </div>
  );
}
