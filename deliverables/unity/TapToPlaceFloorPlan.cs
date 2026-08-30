// TapToPlaceFloorPlan.cs
//
// On screen tap, raycasts against detected AR planes, creates an anchor at
// the hit pose, and parents the (already-built) floorplan model under that
// anchor. Also exposes SetScaleFromReference, which derives an authoritative
// metersPerPixel from one wall's known real-world length and rescales the
// placed model in place around the anchor.
//
// Requires ARSession + XROrigin with ARPlaneManager, ARRaycastManager and
// ARAnchorManager present in the scene (see SETUP.md for exact hierarchy).

using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;
using FloorPlan;

public class TapToPlaceFloorPlan : MonoBehaviour
{
    [SerializeField] private ARRaycastManager raycastManager;
    [SerializeField] private ARPlaneManager planeManager;
    [SerializeField] private ARAnchorManager anchorManager;

    [Tooltip("If true, ignores taps after the first successful placement. Call ResetPlacement() to allow re-placing.")]
    [SerializeField] private bool placeOnFirstTapOnly = true;

    private static readonly List<ARRaycastHit> Hits = new List<ARRaycastHit>();

    private GameObject _floorPlanRoot;
    private FloorPlanInstance _floorPlanInstance;
    private ARAnchor _currentAnchor;
    private bool _hasPlaced;

    public FloorPlanInstance CurrentFloorPlan => _floorPlanInstance;
    public bool IsPlaced => _hasPlaced;

    /// <summary>
    /// Fired once per successful tap-placement (including re-placements when
    /// placeOnFirstTapOnly is false), after the root has been parented,
    /// activated, and _hasPlaced set. Consumers (e.g. MinimapController via
    /// a small glue subscriber — see SETUP.md's "Minimap setup" section)
    /// can use this to initialize themselves against CurrentFloorPlan
    /// without polling IsPlaced every frame.
    /// </summary>
    public event Action<FloorPlanInstance> OnFloorPlanPlaced;

    /// <summary>
    /// Assigns the mesh built by FloorPlanMeshBuilder.BuildWalls. Call this
    /// once the geometry job is accepted, before the user taps to place it.
    /// The root is hidden until placement.
    /// </summary>
    public void SetFloorPlan(GameObject builtFloorPlanRoot)
    {
        if (_floorPlanRoot != null)
        {
            Destroy(_floorPlanRoot);
        }

        _floorPlanRoot = builtFloorPlanRoot;
        _floorPlanInstance = builtFloorPlanRoot != null ? builtFloorPlanRoot.GetComponent<FloorPlanInstance>() : null;
        _hasPlaced = false;

        if (_floorPlanRoot != null)
        {
            _floorPlanRoot.SetActive(false);
        }
    }

    /// <summary>Allows a new tap-to-place after a previous placement.</summary>
    public void ResetPlacement()
    {
        _hasPlaced = false;
        if (_currentAnchor != null)
        {
            Destroy(_currentAnchor.gameObject);
            _currentAnchor = null;
        }
        if (_floorPlanRoot != null)
        {
            _floorPlanRoot.SetActive(false);
        }
    }

    private void Update()
    {
        if (_floorPlanRoot == null) return;
        if (placeOnFirstTapOnly && _hasPlaced) return;

        Vector2? tapPosition = GetTapScreenPosition();
        if (tapPosition.HasValue)
        {
            TryPlaceAt(tapPosition.Value);
        }
    }

    // Legacy Input Manager touch/mouse handling. If the project's Active
    // Input Handling is set to "Input System Package (New)" only, swap this
    // for UnityEngine.InputSystem.Touchscreen.current / Mouse.current reads.
    private Vector2? GetTapScreenPosition()
    {
        if (Input.touchCount > 0 && Input.GetTouch(0).phase == TouchPhase.Began)
        {
            return Input.GetTouch(0).position;
        }
#if UNITY_EDITOR
        if (Input.GetMouseButtonDown(0))
        {
            return Input.mousePosition;
        }
#endif
        return null;
    }

    private void TryPlaceAt(Vector2 screenPosition)
    {
        if (raycastManager == null || anchorManager == null) return;

        // TrackableType.PlaneWithinPolygon restricts hits to the actual
        // detected plane surface (not its infinite extrapolated plane).
        if (!raycastManager.Raycast(screenPosition, Hits, TrackableType.PlaneWithinPolygon))
        {
            return;
        }

        ARRaycastHit hit = Hits[0];
        ARPlane plane = planeManager != null ? planeManager.GetPlane(hit.trackableId) : null;
        if (plane == null) return;

        // AttachAnchor (AR Foundation 5.x) creates an anchor attached to the
        // plane at the given pose, so it tracks along with the plane's
        // refinement rather than drifting independently.
        ARAnchor anchor = anchorManager.AttachAnchor(plane, hit.pose);
        if (anchor == null) return;

        if (_currentAnchor != null)
        {
            Destroy(_currentAnchor.gameObject);
        }
        _currentAnchor = anchor;

        _floorPlanRoot.transform.SetParent(anchor.transform, worldPositionStays: false);
        // Plan-local origin (pixel 0,0) lands exactly on the anchor/tap point.
        // SetScaleFromReference relies on this being (0,0,0) so scaling stays
        // centered on the anchor.
        _floorPlanRoot.transform.localPosition = Vector3.zero;
        _floorPlanRoot.transform.localRotation = Quaternion.identity;
        _floorPlanRoot.SetActive(true);

        _hasPlaced = true;
        OnFloorPlanPlaced?.Invoke(_floorPlanInstance);
    }

    /// <summary>
    /// Rescales the placed model so that the wall identified by wallId
    /// measures realMeters in the real world, and updates the model's
    /// stored metersPerPixel to match. Scaling is applied to the root's
    /// localScale, which — because the root sits at localPosition zero
    /// under the anchor — scales the whole model around the anchor point
    /// rather than around the plan's bounding-box center.
    /// </summary>
    public bool SetScaleFromReference(string wallId, float realMeters)
    {
        if (_floorPlanInstance == null || _floorPlanInstance.SourceData?.walls == null) return false;
        if (realMeters <= 0f) return false;

        Wall wall = System.Array.Find(_floorPlanInstance.SourceData.walls, w => w.id == wallId);
        if (wall == null) return false;

        float pixelLength = Vector2.Distance(
            new Vector2(wall.start.x, wall.start.y),
            new Vector2(wall.end.x, wall.end.y));
        if (pixelLength <= 0f) return false;

        float newMetersPerPixel = realMeters / pixelLength;
        float scaleFactor = newMetersPerPixel / _floorPlanInstance.MetersPerPixel;

        _floorPlanRoot.transform.localScale *= scaleFactor;
        _floorPlanInstance.MetersPerPixel = newMetersPerPixel;
        return true;
    }
}
