// FloorPlanMeshBuilder.cs
//
// Builds an extruded wall mesh (one box per wall segment) from a parsed
// FloorPlan.JobResponse. Plan coordinates are pixels (size-agnostic); the
// caller supplies metersPerPixel (initially a guess, later replaced once
// the user types a known real-world dimension — see TapToPlaceFloorPlan).
//
// ---- Coordinate mapping & handedness (read before changing the math) ----
// The plan is authored in image space: X right, Y DOWN (origin top-left,
// standard raster convention). Unity's ground plane is XZ with a left-handed
// Y-up basis. Mapping plan (x,y) -> world (x, z) via a DIRECT copy
// (worldX = x, worldZ = y) mirrors the floorplan: walking along a wall that
// turns clockwise in the source image would appear to turn counter-clockwise
// when viewed from above in Unity's default top-down camera setup (+X =
// screen-right, +Z = screen-up). Negating the Y->Z mapping (worldZ = -y)
// preserves turn direction and produces a correctly-handed, non-mirrored
// result. If a specific dataset still looks mirrored on screen, the fix is a
// one-line sign flip here — do not "fix" it by swapping X/Y instead, that
// only rotates the mirror axis rather than removing the mirroring.

using System.Collections.Generic;
using UnityEngine;
using FloorPlan;

/// <summary>
/// Runtime component attached to the GameObject returned by
/// FloorPlanMeshBuilder.BuildWalls. Carries the source data and per-wall
/// GameObject/material bookkeeping needed later for scaling
/// (TapToPlaceFloorPlan.SetScaleFromReference) and wall highlighting
/// (ScaleInputUI).
/// </summary>
public class FloorPlanInstance : MonoBehaviour
{
    public JobResponse SourceData;

    // metersPerPixel this mesh was built at. TapToPlaceFloorPlan rescales the
    // transform relative to this baseline once the user supplies a real
    // dimension, then updates it to the new authoritative value.
    public float MetersPerPixel;

    public readonly List<WallView> Walls = new List<WallView>();

    public struct WallView
    {
        public string Id;
        public GameObject GameObject;
        public Renderer Renderer;
        public Material OriginalMaterial;
    }

    public WallView? FindWall(string wallId)
    {
        for (int i = 0; i < Walls.Count; i++)
        {
            if (Walls[i].Id == wallId) return Walls[i];
        }
        return null;
    }
}

public static class FloorPlanMeshBuilder
{
    /// <summary>
    /// Builds one box mesh per wall segment from the given geometry.
    /// Returns a parent GameObject (with a FloorPlanInstance component)
    /// containing all wall children, positioned at plan-local origin (0,0,0)
    /// so it can be parented directly under an AR anchor with
    /// localPosition = Vector3.zero.
    /// </summary>
    public static GameObject BuildWalls(JobResponse data, float metersPerPixel, float wallHeightMeters, Material mat)
    {
        var root = new GameObject("FloorPlanRoot");
        var instance = root.AddComponent<FloorPlanInstance>();
        instance.SourceData = data;
        instance.MetersPerPixel = metersPerPixel;

        if (data?.walls == null) return root;

        foreach (Wall wall in data.walls)
        {
            GameObject wallGo = BuildSingleWall(wall, metersPerPixel, wallHeightMeters, mat);
            wallGo.transform.SetParent(root.transform, worldPositionStays: false);

            var renderer = wallGo.GetComponent<Renderer>();
            instance.Walls.Add(new FloorPlanInstance.WallView
            {
                Id = wall.id,
                GameObject = wallGo,
                Renderer = renderer,
                OriginalMaterial = renderer != null ? renderer.sharedMaterial : null
            });
        }

        return root;
    }

    private static GameObject BuildSingleWall(Wall wall, float metersPerPixel, float defaultHeightMeters, Material mat)
    {
        Vector3 startWorld = PlanToWorld(wall.start, metersPerPixel);
        Vector3 endWorld = PlanToWorld(wall.end, metersPerPixel);

        Vector3 delta = endWorld - startWorld;
        float length = delta.magnitude;
        if (length < 0.0001f) length = 0.0001f; // degenerate zero-length wall guard

        float heightMeters = wall.height > 0f ? wall.height : defaultHeightMeters;
        float thicknessMeters = wall.GetThicknessMeters(metersPerPixel);
        if (thicknessMeters <= 0f) thicknessMeters = 0.1f; // sane fallback for malformed data

        GameObject go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.name = string.IsNullOrEmpty(wall.id) ? "Wall" : wall.id;

        // Unity's primitive cube is 1x1x1 centered on origin, local Z = "length"
        // axis once rotated to face `delta`. Scale: X = thickness, Y = height, Z = length.
        go.transform.localScale = new Vector3(thicknessMeters, heightMeters, length);

        // Position at the wall's midpoint, resting on the ground (y=0) with
        // its center raised to half the wall height.
        Vector3 midpoint = (startWorld + endWorld) * 0.5f;
        go.transform.position = new Vector3(midpoint.x, heightMeters * 0.5f, midpoint.z);

        // Orient the box's local +Z (its "length" axis after scaling) along `delta`.
        go.transform.rotation = Quaternion.LookRotation(delta.normalized, Vector3.up);

        if (mat != null)
        {
            go.GetComponent<Renderer>().sharedMaterial = mat;
        }

        return go;
    }

    /// <summary>
    /// Converts a plan-space pixel point to a local-space world point on the
    /// XZ ground plane. See file header for why Y is negated when mapped to Z.
    /// </summary>
    private static Vector3 PlanToWorld(Point2D p, float metersPerPixel)
    {
        return new Vector3(p.x * metersPerPixel, 0f, -p.y * metersPerPixel);
    }
}
