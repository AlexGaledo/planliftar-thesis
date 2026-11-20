/**
 * "Offline" badge, shown only while the browser reports no network. The app
 * keeps working (projects are in IndexedDB, the shell is precached); this just
 * explains why new analysis and the live map are unavailable.
 */
import { useOnline } from "@/hooks/useOnline";

export function OfflineBadge() {
  const online = useOnline();
  if (online) return null;
  return (
    <span className="small muted" role="status">
      <span className="dot dot-warn" aria-hidden="true" /> Offline. Saved projects still work.
    </span>
  );
}
