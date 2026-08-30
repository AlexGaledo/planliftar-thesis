// MinimapController.cs
//
// Game-style bird's-eye minimap for the placed floorplan. Owns a dedicated
// orthographic camera that renders only the "Minimap" layer to a
// RenderTexture (consumed by MinimapUI's RawImage), plus a small heading
// marker that tracks the AR camera's position/yaw projected onto the
// floorplan's ground plane.
//
// ---- Wall-rendering approach (read before changing) ----
// Walls are NOT cloned for the minimap. On Initialize, every wall GameObject
// under the placed FloorPlanInstance is reassigned (recursively) to the
// "Minimap" layer. The minimap camera's culling mask is set to render ONLY
// that layer. The main AR camera keeps its default culling mask of
// "Everything", which already includes the Minimap layer, so the exact same
// mesh instances are drawn by both cameras in the same frame at zero extra
// memory/CPU cost beyond one additional camera render pass. The only
// requirement this places on the rest of the scene: the main camera's
// culling mask must NOT be narrowed to exclude the "Minimap" layer (see
// SETUP.md). This is strictly cheaper than cloning wall meshes/materials
// onto a parallel minimap-only hierarchy, and it keeps wall highlighting
// (ScaleInputUI swaps Renderer.sharedMaterial) working identically on both
// cameras, since there is still only one renderer per wall.
//
// ---- Player marker coordinate space (read before changing) ----
// The marker GameObject is parented under the *placed* FloorPlanInstance's
// transform (the same root TapToPlaceFloorPlan scales/repositions). Every
// frame its localPosition/localRotation are recomputed from the AR camera's
// current *world* pose via root.InverseTransformPoint / Quaternion.Inverse
// (root.rotation), so the marker's minimap position stays correct
// regardless of root scale changes (TapToPlaceFloorPlan.SetScaleFromReference)
// or the anchor drifting as AR plane tracking refines — nothing here caches
// a world-space assumption across frames.
//
// The minimap camera itself is intentionally NOT parented to the floorplan
// root: parenting an orthographic camera under a rescale-able transform
// would scale its apparent field of view along with the model, which is not
// what an auto-fit "static full map" view wants. Instead its world position
// and orthographic size are recomputed from the root's current world-space
// wall-renderer bounds (see RefreshFraming).

using UnityEngine;

[DisallowMultipleComponent]
public class MinimapController : MonoBehaviour
{
    [Header("Minimap camera")]
    [Tooltip("Optional: assign a pre-configured camera in the scene. If left empty, one is created at runtime as a child of this GameObject.")]
    [SerializeField] private Camera minimapCamera;

    [Tooltip("Optional: assign a RenderTexture asset. If left empty, one is created at runtime (and released in OnDestroy).")]
    [SerializeField] private RenderTexture renderTexture;
    [SerializeField] private int renderTextureSize = 512;

    [Tooltip("Layer used exclusively for minimap-visible geometry. Must exist in Project Settings > Tags and Layers (see SETUP.md).")]
    [SerializeField] private string minimapLayerName = "Minimap";

    [SerializeField] private Color backgroundColor = new Color(0.05f, 0.05f, 0.05f, 1f);

    [Tooltip("Extra camera height above the floorplan's highest point, in world meters.")]
    [SerializeField] private float cameraHeightMeters = 10f;

    [Range(0f, 0.5f)]
    [Tooltip("Fractional margin added around the auto-fit bounds (0.1 = 10%, per spec).")]
    [SerializeField] private float boundsMarginFraction = 0.1f;

    [Tooltip("How often (seconds) the auto-fit bounds/orthographic size are recomputed from wall renderers while in full-map mode. 0 = every frame.")]
    [SerializeField] private float framingRefreshInterval = 0.5f;

    [Header("Follow mode")]
    [Tooltip("If true, the camera centers on and zooms to the player marker instead of showing the whole map.")]
    [SerializeField] private bool followPlayer = false;
    [Tooltip("Orthographic half-size, in meters, used around the player when followPlayer is true.")]
    [SerializeField] private float followZoomRadiusMeters = 5f;

