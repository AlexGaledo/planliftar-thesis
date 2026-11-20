/**
 * React wrapper around HubClient for the live map (role "viewer").
 *
 * Poses arrive ~10 times a second. Putting each one in React state would
 * re-render the page 10x/s for nothing, so poses go to an `onPose` callback
 * (the canvas keeps them in a ref and draws on its own animation frame).
 * Only low-rate things live in state: connection status and the phone's
 * last reported settings.
 *
 * @param url     hub WebSocket URL (see useHubUrl)
 * @param onPose  called for every pose message
 */
import { useEffect, useRef, useState } from "react";
import { HubClient, type HubStatus } from "./HubClient";
import type { ControlPatch, PhoneState, PoseMessage } from "./protocol";

export interface ViewerHub {
  status: HubStatus;
  phoneState: PhoneState | null;
  sendControl: (patch: ControlPatch) => boolean;
}

export function useViewerHub(url: string, onPose: (pose: PoseMessage) => void): ViewerHub {
  const [status, setStatus] = useState<HubStatus>("connecting");
  const [phoneState, setPhoneState] = useState<PhoneState | null>(null);
  const clientRef = useRef<HubClient | null>(null);
  // Keep the latest callback without reconnecting when the parent re-renders.
  const onPoseRef = useRef(onPose);
  onPoseRef.current = onPose;

  useEffect(() => {
    const client = new HubClient({
      url,
      role: "viewer",
      onStatus: setStatus,
      onMessage: (msg) => {
        if (msg.kind === "pose") onPoseRef.current(msg.pose);
        else if (msg.kind === "state") setPhoneState(msg.state);
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [url]);

  return {
    status,
    phoneState,
    sendControl: (patch) => clientRef.current?.sendControl(patch) ?? false,
  };
}
