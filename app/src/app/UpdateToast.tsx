/**
 * Service-worker lifecycle UI.
 *
 * vite-plugin-pwa's `useRegisterSW` registers the generated service worker and
 * tells us when:
 *  - `needRefresh`: a new version is downloaded and waiting. With
 *    registerType "prompt" it never activates by itself, so an update cannot
 *    swap the code under someone mid-walkthrough. We offer a Reload button.
 *  - `offlineReady`: the app shell is cached; it now works with no network.
 *
 * Registration only happens in a secure context (https or localhost); on a
 * plain http LAN address the browser refuses service workers and this stays
 * silent, exactly like the prototype.
 */
import { useEffect } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import styles from "./Toast.module.css";

/** Check for a new version hourly while the app stays open (e.g. a kiosk laptop). */
const UPDATE_CHECK_MS = 60 * 60 * 1000;
/** "Ready to work offline" is good news, not a decision: it leaves by itself. */
const OFFLINE_READY_MS = 5000;

export function UpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (registration) setInterval(() => registration.update().catch(() => {}), UPDATE_CHECK_MS);
    },
    onRegisterError(error) {
      console.info("[pwa] service worker not registered:", error?.message ?? error);
    },
  });

  useEffect(() => {
    if (!offlineReady) return;
    const id = setTimeout(() => setOfflineReady(false), OFFLINE_READY_MS);
    return () => clearTimeout(id);
  }, [offlineReady, setOfflineReady]);

  if (!needRefresh && !offlineReady) return null;

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      {needRefresh ? (
        <>
          <span>A new version of PlanLiftAR is ready.</span>
          <div className="row">
            <button className="btn btn-primary" type="button" onClick={() => updateServiceWorker(true)}>
              Reload to update
            </button>
            <button className="btn btn-quiet" type="button" onClick={() => setNeedRefresh(false)}>
              Later
            </button>
          </div>
        </>
      ) : (
        <>
          <span>Ready to work offline.</span>
          <button className="btn btn-quiet" type="button" onClick={() => setOfflineReady(false)}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
