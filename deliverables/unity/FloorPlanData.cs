// FloorPlanData.cs
//
// [Serializable] DTOs mirroring the floorplan geometry JSON schema
// (see reference/wall-test-out/sample_response.json) for use with Unity's
// JsonUtility (JsonUtility.FromJson<FloorPlanData.JobResponse>(json)).
//
// ---- JsonUtility limitations & workarounds (read before editing) ----
//
// 1. NO POLYMORPHISM / DISCRIMINATED UNIONS.
//    The backend's async job GET returns one of two differently-shaped
//    payloads depending on "status":
//      accepted: { "status": "accepted", metadata, walls, rooms, fixtures }
//      rejected: { "status": "rejected", "reject_reasons": [...] }
//    JsonUtility cannot deserialize into a union/base-class hierarchy based
//    on a discriminator field. The workaround is JobResponse below: a single
//    FLAT class declaring every field from both shapes. Fields absent from
//    whichever variant was actually returned simply stay at their C# default
//    (null for arrays/objects, 0 for numbers). Callers must branch on
//    `status` (IsAccepted / IsRejected helpers) rather than relying on which
//    fields are populated.
//
// 2. NO WAY TO DISTINGUISH "FIELD ABSENT" FROM "FIELD IS DEFAULT VALUE".
//    The schema note "thickness_px or thickness" implies a wall may carry
//    either a pixel thickness (needs conversion via metersPerPixel) or an
//    already-real-world thickness in meters (as seen in the sample data,
//    e.g. wall_001.thickness = 0.1). JsonUtility gives no "was this present"
//    flag, so Wall.GetThicknessMeters() below uses a convention: if
//    `thickness` (meters) is > 0, use it directly; otherwise fall back to
//    `thickness_px * metersPerPixel`. This assumes a wall never legitimately
//    has zero thickness, which holds for real wall geometry.
//
// 3. JsonUtility.FromJson requires the JSON ROOT to be an object, never a
//    bare array. The schema's root is always an object, so this is fine,
//    but note it means you cannot JsonUtility.FromJson a raw `[...]` job
//    list response — it would need to be wrapped, e.g. via a helper that
//    injects a synthetic `{"items":[...]}` envelope before parsing.
//
// 4. Only PUBLIC FIELDS are serialized (no properties, no {get;set;} auto-
//    props, no private fields even with [SerializeField] outside
//    MonoBehaviour/ScriptableObject contexts for plain data classes used
//    with JsonUtility directly). All DTO members below are public fields.
//
// 5. Unknown JSON fields are silently ignored (forward-compatible: the
//    backend can add new fields without breaking these DTOs), but conversely
//    JsonUtility does NOT error on missing required fields either — malformed
//    or truncated responses will parse "successfully" with zeroed-out data.
//    Callers polling the job endpoint should sanity-check (e.g. walls.Length
//    > 0 for an accepted response) before trusting the result.
//
// 6. Custom Point2D (not UnityEngine.Vector2) is used for {x,y} pairs.
//    Vector2 WOULD technically parse fine here (its fields are also named
//    x/y and JsonUtility does special-case Vector2/Vector3), but keeping a
//    plain DTO type decouples the wire schema from a Unity engine type and
//    avoids surprises if the schema ever adds a "z" or other sibling field.

using System;

namespace FloorPlan
{
    [Serializable]
    public class Point2D
    {
        public float x;
        public float y;
    }

    [Serializable]
    public class Wall
    {
        public string id;
        public Point2D start;
        public Point2D end;

        // Real-world thickness in meters, when the backend already knows scale.
        public float thickness;

        // Pixel-space thickness, used when the backend has not computed a
        // real-world scale yet. See class header note (2) for the fallback rule.
        public float thickness_px;

        // Wall height in meters (sample data always populates this; extruded
        // mesh falls back to the caller-supplied default wallHeightMeters if 0).
        public float height;

        /// <summary>
        /// Resolves wall thickness to meters regardless of which of the two
        /// schema variants (thickness vs thickness_px) the backend populated.
        /// </summary>
        public float GetThicknessMeters(float metersPerPixel)
        {
            if (thickness > 0f) return thickness;
            return thickness_px * metersPerPixel;
        }
    }

    [Serializable]
    public class Room
    {
        public string id;
        public string type;
        public Point2D[] polygon;
    }

    [Serializable]
    public class FixtureScale
    {
        public float width;
        public float depth;
        public float height;
    }

    [Serializable]
    public class Fixture
    {
        public string id;
        public string type; // "door" | "window"
        public Point2D position;
        public FixtureScale scale;
        public float rotation_degrees;
    }

    [Serializable]
    public class Metadata
    {
        public float original_width_px;
        public float original_height_px;

        // Backend's own rough px->m estimate. NOT used for final placement
        // scale — the app derives an authoritative metersPerPixel from the
        // user's typed reference dimension instead (see
        // TapToPlaceFloorPlan.SetScaleFromReference). Kept here only for
        // debugging / sanity-checking the user's input against expectations.
        public float pixel_to_meter_ratio;
    }

    /// <summary>
    /// Flattened response for GET {baseUrl}/plans/{id}.
    /// See class header note (1) for why this single class covers both the
    /// accepted and rejected response shapes.
    /// </summary>
    [Serializable]
    public class JobResponse
    {
        public string status; // "pending" | "processing" | "accepted" | "rejected"

        // Populated only when status == "rejected".
        public string[] reject_reasons;

        // Populated only when status == "accepted".
        public Metadata metadata;
        public Wall[] walls;
        public Room[] rooms;
        public Fixture[] fixtures;

        public bool IsAccepted => status == "accepted";
        public bool IsRejected => status == "rejected";
        public bool IsPending => !IsAccepted && !IsRejected;
    }

    /// <summary>
    /// Response for POST {baseUrl}/plans (job creation).
    /// ASSUMPTION: the backend returns {"job_id": "..."}. Adjust the field
    /// name here if the real API uses "id" or "jobId" instead — this is the
    /// one field in this file not confirmed against a sample payload.
    /// </summary>
    [Serializable]
    public class UploadResponse
    {
        public string job_id;
    }
}
