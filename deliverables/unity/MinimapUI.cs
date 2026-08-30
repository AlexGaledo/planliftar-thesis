// MinimapUI.cs
//
// Minimal uGUI wrapper that displays MinimapController's RenderTexture in a
// screen corner and exposes a toggle button for full-map vs. follow mode.
//
// Uses legacy UnityEngine.UI (RawImage/Button/Text) rather than TextMeshPro,
// matching ScaleInputUI.cs's convention so the scene has no extra
// package/TMP-Essentials-import dependency.
//
// ---- Wire-up ----
// 1. Add a Canvas (Screen Space - Overlay) to the scene if one doesn't
//    already exist (the existing Canvas from ScaleInputUI's setup works
//    fine — see SETUP.md).
// 2. Add a RawImage child, e.g. "MinimapRawImage". Anchor/size it however
//    you like in the editor; this script repositions it to `cornerAnchor`
//    at runtime via anchorMin/anchorMax/pivot, so the editor-time rect only
//    needs to set the desired on-screen SIZE (sizeDelta) — layout position
//    is driven by `cornerAnchor`/`marginPixels`/`sizePixels` below instead.
// 3. Optional circular/rounded minimap: add a UI Mask or RectMask2D
//    component (plus a mask sprite/Image, for UI.Mask) to the RawImage
//    GameObject or a parent of it, then assign that component to
//    `maskComponent` and check `useMask`. This script only flips the
//    component's `enabled` flag — it does not create the mask sprite/shape
//    itself, since that needs an image asset outside this C#-only scaffold.
// 4. Add a Button ("MinimapModeToggle") anywhere on the Canvas for the
//    full-map/follow toggle. Optionally give it a child Text label and
//    assign it to `toggleButtonLabel` so the label updates automatically.
// 5. Assign references in the inspector:
//      minimapController  -> the scene's MinimapController
//      rawImage           -> the RawImage from step 2
//      toggleButton       -> the Button from step 4
//      maskComponent       -> (optional) the Mask/RectMask2D from step 3
//      toggleButtonLabel   -> (optional) the toggle button's child Text
// 6. This script hides the RawImage until MinimapController.IsInitialized
//    is true (i.e. until TapToPlaceFloorPlan's placement fires and
//    MinimapController.Initialize runs — see SETUP.md's "Minimap setup"
//    section for the exact hook), and keeps rawImage.texture pointed at
//    minimapController.MinimapTexture from then on.

using UnityEngine;
using UnityEngine.UI;

public class MinimapUI : MonoBehaviour
{
    public enum Corner { TopLeft, TopRight, BottomLeft, BottomRight }

    [SerializeField] private MinimapController minimapController;
    [SerializeField] private RawImage rawImage;
    [SerializeField] private Button toggleButton;

    [Header("Layout")]
    [SerializeField] private Corner cornerAnchor = Corner.TopRight;
    [SerializeField] private Vector2 marginPixels = new Vector2(20f, 20f);
    [SerializeField] private Vector2 sizePixels = new Vector2(220f, 220f);

    [Header("Mask (optional)")]
    [Tooltip("If true and maskComponent is assigned, enables it so the RawImage renders as a circle/rounded-rect instead of a square. See header comment step 3 for how to set up the mask asset itself.")]
    [SerializeField] private bool useMask = false;
    [SerializeField] private Behaviour maskComponent; // e.g. UnityEngine.UI.Mask or RectMask2D

    [Header("Toggle button label (optional)")]
    [SerializeField] private Text toggleButtonLabel;
    [SerializeField] private string fullMapLabel = "Full Map";
    [SerializeField] private string followLabel = "Follow";

    private void Awake()
    {
        ApplyCornerAnchor();

        if (maskComponent != null)
        {
            maskComponent.enabled = useMask;
        }

        if (toggleButton != null)
        {
            toggleButton.onClick.AddListener(OnToggleClicked);
        }

        RefreshToggleLabel();

        // Hidden until MinimapController.Initialize runs — see wire-up
        // step 6 and MinimapController's own "not-yet-placed" handling.
        if (rawImage != null)
        {
            rawImage.gameObject.SetActive(false);
        }
    }

    private void OnDestroy()
    {
        if (toggleButton != null)
        {
            toggleButton.onClick.RemoveListener(OnToggleClicked);
        }
    }

    private void Update()
    {
        if (rawImage == null || minimapController == null) return;

        bool ready = minimapController.IsInitialized;
        if (rawImage.gameObject.activeSelf != ready)
        {
            rawImage.gameObject.SetActive(ready);
        }
        if (ready && rawImage.texture != minimapController.MinimapTexture)
        {
            rawImage.texture = minimapController.MinimapTexture;
        }
    }

    private void OnToggleClicked()
    {
        if (minimapController == null) return;
        minimapController.ToggleFollowMode();
        RefreshToggleLabel();
    }

    private void RefreshToggleLabel()
    {
        if (toggleButtonLabel == null || minimapController == null) return;
        toggleButtonLabel.text = minimapController.FollowPlayer ? followLabel : fullMapLabel;
    }

    /// <summary>
    /// Positions the RawImage's RectTransform in the chosen screen corner.
    /// Anchors are set to a single point (not stretched), so `sizePixels`
    /// fully determines the on-screen size regardless of Canvas resolution.
    /// </summary>
    private void ApplyCornerAnchor()
    {
        if (rawImage == null) return;
        RectTransform rt = rawImage.rectTransform;

        Vector2 anchor;
        Vector2 signedMargin;
        switch (cornerAnchor)
        {
            case Corner.TopLeft:
                anchor = new Vector2(0f, 1f);
                signedMargin = new Vector2(marginPixels.x, -marginPixels.y);
                break;
            case Corner.TopRight:
                anchor = new Vector2(1f, 1f);
                signedMargin = new Vector2(-marginPixels.x, -marginPixels.y);
                break;
            case Corner.BottomLeft:
                anchor = new Vector2(0f, 0f);
                signedMargin = new Vector2(marginPixels.x, marginPixels.y);
                break;
            default: // BottomRight
                anchor = new Vector2(1f, 0f);
                signedMargin = new Vector2(-marginPixels.x, marginPixels.y);
                break;
        }

        rt.anchorMin = anchor;
        rt.anchorMax = anchor;
        rt.pivot = anchor;
        rt.sizeDelta = sizePixels;
        rt.anchoredPosition = signedMargin;
    }
}
