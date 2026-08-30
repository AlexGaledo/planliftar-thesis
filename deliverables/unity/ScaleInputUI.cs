// ScaleInputUI.cs
//
// Minimal uGUI (UnityEngine.UI) controller for the "type one known
// dimension" scaling step: Prev/Next buttons cycle through the placed
// floorplan's walls (highlighting the selected wall by swapping its
// material), an InputField takes the real-world length in meters, and an
// Apply button calls TapToPlaceFloorPlan.SetScaleFromReference.
//
// Uses legacy UnityEngine.UI (InputField/Text/Button) rather than TextMeshPro
// so the scene has no extra package/TMP-Essentials-import dependency; swap
// the types for TMP_InputField/TMP_Text if the project already uses TMP.

using UnityEngine;
using UnityEngine.UI;

public class ScaleInputUI : MonoBehaviour
{
    [SerializeField] private TapToPlaceFloorPlan floorPlanPlacer;
    [SerializeField] private InputField metersInputField;
    [SerializeField] private Text selectedWallLabel;
    [SerializeField] private Button prevButton;
    [SerializeField] private Button nextButton;
    [SerializeField] private Button applyButton;
    [SerializeField] private Material highlightMaterial;

    private int _selectedIndex = -1;
    private string _highlightedWallId;

    private void Awake()
    {
        if (prevButton != null) prevButton.onClick.AddListener(SelectPrevious);
        if (nextButton != null) nextButton.onClick.AddListener(SelectNext);
        if (applyButton != null) applyButton.onClick.AddListener(ApplyScale);
    }

    private void OnDestroy()
    {
        if (prevButton != null) prevButton.onClick.RemoveListener(SelectPrevious);
        if (nextButton != null) nextButton.onClick.RemoveListener(SelectNext);
        if (applyButton != null) applyButton.onClick.RemoveListener(ApplyScale);
    }

    public void SelectNext()
    {
        var walls = floorPlanPlacer != null && floorPlanPlacer.CurrentFloorPlan != null
            ? floorPlanPlacer.CurrentFloorPlan.Walls
            : null;
        if (walls == null || walls.Count == 0) return;

        _selectedIndex = (_selectedIndex + 1 + walls.Count) % walls.Count;
        HighlightSelected();
    }

    public void SelectPrevious()
    {
        var walls = floorPlanPlacer != null && floorPlanPlacer.CurrentFloorPlan != null
            ? floorPlanPlacer.CurrentFloorPlan.Walls
            : null;
        if (walls == null || walls.Count == 0) return;

        _selectedIndex = (_selectedIndex - 1 + walls.Count) % walls.Count;
        HighlightSelected();
    }

    private void HighlightSelected()
    {
        var floorPlan = floorPlanPlacer.CurrentFloorPlan;
        var walls = floorPlan.Walls;

        // Restore the previously highlighted wall's original material first.
        if (_highlightedWallId != null)
        {
            var previous = floorPlan.FindWall(_highlightedWallId);
            if (previous.HasValue && previous.Value.Renderer != null)
            {
                previous.Value.Renderer.sharedMaterial = previous.Value.OriginalMaterial;
            }
        }

        var selected = walls[_selectedIndex];
        if (selected.Renderer != null && highlightMaterial != null)
        {
            selected.Renderer.sharedMaterial = highlightMaterial;
        }
        _highlightedWallId = selected.Id;

        if (selectedWallLabel != null)
        {
            selectedWallLabel.text = selected.Id;
        }
    }

    public void ApplyScale()
    {
        if (_highlightedWallId == null || floorPlanPlacer == null || metersInputField == null) return;

        if (!float.TryParse(metersInputField.text, out float meters) || meters <= 0f)
        {
            Debug.LogWarning("ScaleInputUI: enter a positive number of meters before applying.");
            return;
        }

        floorPlanPlacer.SetScaleFromReference(_highlightedWallId, meters);
    }
}
