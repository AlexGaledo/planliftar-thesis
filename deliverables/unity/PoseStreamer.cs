// PoseStreamer.cs
//
// Streams this device's pose within the placed floorplan to a spectator
// "live map" web page over a plain WebSocket, so someone on a laptop on
// the same WiFi can watch the AR camera move around the floorplan in real
// time (see deliverables/livemap/ - server.py + index.html).
//
// ---- Coordinate conversion (read before changing) ----
// FloorPlanMeshBuilder.PlanToWorld maps plan pixel coords to root-LOCAL
// space via worldX = x * metersPerPixel, worldZ = -y * metersPerPixel (see
// that file's header for the handedness rationale). This component inverts
// that mapping: it reads the AR camera's position in the floorplan root's
// local space (root.InverseTransformPoint), then solves back to plan px:
//     x = localX / metersPerPixel
//     y = -localZ / metersPerPixel
// Heading (yaw_deg) is derived the same way MinimapController computes its
// marker's facing (root.InverseTransformDirection(camera.forward),
// flattened to XZ), but expressed as a scalar degree via
// Atan2(local.x, local.z) instead of a quaternion. Because plan y is
// -localZ, this makes yaw_deg = 0 mean "facing plan -Y" (up on the map),
// with yaw increasing clockwise toward plan +X -
// exactly Unity's own Euler-Y convention, and the convention
// deliverables/livemap/index.html's heading-cone math expects. Both sides
// derive from the same PlanToWorld mapping, so do not change one without
// the other.
//
// ---- Networking ----
// Uses System.Net.WebSockets.ClientWebSocket directly (no third-party
// package, matching the "stdlib/framework only" constraint on the server
// side too). An async void connect/pump loop reconnects with exponential
// backoff on any failure or unexpected close, per the standard
// "async void event-handler-style entry point" pattern (ConnectLoop is
// fire-and-forget from OnEnable; everything after the first await runs on
// Unity's SynchronizationContext, so touching Unity APIs from it is safe).
// Sending is fire-and-forget per tick, guarded against overlap since
// ClientWebSocket does not allow concurrent SendAsync calls. Nothing is
// sent before the floorplan is placed (see TapToPlaceFloorPlan.IsPlaced).
//
// NOTE (Android/IL2CPP): ClientWebSocket relies on System.Net.WebSockets,
// which is present in .NET Standard 2.1 (Unity 2022.3's default API
// compatibility level) and works under IL2CPP on Android. If a build
// strips it, add a link.xml preserving System.Net.WebSockets.* (see
// SETUP.md).

using System;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

public class PoseStreamer : MonoBehaviour
{
    [Tooltip("Spectator live map server's WebSocket address, e.g. ws://192.168.1.42:8765 (printed by server.py on startup).")]
    [SerializeField] private string serverAddress = "ws://192.168.1.42:8765";

    [Tooltip("Placement source - provides IsPlaced / CurrentFloorPlan (metersPerPixel + root transform).")]
    [SerializeField] private TapToPlaceFloorPlan placement;

    [Tooltip("The AR camera (XROrigin's Camera). Its position/forward are converted into plan px coords each send.")]
    [SerializeField] private Transform arCamera;

    [Tooltip("Pose messages sent per second while connected and placed.")]
    [SerializeField] private float sendRateHz = 10f;

    [Tooltip("Initial reconnect delay in seconds. Doubles on each consecutive failure up to reconnectDelayMaxSeconds.")]
    [SerializeField] private float reconnectDelayMinSeconds = 1f;
    [SerializeField] private float reconnectDelayMaxSeconds = 15f;

    private ClientWebSocket _socket;
    private CancellationTokenSource _lifetimeCts;
    private volatile bool _connected;
    private bool _sendInFlight;
    private float _sendTimer;
    private float _currentReconnectDelay;

    public bool IsConnected => _connected;

    [Serializable]
    private class RoleMessage
    {
        public string role = "phone";
    }

    [Serializable]
    private class PoseMessage
    {
        public float x;
        public float y;
        public float yaw_deg;
    }

    private void OnEnable()
    {
        _lifetimeCts = new CancellationTokenSource();
        _currentReconnectDelay = reconnectDelayMinSeconds;
        ConnectLoop(_lifetimeCts.Token);
    }

    private void OnDisable()
    {
        _lifetimeCts?.Cancel();
        _lifetimeCts?.Dispose();
        _lifetimeCts = null;

        CloseSocketQuietly();
        _connected = false;
    }

