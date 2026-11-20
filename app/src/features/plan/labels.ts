/**
 * Small naming helpers shared by the overlay, the 3D viewer and the map.
 */

/** Stable key for a wall: its id, or its index when the file has none. */
export function wallKey(w: { id?: string }, index: number): string {
  return w.id ?? `w${index}`;
}

/** "living_room" -> "Living room"; unnamed rooms get a number. */
export function roomLabel(type: string | undefined, index: number): string {
  if (!type || type === "room" || type === "undefined") return `Room ${index + 1}`;
  const t = type.replaceAll("_", " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
