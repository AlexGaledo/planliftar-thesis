/**
 * Why a tiny heading error moves far walls a lot ("lever arm"), as a small
 * top-down SVG with the real numbers from AR_ANCHORING.md: a 2 degree heading
 * correction moves a wall 8 m from the anchor by 27.9 cm.
 */
import styles from "./learn.module.css";

const DISTANCE_M = 8;
const ANGLE_DEG = 2;
/** chord length = 2 r sin(theta/2) */
const SHIFT_CM = Math.round(2 * DISTANCE_M * Math.sin(((ANGLE_DEG / 2) * Math.PI) / 180) * 1000) / 10;

export function AnchoringDiagram() {
  // Exaggerate the angle in the drawing so the gap is visible; the label keeps the real value.
  const drawAngle = (12 * Math.PI) / 180;
  const ax = 40;
  const ay = 150;
  const len = 360;
  const bx = ax + len;
  const by = ay;
  const cx = ax + len * Math.cos(drawAngle);
  const cy = ay - len * Math.sin(drawAngle);
  return (
    <figure className={styles.diagram}>
      <svg viewBox="0 0 460 190" className={styles.anchorSvg} role="img" aria-label={`Top-down sketch: the anchor where you tapped, and a wall ${DISTANCE_M} metres away. A ${ANGLE_DEG} degree heading correction swings that wall by about ${SHIFT_CM} centimetres.`}>
        <line x1={ax} y1={ay} x2={bx} y2={by} className={styles.anchorArm} />
        <line x1={ax} y1={ay} x2={cx} y2={cy} className={styles.anchorArmMoved} />
        <path d={`M${ax + 90},${ay} A90,90 0 0,0 ${ax + 90 * Math.cos(drawAngle)},${ay - 90 * Math.sin(drawAngle)}`} className={styles.anchorArc} />
        <circle cx={ax} cy={ay} r={7} className={styles.anchorDot} />
        <rect x={bx - 4} y={by - 26} width={8} height={52} className={styles.anchorWall} />
        <rect x={cx - 4} y={cy - 26} width={8} height={52} className={styles.anchorWallMoved} transform={`rotate(${-12} ${cx} ${cy})`} />
        <text x={ax} y={ay + 28} className={styles.anchorText}>
          Anchor (where you tapped)
        </text>
        <text x={ax + 100} y={ay - 6} className={styles.anchorText}>
          {ANGLE_DEG} degrees
        </text>
        <text x={bx - 150} y={by + 28} className={styles.anchorText}>
          Wall {DISTANCE_M} m away
        </text>
        <text x={cx - 160} y={cy - 32} className={styles.anchorText}>
          moves {SHIFT_CM} cm
        </text>
      </svg>
      <figcaption className="small muted">
        Angle exaggerated for the drawing. The fix: follow the anchor&apos;s full pose (position and heading), not position alone.
      </figcaption>
    </figure>
  );
}
