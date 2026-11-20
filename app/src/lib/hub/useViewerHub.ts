/**
 * React wrapper around HubClient for the live map (role "viewer").
 *
 * Poses arrive ~10 times a second. Putting each one in React state would
 * re-render the page 10x/s for nothing, so poses go to an `onPose` callback
 * (the canvas keeps them in a ref and draws on its own animation frame).
 * Only low-rate things live in state: connection status, the phone's last
 * reported settings, and the plan the phone shared (PROTOCOL.md "Plan").
 *
 * @param url     hub WebSocket URL (see useHubUrl); null = do not connect
 *                (the caller is handed an already-connected hub instead)
 * @param onPose  called for every pose message
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { HubClient, type HubStatus } from "./HubClient";
import type { ControlPatch, PhoneState, PoseMessage, SharedPlan } from "./protocol";

export interface ViewerHub {
  status: HubStatus;
  phoneState: PhoneState | null;
  /** the latest plan a phone shared (the server hub replays it on connect) */
  sharedPlan: SharedPlan | null;
  sendControl: (patch: ControlPatch) => boolean;
  /** Extra pose listener (for a child that reuses this connection). Returns unsubscribe. */
  subscribePoses: (fn: (pose: PoseMessage) => void) => () => void;
}

export function useViewerHub(url: string | null, onPose?: (pose: PoseMessage) => void): ViewerHub {
  const [status, setStatus] = useState<HubStatus>("connecting");
  const [phoneState, setPhoneState] = useState<PhoneState | null>(null);
  const [sharedPlan, setSharedPlan] = useState<SharedPlan | null>(null);
  const clientRef = useRef<HubClient | null>(null);
  const listeners = useRef(new Set<(pose: PoseMessage) => void>());
  // Keep the latest callback without reconnecting when the parent re-renders.
  const onPoseRef = useRef(onPose);
  onPoseRef.current = onPose;

  useEffect(() => {
    if (!url) return;
    const client = new HubClient({
      url,
      role: "viewer",
      onStatus: setStatus,
      onMessage: (msg) => {
        if (msg.kind === "pose") {
          onPoseRef.current?.(msg.pose);
          listeners.current.forEach((fn) => fn(msg.pose));
        } else if (msg.kind === "state") setPhoneState(msg.state);
        else if (msg.kind === "plan") setSharedPlan(msg.shared);
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [url]);

  const subscribePoses = useCallback((fn: (pose: PoseMessage) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  return {
    status,
    phoneState,
    sharedPlan,
    sendControl: (patch) => clientRef.current?.sendControl(patch) ?? false,
    subscribePoses,
  };
}
