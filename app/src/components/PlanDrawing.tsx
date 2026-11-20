/**
 * Renders a stored plan thumbnail (SVG string) as an image.
 *
 * Shown through <img src="data:image/svg+xml,..."> rather than inlined HTML:
 * browsers never run scripts inside an SVG loaded as an image, so even a
 * tampered IndexedDB record cannot execute code. The SVG is drawn in black;
 * dark mode inverts it with a CSS filter.
 *
 * @param svg    output of planThumbnailSvg()
 * @param label  alt text, e.g. "Floor plan of Bungalow"
 */
import styles from "./PlanDrawing.module.css";

interface PlanDrawingProps {
  svg: string;
  label: string;
  className?: string;
}

export function PlanDrawing({ svg, label, className }: PlanDrawingProps) {
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replaceAll("currentColor", "#000"))}`;
  return (
    <div className={[styles.drawing, className].filter(Boolean).join(" ")}>
      <img src={src} alt={label} draggable={false} />
    </div>
  );
}
