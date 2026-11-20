/**
 * The hub WebSocket URL for the current settings, as a hook.
 */
import { hubUrl } from "@/lib/api/urls";
import { useSettings } from "@/stores/settings";

export function useHubUrl(): string {
  const serverUrl = useSettings((s) => s.serverUrl);
  const hubMode = useSettings((s) => s.hubMode);
  const customUrl = useSettings((s) => s.hubUrl);
  return hubUrl({ serverUrl, hubMode, hubUrl: customUrl });
}