    [Header("Player marker")]
    [Tooltip("Optional: material for the marker mesh. If left empty, a runtime Sprites/Default material tinted playerMarkerColor is used (dev fallback — assign a real material for production, see SETUP.md).")]
    [SerializeField] private Material playerMarkerMaterial;
    [SerializeField] private Color playerMarkerColor = Color.red;
    [SerializeField] private float playerMarkerSizeMeters = 0.5f;
    [Tooltip("Marker height in the root's LOCAL space, so it sits just above the wall tops (which are built at local y up to wall height) without z-fighting, independent of root scale.")]
    [SerializeField] private float playerMarkerLocalHeight = 0.05f;

    private FloorPlanInstance _instance;
    private Transform _arCamera;
    private Transform _root;
    private GameObject _markerGo;
    private bool _initialized;
    private bool _visible;
    private bool _ownsRenderTexture;
    private float _framingTimer;
    private int _minimapLayer = -1;

    public RenderTexture MinimapTexture => renderTexture;
    public bool IsInitialized => _initialized;

    public bool FollowPlayer
    {
        get => followPlayer;
        set => followPlayer = value;
    }

    /// <summary>Explicit setter for UI buttons (see MinimapUI).</summary>
    public void SetFollowMode(bool follow) => followPlayer = follow;

    /// <summary>Toggle helper for a single UI button (see MinimapUI).</summary>
    public void ToggleFollowMode() => followPlayer = !followPlayer;

    private void Awake()
    {
        // Nothing to show until Initialize() is called — see file-level
        // "not-yet-placed" handling requirement.
        if (minimapCamera != null)
        {
            minimapCamera.gameObject.SetActive(false);
        }
    }

    /// <summary>
    /// Wires the minimap up to a just-placed floorplan and the AR camera.
    /// Safe to call again after a re-placement — tears down the previous
    /// marker first, then re-layers/re-frames against the new instance.
    /// </summary>
    public void Initialize(FloorPlanInstance instance, Transform arCamera)
    {
        if (instance == null || arCamera == null)
        {
            Debug.LogWarning("MinimapController.Initialize called with a null instance or arCamera; ignoring.");
            return;
        }

        _minimapLayer = LayerMask.NameToLayer(minimapLayerName);
        if (_minimapLayer < 0)
        {
            Debug.LogError($"MinimapController: layer \"{minimapLayerName}\" does not exist. " +
                            "Add it under Project Settings > Tags and Layers (see SETUP.md). The minimap camera will render nothing.");
        }

        TearDownMarker();

        _instance = instance;
        _arCamera = arCamera;
        _root = instance.transform;

        AssignMinimapLayerRecursive(_root, _minimapLayer);
        EnsureCamera();
        EnsureRenderTexture();
        EnsureMarker();

        _initialized = true;
        _framingTimer = 0f;
        RefreshFraming();
        ShowMap(true);
    }

    /// <summary>Shows/hides the minimap camera and marker. No-op before Initialize.</summary>
    public void ShowMap(bool show)
    {
        _visible = show && _initialized;
        if (minimapCamera != null) minimapCamera.gameObject.SetActive(_visible);
        if (_markerGo != null) _markerGo.SetActive(_visible);
    }

    /// <summary>
    /// Forces an immediate bounds/orthographic-size recompute (full-map
    /// mode only). Called automatically on Initialize and periodically from
    /// LateUpdate; exposed publicly in case a caller wants to sync it right
    /// after e.g. TapToPlaceFloorPlan.SetScaleFromReference instead of
    /// waiting up to framingRefreshInterval seconds.
    /// </summary>
    public void RefreshFraming()
    {
        if (minimapCamera == null || _root == null) return;

        Bounds bounds = ComputeWorldBounds();
        Vector3 center = bounds.center;
        float maxExtent = Mathf.Max(bounds.extents.x, bounds.extents.z, 0.01f);
        float orthoSize = maxExtent * (1f + boundsMarginFraction);

        minimapCamera.orthographicSize = orthoSize;
        minimapCamera.transform.position = new Vector3(center.x, bounds.max.y + cameraHeightMeters, center.z);
        // Straight down, with world +Z reading as "up" on the minimap — the
        // same top-down convention FloorPlanMeshBuilder's plan->world
        // mapping assumes (see that file's header comment).
        minimapCamera.transform.rotation = Quaternion.Euler(90f, 0f, 0f);
    }

