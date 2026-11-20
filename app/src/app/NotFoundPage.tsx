/** Catch-all for unknown addresses. */
import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <div className="page page-narrow">
      <h1>There is no page at this address</h1>
      <p className="muted">The link may be from an older version of the app.</p>
      <div className="row">
        <Link className="btn btn-primary" to="/">
          Go to projects
        </Link>
      </div>
    </div>
  );
}
