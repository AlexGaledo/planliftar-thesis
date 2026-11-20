/**
 * The extracted walls and rooms drawn over the source image, as SVG.
 *
 * Plan coordinates are pixels of the full uploaded image (docs/API.md), so the
 * SVG viewBox is the image's own pixel size and the two line up directly. When
 * the file states a different source size (e.g. the image was resized), plan
 * coordinates are scaled by naturalWidth / source.image_width_px.
 *
 * Walls are clickable so the user can pick a "wall I know" for scale.
 *
 * @param plan           prepared (normalised + gap-closed) plan
 * @param imageUrl       object URL of the source image, or null for no image
 * @param selectedWallId wall highlighted for the scale form
 * @param onSelectWall   called when a wall is tapped (omit to disable)
 */
import { useEffect, useState } from "react";
import { roomColor } from "@/lib/three/buildFloorplanGroup";
import { computeBounds, polygonCentroid, sourceImageSize, type Plan } from "@/lib/plan";
import { roomLabel, wallKey } from "./labels";
import styles from "./plan.module.css";

interface PlanOverlayProps {
  plan: Plan;
  imageUrl: string | null;
  selectedWallId?: string | null;
  onSelectWall?: (id: string) => void;
}

/** Room labels and wall hit areas scale with the drawing; these are fractions of its longest side. */
const LABEL_SIZE_FRACTION = 0.022;
const HIT_WIDTH_FRACTION = 0.025;

export function PlanOverlay({ plan, imageUrl, selectedWallId, onSelectWall }: PlanOverlayProps) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [showImage, setShowImage] = useState(true);
  const [showRooms, setShowRooms] = useState(true);
  const [imageFailed, setImageFailed] = useState(false);

  // Measure the image's pixel size (the drawing space) whenever it changes.
  useEffect(() => {
    setNatural(null);
    setImageFailed(false);
    if (!imageUrl) return;
    const probe = new Image();
    probe.onload = () => setNatural({ w: probe.naturalWidth, h: probe.naturalHeight });
    probe.onerror = () => setImageFailed(true);
    probe.src = imageUrl;
    return () => {
      probe.onload = null;
      probe.onerror = null;
    };
  }, [imageUrl]);

  const declared = sourceImageSize(plan);
  const bounds = computeBounds(plan);
  const imageSize = imageUrl && !imageFailed ? natural : null;
  const hasImage = !!imageSize;

  // Drawing space: the image's pixels when there is one, else the plan's own box.
  let viewBox: string;
  let k = 1; // plan px -> drawing px
  if (imageSize) {
    if (declared) k = imageSize.w / declared.width;
    viewBox = `0 0 ${imageSize.w} ${imageSize.h}`;
  } else {
    const pad = Math.max(bounds.widthPx, bounds.heightPx) * 0.05;
    viewBox = `${bounds.minX - pad} ${bounds.minY - pad} ${bounds.widthPx + 2 * pad} ${bounds.heightPx + 2 * pad}`;
  }
  const longest = Math.max(bounds.widthPx, bounds.heightPx, 1) * k;

  return (
    <figure className={styles.overlayFigure}>
      <div className={styles.overlayTools} role="group" aria-label="Overlay layers">
        {hasImage && (
          <label className="check">
            <input type="checkbox" checked={showImage} onChange={(e) => setShowImage(e.target.checked)} />
            <span>Source image</span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={showRooms} onChange={(e) => setShowRooms(e.target.checked)} />
          <span>Rooms</span>
        </label>
      </div>

      <div className={styles.overlayStage}>
        <svg
          viewBox={viewBox}
          className={styles.overlaySvg}
          role="img"
          aria-label={`Extracted plan: ${plan.walls.length} walls and ${plan.rooms?.length ?? 0} rooms${hasImage ? ", drawn over the source image" : ""}.`}
        >
          {imageSize && (
            <image href={imageUrl!} x={0} y={0} width={imageSize.w} height={imageSize.h} opacity={showImage ? 1 : 0} />
          )}
          <g transform={`scale(${k})`}>
            {showRooms &&
              (plan.rooms ?? []).map((room, i) =>
                room.polygon.length >= 3 ? (
                  <polygon
                    key={room.id ?? i}
                    points={room.polygon.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill={roomColor(i)}
                    fillOpacity={0.55}
                    stroke="none"
                  />
                ) : null,
              )}
            {plan.walls.map((w, i) => {
              const id = wallKey(w, i);
              const selected = id === selectedWallId;
              return (
                <g key={id}>
                  <line
                    x1={w.start.x}
                    y1={w.start.y}
                    x2={w.end.x}
                    y2={w.end.y}
                    className={[styles.wall, w.generated ? styles.wallFill : "", selected ? styles.wallSelected : ""].join(" ")}
                    strokeWidth={Math.max(w.thickness ?? 4, longest / 300)}
                    strokeDasharray={w.generated ? `${longest / (60 * k)} ${longest / (120 * k)}` : undefined}
                  />
                  {onSelectWall && (
                    <line
                      x1={w.start.x}
                      y1={w.start.y}
                      x2={w.end.x}
                      y2={w.end.y}
                      className={styles.wallHit}
                      strokeWidth={(longest * HIT_WIDTH_FRACTION) / k}
                      onClick={() => onSelectWall(id)}
                    >
                      <title>Use this wall for scale</title>
                    </line>
                  )}
                </g>
              );
            })}
            {showRooms &&
              (plan.rooms ?? []).map((room, i) => {
                if (room.polygon.length < 3) return null;
                const c = polygonCentroid(room.polygon);
                return (
                  <text key={`t${room.id ?? i}`} x={c.x} y={c.y} className={styles.roomLabel} fontSize={(longest * LABEL_SIZE_FRACTION) / k}>
                    {roomLabel(room.type ?? room.name, i)}
                  </text>
                );
              })}
          </g>
        </svg>
      </div>
      <figcaption className="small muted">
        Solid lines are walls the AI found{plan.walls.some((w) => w.generated) ? "; dashed lines are short gaps the app closed" : ""}.
        {onSelectWall ? " Tap a wall to use it for scale." : ""}
      </figcaption>
    </figure>
  );
}
