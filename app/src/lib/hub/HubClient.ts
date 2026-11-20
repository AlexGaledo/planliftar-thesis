/**
 * WebSocket client for the live-map hub, used by both the phone (AR) and the
 * laptop (live map). Port of the connect()/backoff logic both prototype pages
 * shared, so the two clients behave identically against the hub.
 *
 * Usage:
 *   const hub = new HubClient({ url, role: "viewer", onMessage, onStatus });
 *   hub.connect();  ...  hub.sendControl({ model_denom: 1 });  ...  hub.close();
 *
 * It is a plain class (not a hook) because the AR frame loop needs to call it
 * outside React. `useHub` wraps it for components.
 */
import { parseHubMessage, type ControlPatch, type HubMessage, type HubRole, type PhoneState, type PoseMessage } from "./protocol";

export type HubStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface HubClientOptions {
  url: string;
  role: HubRole;
  onMessage?: (msg: HubMessage) => void;
  onStatus?: (status: HubStatus) => void;
  /** Called right after the role tag is sent (the phone sends its state here). */
  onOpen?: () => void;
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10_000;
const RECONNECT_GROWTH = 1.6;

export class HubClient {
  private socket: WebSocket | null = null;
  private delay = RECONNECT_MIN_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  status: HubStatus = "closed";

  constructor(private readonly opts: HubClientOptions) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  /** Stop for good (component unmount). No reconnect afterwards. */
  close(): void {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.onerror = null;
      s.onmessage = null;
      try {
        s.close();
      } catch {
        /* already closing */
      }
    }
    this.setStatus("closed");
  }

  get isOpen(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  /** Raw send; returns false when not connected (messages are not queued). */
  send(payload: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  sendPose(pose: PoseMessage): boolean {
    return this.send(pose);
  }
  sendState(state: PhoneState): boolean {
    return this.send({ type: "state", state });
  }
  sendControl(patch: ControlPatch): boolean {
    return this.send({ type: "control", patch });
  }
  sendHello(): boolean {
    return this.send({ type: "hello" });
  }

  private setStatus(status: HubStatus): void {
    this.status = status;
    this.opts.onStatus?.(status);
  }

  private open(): void {
    this.setStatus(this.delay === RECONNECT_MIN_MS ? "connecting" : "reconnecting");
    let s: WebSocket;
    try {
      s = new WebSocket(this.opts.url);
    } catch {
      // A malformed URL throws synchronously; treat it like a failed connect.
      this.scheduleReconnect();
      return;
    }
    this.socket = s;

    s.onopen = () => {
      this.delay = RECONNECT_MIN_MS;
      s.send(JSON.stringify({ role: this.opts.role }));
      this.setStatus("open");
      // A viewer asks "anyone there?" so a panel opened after the phone still syncs.
      if (this.opts.role === "viewer") s.send(JSON.stringify({ type: "hello" }));
      this.opts.onOpen?.();
    };
    s.onmessage = (event) => this.opts.onMessage?.(parseHubMessage(event.data));
    s.onclose = () => {
      if (this.socket === s) this.socket = null;
      if (!this.closedByUser) this.scheduleReconnect();
    };
    s.onerror = () => {
      try {
        s.close();
      } catch {
        /* already closing */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    this.setStatus("reconnecting");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), this.delay);
    this.delay = Math.min(RECONNECT_MAX_MS, this.delay * RECONNECT_GROWTH);
  }
}
