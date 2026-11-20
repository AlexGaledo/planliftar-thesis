/**
 * PWA install prompt.
 *
 * Chrome fires `beforeinstallprompt` once it decides the app is installable
 * (manifest + service worker + https). We stash the event and call `.prompt()`
 * later from a button, because browsers only allow the prompt in response to a
 * user gesture. iOS Safari never fires it; there the user must use Share >
 * Add to Home Screen, so we expose `isIos` for a written hint instead.
 *
 * The event is captured at module load (not in an effect) because it can fire
 * before React has mounted the component that wants it.
 */
import { useEffect, useState } from "react";

/** Not in TypeScript's DOM types yet. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // stop Chrome's mini-infobar; we show our own banner
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function useInstallPrompt() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return {
    /** true when we can show a real Install button */
    canInstall: !!deferred,
    installed: isStandalone(),
    isIos,
    async install(): Promise<boolean> {
      if (!deferred) return false;
      const event = deferred;
      deferred = null;
      await event.prompt();
      const { outcome } = await event.userChoice;
      notify();
      return outcome === "accepted";
    },
  };
}