    private void Update()
    {
        if (!_connected) return;
        if (placement == null || !placement.IsPlaced) return; // root-not-placed guard: send nothing yet
        if (arCamera == null) return;

        float interval = sendRateHz > 0f ? 1f / sendRateHz : 0.1f;
        _sendTimer += Time.deltaTime;
        if (_sendTimer < interval) return;
        _sendTimer = 0f;

        if (_sendInFlight) return; // previous send still in flight; drop this tick rather than queueing

        PoseMessage pose = ComputePose();
        if (pose == null) return;

        SendPoseAsync(pose, _lifetimeCts.Token);
    }

    /// <summary>
    /// Converts the AR camera's current pose into plan px coords + yaw
    /// degrees by inverting FloorPlanMeshBuilder.PlanToWorld (see file
    /// header). Returns null if the floorplan instance/metersPerPixel
    /// isn't available yet.
    /// </summary>
    private PoseMessage ComputePose()
    {
        FloorPlanInstance instance = placement.CurrentFloorPlan;
        if (instance == null || instance.MetersPerPixel <= 0f) return null;

        Transform root = instance.transform;
        Vector3 local = root.InverseTransformPoint(arCamera.position);

        float mpp = instance.MetersPerPixel;
        float planX = local.x / mpp;
        float planY = -local.z / mpp;

        Vector3 localForward = root.InverseTransformDirection(arCamera.forward);
        localForward.y = 0f;
        if (localForward.sqrMagnitude < 0.0001f)
        {
            // Camera looking straight up/down: fall back to its "up" axis
            // flattened, same guard MinimapController uses for its marker.
            Vector3 localUp = root.InverseTransformDirection(arCamera.up);
            localUp.y = 0f;
            localForward = localUp.sqrMagnitude < 0.0001f ? Vector3.forward : localUp;
        }
        float yawDeg = Mathf.Atan2(localForward.x, localForward.z) * Mathf.Rad2Deg;

        return new PoseMessage { x = planX, y = planY, yaw_deg = yawDeg };
    }

    private async void ConnectLoop(CancellationToken lifetime)
    {
        while (!lifetime.IsCancellationRequested)
        {
            ClientWebSocket socket = new ClientWebSocket();
            try
            {
                Uri uri = new Uri(serverAddress);
                await socket.ConnectAsync(uri, lifetime);

                _socket = socket;
                _connected = true;
                _currentReconnectDelay = reconnectDelayMinSeconds; // reset backoff on success

                await SendJsonAsync(socket, new RoleMessage(), lifetime);

                // Pump the receive loop just to detect a server-initiated
                // close/error promptly; this app has no use for inbound data.
                byte[] buffer = new byte[256];
                while (!lifetime.IsCancellationRequested && socket.State == WebSocketState.Open)
                {
                    WebSocketReceiveResult result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), lifetime);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                }
            }
            catch (OperationCanceledException)
            {
                // Expected on OnDisable/destroy; fall through to cleanup + exit.
            }
            catch (Exception e)
            {
                Debug.LogWarning($"PoseStreamer: connection error ({e.GetType().Name}: {e.Message}); will retry.");
            }
            finally
            {
                _connected = false;
                if (_socket == socket) _socket = null;
                try { socket.Dispose(); } catch (Exception) { /* already disposed/faulted, ignore */ }
            }

            if (lifetime.IsCancellationRequested) break;

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(_currentReconnectDelay), lifetime);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            _currentReconnectDelay = Mathf.Min(_currentReconnectDelay * 2f, reconnectDelayMaxSeconds);
        }
    }

    private async void SendPoseAsync(PoseMessage pose, CancellationToken lifetime)
    {
        ClientWebSocket socket = _socket;
        if (socket == null) return;
        await SendJsonAsync(socket, pose, lifetime);
    }

    private async Task SendJsonAsync(ClientWebSocket socket, object message, CancellationToken lifetime)
    {
        if (socket == null || socket.State != WebSocketState.Open) return;
        if (_sendInFlight) return;

        _sendInFlight = true;
        try
        {
            string json = JsonUtility.ToJson(message);
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, lifetime);
        }
        catch (OperationCanceledException)
        {
            // Expected during shutdown.
        }
        catch (Exception e)
        {
            Debug.LogWarning($"PoseStreamer: send failed ({e.GetType().Name}: {e.Message}).");
        }
        finally
        {
            _sendInFlight = false;
        }
    }

    private void CloseSocketQuietly()
    {
        ClientWebSocket socket = _socket;
        _socket = null;
        if (socket == null) return;
        try
        {
            // Best-effort abort rather than the graceful CloseAsync
            // handshake: OnDisable/OnDestroy can't await, and a slow or
            // failed close must never block/throw during teardown.
            if (socket.State == WebSocketState.Open || socket.State == WebSocketState.Connecting)
            {
                socket.Abort();
            }
        }
        catch (Exception) { /* ignore - tearing down anyway */ }
        finally
        {
            socket.Dispose();
        }
    }
}