    private void OnDestroy()
    {
        TearDownMarker();
        if (_ownsRenderTexture && renderTexture != null)
        {
            renderTexture.Release();
        }
    }

    private void TearDownMarker()
    {
        if (_markerGo != null)
        {
            Destroy(_markerGo);
            _markerGo = null;
        }
        _initialized = false;
    }

    private void LateUpdate()
    {
        if (!_initialized || !_visible || _root == null || _arCamera == null) return;

        UpdatePlayerMarker();

        if (followPlayer)
        {
            UpdateFollowCamera();
        }
        else
        {
            _framingTimer -= Time.deltaTime;
            if (_framingTimer <= 0f)
            {
                RefreshFraming();
                _framingTimer = framingRefreshInterval;
            }
        }
    }

    private void UpdatePlayerMarker()
    {
        if (_markerGo == null) return;

        // Project the AR camera's world position into the root's local
        // space so the marker tracks correctly even if the root has been
        // rescaled/moved since Initialize (see file header).
        Vector3 local = _root.InverseTransformPoint(_arCamera.position);
        local.y = playerMarkerLocalHeight;
        _markerGo.transform.localPosition = local;

        // Yaw-only heading: flatten the AR camera's forward vector onto the
        // world XZ plane, then express it relative to the root's current
        // world rotation, so the marker's resulting *world*-space facing
        // (what the straight-down minimap camera actually sees) matches the
        // real heading regardless of any small tilt in the placed
        // root/anchor.
        Vector3 flatForward = _arCamera.forward;
        flatForward.y = 0f;
        if (flatForward.sqrMagnitude < 0.0001f)
        {
            // Camera is looking straight up/down (rare, but guards
            // LookRotation against a zero vector) — fall back to its "up"
            // axis flattened instead.
            flatForward = _arCamera.up;
            flatForward.y = 0f;
        }
        if (flatForward.sqrMagnitude < 0.0001f) flatForward = Vector3.forward;

        Quaternion worldYaw = Quaternion.LookRotation(flatForward.normalized, Vector3.up);
        _markerGo.transform.localRotation = Quaternion.Inverse(_root.rotation) * worldYaw;
    }

    private void UpdateFollowCamera()
    {
        if (minimapCamera == null || _markerGo == null) return;

        Vector3 playerWorldPos = _markerGo.transform.position;
        minimapCamera.orthographicSize = Mathf.Max(followZoomRadiusMeters, 0.1f);
        minimapCamera.transform.position = new Vector3(playerWorldPos.x, playerWorldPos.y + cameraHeightMeters, playerWorldPos.z);
        minimapCamera.transform.rotation = Quaternion.Euler(90f, 0f, 0f);
    }

    private Bounds ComputeWorldBounds()
    {
        bool hasBounds = false;
        Bounds bounds = new Bounds(_root.position, Vector3.zero);

        if (_instance != null && _instance.Walls.Count > 0)
        {
            foreach (var wall in _instance.Walls)
            {
                if (wall.Renderer == null) continue;
                if (!hasBounds)
                {
                    bounds = wall.Renderer.bounds;
                    hasBounds = true;
                }
                else
                {
                    bounds.Encapsulate(wall.Renderer.bounds);
                }
            }
        }

        if (!hasBounds)
        {
            // Degenerate/empty floorplan (e.g. zero walls) — fall back to a
            // small area around the root so the camera still gets a sane
            // orthographic size instead of zero.
            bounds = new Bounds(_root.position, new Vector3(1f, 1f, 1f));
        }

        return bounds;
    }

