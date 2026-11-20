/**
 * Plain-language text for the acceptance barrier's reject reasons
 * (docs/research/MODEL_EXPLAINED.md §2.12).
 */
const REASONS: Record<string, string> = {
  no_rooms: "No enclosed rooms were found.",
  open_polygon: "A room outline did not close.",
  room_below_min_area: "A detected room is smaller than the minimum room size.",
  room_count_implausible: "The number of rooms is not plausible for one floor (1 to 40 expected).",
  low_consensus_with_geometry_anomaly: "The two AI models disagree and the geometry has a problem.",
};

export function describeRejection(code: string): string {
  return REASONS[code] ?? code.replaceAll("_", " ");
}
