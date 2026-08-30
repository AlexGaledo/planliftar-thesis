// FloorPlanApiClient.cs
//
// Coroutine-based REST client for the async floorplan job pattern:
//   POST {baseUrl}/plans           (multipart image upload) -> { job_id }
//   GET  {baseUrl}/plans/{jobId}   (poll every ~2s) -> JobResponse
//
// Also provides LoadFromStreamingAssets for offline dev/testing without a
// live backend (e.g. iterating on FloorPlanMeshBuilder / placement without
// network access).

using System;
using System.Collections;
using System.IO;
using UnityEngine;
using UnityEngine.Networking;
using FloorPlan;

public class FloorPlanApiClient : MonoBehaviour
{
    [Tooltip("e.g. https://api.example.com — no trailing slash")]
    [SerializeField] private string baseUrl = "https://api.example.com";

    [Tooltip("Seconds between poll attempts while a job is pending/processing.")]
    [SerializeField] private float pollIntervalSeconds = 2f;

    [Tooltip("Filename under StreamingAssets used by LoadFromStreamingAssets.")]
    [SerializeField] private string offlineSampleFileName = "sample_response.json";

    private Coroutine _pollRoutine;

    /// <summary>
    /// Uploads a plan photo as multipart/form-data and reports the created job id.
    /// </summary>
    public void UploadPlan(Texture2D image, Action<string> onJobId, Action<string> onError)
    {
        StartCoroutine(UploadPlanRoutine(image, onJobId, onError));
    }

    private IEnumerator UploadPlanRoutine(Texture2D image, Action<string> onJobId, Action<string> onError)
    {
        // Texture2D must be readable (Read/Write Enabled in import settings,
        // or produced at runtime e.g. from camera capture) for EncodeToPNG.
        byte[] pngBytes = ImageConversion.EncodeToPNG(image);
        if (pngBytes == null || pngBytes.Length == 0)
        {
            onError?.Invoke("Failed to encode image (is the Texture2D readable?).");
            yield break;
        }

        var form = new WWWForm();
        form.AddBinaryData("image", pngBytes, "plan.png", "image/png");

        using (UnityWebRequest req = UnityWebRequest.Post($"{baseUrl}/plans", form))
        {
            yield return req.SendWebRequest();

            if (req.result != UnityWebRequest.Result.Success)
            {
                onError?.Invoke($"Upload failed: {req.error} ({req.responseCode})");
                yield break;
            }

            UploadResponse parsed;
            try
            {
                parsed = JsonUtility.FromJson<UploadResponse>(req.downloadHandler.text);
            }
            catch (Exception e)
            {
                onError?.Invoke($"Upload response parse error: {e.Message}");
                yield break;
            }

            if (string.IsNullOrEmpty(parsed?.job_id))
            {
                onError?.Invoke("Upload response missing job_id.");
                yield break;
            }

            onJobId?.Invoke(parsed.job_id);
        }
    }

    /// <summary>
    /// Polls GET {baseUrl}/plans/{jobId} every pollIntervalSeconds until the
    /// job resolves to accepted or rejected, then stops. Call StopPolling()
    /// to cancel early (e.g. if the user backs out of the flow).
    /// </summary>
    public void PollJob(string jobId, Action<JobResponse> onAccepted, Action<string[]> onRejected, Action<string> onError)
    {
        StopPolling();
        _pollRoutine = StartCoroutine(PollJobRoutine(jobId, onAccepted, onRejected, onError));
    }

    public void StopPolling()
    {
        if (_pollRoutine != null)
        {
            StopCoroutine(_pollRoutine);
            _pollRoutine = null;
        }
    }

    private IEnumerator PollJobRoutine(string jobId, Action<JobResponse> onAccepted, Action<string[]> onRejected, Action<string> onError)
    {
        var wait = new WaitForSeconds(pollIntervalSeconds);

        while (true)
        {
            using (UnityWebRequest req = UnityWebRequest.Get($"{baseUrl}/plans/{jobId}"))
            {
                yield return req.SendWebRequest();

                if (req.result != UnityWebRequest.Result.Success)
                {
                    onError?.Invoke($"Poll failed: {req.error} ({req.responseCode})");
                    yield break;
                }

                JobResponse parsed;
                try
                {
                    parsed = JsonUtility.FromJson<JobResponse>(req.downloadHandler.text);
                }
                catch (Exception e)
                {
                    onError?.Invoke($"Poll response parse error: {e.Message}");
                    yield break;
                }

                if (parsed == null)
                {
                    onError?.Invoke("Poll response was empty/unparseable.");
                    yield break;
                }

                if (parsed.IsAccepted)
                {
                    onAccepted?.Invoke(parsed);
                    yield break;
                }

                if (parsed.IsRejected)
                {
                    onRejected?.Invoke(parsed.reject_reasons ?? Array.Empty<string>());
                    yield break;
                }

                // status is "pending"/"processing"/anything else -> keep polling.
            }

            yield return wait;
        }
    }

    /// <summary>
    /// Offline dev fallback: loads a JobResponse from
    /// Application.streamingAssetsPath/offlineSampleFileName instead of the
    /// network. Uses UnityWebRequest rather than File.ReadAllText because on
    /// Android, StreamingAssets lives inside the compressed APK/AAB and is
    /// not a normal filesystem path — UnityWebRequest (with a file:// or
    /// jar:file:// URI depending on platform) is the only reliable way to
    /// read it on-device.
    /// </summary>
    public void LoadFromStreamingAssets(Action<JobResponse> onLoaded, Action<string> onError)
    {
        StartCoroutine(LoadFromStreamingAssetsRoutine(onLoaded, onError));
    }

    private IEnumerator LoadFromStreamingAssetsRoutine(Action<JobResponse> onLoaded, Action<string> onError)
    {
        string path = Path.Combine(Application.streamingAssetsPath, offlineSampleFileName);

        using (UnityWebRequest req = UnityWebRequest.Get(path))
        {
            yield return req.SendWebRequest();

            if (req.result != UnityWebRequest.Result.Success)
            {
                onError?.Invoke($"Failed to load offline sample: {req.error}");
                yield break;
            }

            JobResponse parsed;
            try
            {
                parsed = JsonUtility.FromJson<JobResponse>(req.downloadHandler.text);
            }
            catch (Exception e)
            {
                onError?.Invoke($"Offline sample parse error: {e.Message}");
                yield break;
            }

            if (parsed == null || (parsed.walls == null && parsed.status != "rejected"))
            {
                onError?.Invoke("Offline sample parsed but contained no usable geometry.");
                yield break;
            }

            // The sample_response.json fixture (see reference/wall-test-out/)
            // has no "status" field at all, since it represents the raw
            // accepted geometry payload rather than a full job envelope.
            // Treat a missing status as implicitly accepted when walls are present.
            if (string.IsNullOrEmpty(parsed.status) && parsed.walls != null && parsed.walls.Length > 0)
            {
                parsed.status = "accepted";
            }

            onLoaded?.Invoke(parsed);
        }
    }
}