    private void EnsureCamera()
    {
        if (minimapCamera == null)
        {
            var camGo = new GameObject("MinimapCamera");
            camGo.transform.SetParent(transform, worldPositionStays: false);
            minimapCamera = camGo.AddComponent<Camera>();
        }

        minimapCamera.orthographic = true;
        minimapCamera.clearFlags = CameraClearFlags.SolidColor;
        minimapCamera.backgroundColor = backgroundColor;
        minimapCamera.cullingMask = _minimapLayer >= 0 ? (1 << _minimapLayer) : 0;
        minimapCamera.nearClipPlane = 0.1f;
        minimapCamera.farClipPlane = cameraHeightMeters * 4f + 10f; // generous headroom above the tallest wall
        minimapCamera.depth = -10;
        minimapCamera.allowHDR = false;
        minimapCamera.allowMSAA = false;
    }

    private void EnsureRenderTexture()
    {
        if (renderTexture == null)
        {
            renderTexture = new RenderTexture(renderTextureSize, renderTextureSize, 16, RenderTextureFormat.ARGB32)
            {
                name = "MinimapRenderTexture",
                useMipMap = false,
                autoGenerateMips = false
            };
            renderTexture.Create();
            _ownsRenderTexture = true;
        }

        minimapCamera.targetTexture = renderTexture;
    }

    private void EnsureMarker()
    {
        if (_markerGo == null)
        {
            _markerGo = new GameObject("MinimapPlayerMarker");
            var meshFilter = _markerGo.AddComponent<MeshFilter>();
            var meshRenderer = _markerGo.AddComponent<MeshRenderer>();
            meshFilter.sharedMesh = BuildMarkerTriangleMesh(playerMarkerSizeMeters);
            meshRenderer.sharedMaterial = ResolveMarkerMaterial();
            meshRenderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            meshRenderer.receiveShadows = false;
        }

        _markerGo.layer = _minimapLayer >= 0 ? _minimapLayer : _markerGo.layer;
        _markerGo.transform.SetParent(_root, worldPositionStays: false);
    }

    private Material ResolveMarkerMaterial()
    {
        if (playerMarkerMaterial != null) return playerMarkerMaterial;

        // Dev/testing fallback so the scaffold renders something without a
        // material asset assigned. "Sprites/Default" ships with the default
        // resources of both the Built-in and URP render pipelines (unlike
        // e.g. "Unlit/Color", which is Built-in-only and may be stripped
        // from a URP build). For production, assign playerMarkerMaterial
        // explicitly (see SETUP.md).
        Shader shader = Shader.Find("Sprites/Default");
        var mat = new Material(shader != null ? shader : Shader.Find("Standard"));
        mat.color = playerMarkerColor;
        return mat;
    }

    /// <summary>
    /// Builds a small flat isoceles-triangle mesh on the local XZ plane,
    /// pointing toward local +Z ("forward" = 0 deg heading). Two
    /// opposite-winding faces are emitted so the triangle is visible from
    /// directly above regardless of the active pipeline's default culling,
    /// without depending on a "Cull Off" material setting.
    /// </summary>
    private static Mesh BuildMarkerTriangleMesh(float size)
    {
        float half = size * 0.5f;
        Vector3 tip = new Vector3(0f, 0f, size);
        Vector3 left = new Vector3(-half, 0f, -half);
        Vector3 right = new Vector3(half, 0f, -half);

        var mesh = new Mesh { name = "MinimapMarkerTriangle" };
        mesh.vertices = new[] { tip, left, right };
        mesh.triangles = new[]
        {
            0, 1, 2,
            0, 2, 1
        };
        mesh.RecalculateNormals();
        mesh.RecalculateBounds();
        return mesh;
    }

    /// <summary>
    /// Recursively reassigns a GameObject and all its children to `layer`.
    /// Used once on the floorplan root at Initialize time (see file header
    /// for why this — not mesh cloning — is the chosen rendering approach).
    /// </summary>
    private static void AssignMinimapLayerRecursive(Transform root, int layer)
    {
        if (layer < 0) return; // missing layer already logged in Initialize; skip silently here
        root.gameObject.layer = layer;
        foreach (Transform child in root)
        {
            AssignMinimapLayerRecursive(child, layer);
        }
    }
}
