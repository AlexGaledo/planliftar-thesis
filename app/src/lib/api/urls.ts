/**
 * Turns the user's settings into concrete API and hub URLs.
 *
 * Pure functions (no store access) so they are easy to test. `location` is
 * passed in for the same reason.
 *
 *   serverUrl ""                         -> API "/api",  hub ws(s)://<page host>/ws
 *   serverUrl "https://192.168.1.5:8443" -> API "https://192.168.1.5:8443/api",
 *                                           hub "wss://192.168.1.5:8443/ws"
 *   hubMode "legacy"                     -> ws(s)://<server host>:8765 (server.py hub)
 */
import type { HubMode } from "@/stores/settings";

/** server.py's standalone hub port (PROTOCOL.md). */
export const LEGACY_HUB_PORT = 8765;

interface LocationLike {
  protocol: string;
  host: string;
  hostname: string;
  origin: string;
}

/** Normalise what the user typed: trim, drop trailing slashes, add https:// if missing. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

/** Base for REST calls, without a trailing slash. */
export function apiBase(serverUrl: string): string {
  const s = normalizeServerUrl(serverUrl);
  return s ? `${s}/api` : "/api";
}

/** The origin the hub lives on: the API server's, or this page's. */
function serverOrigin(serverUrl: string, loc: LocationLike): URL {
  const s = normalizeServerUrl(serverUrl);
  return new URL(s || loc.origin);
}

export function hubUrl(
  settings: { serverUrl: string; hubMode: HubMode; hubUrl: string },
  loc: LocationLike = window.location,
): string {
  if (settings.hubMode === "custom" && settings.hubUrl.trim()) return settings.hubUrl.trim();
  const origin = serverOrigin(settings.serverUrl, loc);
  // An https page cannot open a plain ws:// socket (mixed content), so the scheme
  // follows the server's own.
  const scheme = origin.protocol === "https:" ? "wss" : "ws";
  if (settings.hubMode === "legacy") return `${scheme}://${origin.hostname}:${LEGACY_HUB_PORT}`;
  return `${scheme}://${origin.host}/ws`;
}

/**
 * Why a request to this server cannot work from this page, or null if it can.
 * The common trap: the app is on https (Vercel) and the server is http://.
 */
export function mixedContentProblem(serverUrl: string, loc: LocationLike = window.location): string | null {
  const s = normalizeServerUrl(serverUrl);
  if (loc.protocol === "https:" && s.startsWith("http://")) {
    return "This page is served over https, so the browser blocks requests to an http:// server. Use the server's https address.";
  }
  return null;
}
