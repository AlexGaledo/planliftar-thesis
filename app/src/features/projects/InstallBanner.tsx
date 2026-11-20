/**
 * "Install the app" banner on the library page. Shows a real Install button on
 * Chrome/Edge, a written hint on iPhone, and nothing once installed or dismissed.
 */
import { useInstallPrompt } from "@/hooks/useInstallPrompt";
import { useSettings } from "@/stores/settings";

export function InstallBanner() {
  const { canInstall, installed, isIos, install } = useInstallPrompt();
  const dismissed = useSettings((s) => s.installDismissed);
  const update = useSettings((s) => s.update);

  if (installed || dismissed || (!canInstall && !isIos)) return null;

  return (
    <aside className="notice" aria-label="Install the app">
      <strong>Install PlanLiftAR on this device</strong>
      <span className="small">
        {canInstall
          ? "It opens full screen and your saved plans work without a connection."
          : "In Safari, tap Share, then Add to Home Screen. Saved plans then work without a connection."}
      </span>
      <div className="row">
        {canInstall && (
          <button className="btn btn-primary" type="button" onClick={() => void install()}>
            Install
          </button>
        )}
        <button className="btn btn-quiet" type="button" onClick={() => update({ installDismissed: true })}>
          Not now
        </button>
      </div>
    </aside>
  );
}
