/**
 * The image-to-AR pipeline as a top-to-bottom flowchart, laid out from the
 * nodes/edges in model_viz_data.json (no hand-placed coordinates).
 *
 * Layout: each node's row is its longest path from the start, so every arrow
 * points down. Nodes in the same row sit side by side. Tap (or focus + Enter)
 * a step to read what it does; the same text is in the list below the
 * diagram for screen readers.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { NODE_H, NODE_W, ROW_H, WIDTH, layoutPipeline } from "./pipelineLayout";
import { viz } from "./vizData";
import styles from "./learn.module.css";

/** Node style by stage group: neural nets filled, checks dashed, the rest outlined. */
const GROUP_LABEL: Record<string, string> = {
  input: "Input",
  preprocess: "Preparation",
  neural: "Neural network",
  data: "Intermediate data",
  vectorize: "Geometry",
  check: "Quality check",
  output: "Output",
  ar: "On the phone",
};

export function PipelineDiagram() {
  const { nodes, edges } = viz.pipeline;
  const { pos, rows } = useMemo(() => layoutPipeline(nodes, edges), [nodes, edges]);
  const [selected, setSelected] = useState<string>("mitunet");
  const current = nodes.find((n) => n.id === selected);
  const height = rows * ROW_H + 8;
  // On a phone the chart is wider than the screen. Start scrolled to the
  // middle, where the main line of steps runs, instead of clipping it.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, []);

  return (
    <figure className={styles.diagram}>
      <p className={`small muted ${styles.scrollHint}`}>Swipe sideways to see the side branches.</p>
      <div className={styles.diagramScroll} ref={scroller} tabIndex={0} aria-label="Pipeline flowchart, scrolls sideways">
        <svg viewBox={`0 0 ${WIDTH} ${height}`} className={styles.pipelineSvg} role="group" aria-label="Pipeline flowchart. Each step is a button that shows its description.">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className={styles.arrowHead} />
            </marker>
          </defs>
          {edges.map(([a, b]) => {
            const p = pos.get(a)!;
            const q = pos.get(b)!;
            const x1 = p.x + NODE_W / 2;
            const y1 = p.y + NODE_H;
            const x2 = q.x + NODE_W / 2;
            const y2 = q.y;
            const midY = (y1 + y2) / 2;
            return <path key={`${a}-${b}`} d={`M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2 - 2}`} className={styles.edge} markerEnd="url(#arrow)" />;
          })}
          {nodes.map((n) => {
            const p = pos.get(n.id)!;
            const isSel = n.id === selected;
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                className={styles.node}
                data-group={n.group}
                data-selected={isSel}
                role="button"
                tabIndex={0}
                aria-pressed={isSel}
                aria-label={`${n.label} (${GROUP_LABEL[n.group] ?? n.group})`}
                onClick={() => setSelected(n.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(n.id);
                  }
                }}
              >
                <rect width={NODE_W} height={NODE_H} rx={4} />
                <text x={NODE_W / 2} y={NODE_H / 2}>
                  {n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <ul className={styles.legend} aria-label="Key">
        <li>
          <span className={styles.keyNeural} aria-hidden="true" /> Neural network (pretrained)
        </li>
        <li>
          <span className={styles.keyCheck} aria-hidden="true" /> Quality check
        </li>
        <li>
          <span className={styles.keyPlain} aria-hidden="true" /> Geometry, data and output steps
        </li>
      </ul>
      {current && (
        <div className={styles.nodeDetail} aria-live="polite">
          <strong>{current.label}</strong>
          <p className="small">{current.desc}</p>
        </div>
      )}
      <figcaption className="small muted">
        From the photo of a plan to a walkable model: {nodes.length} steps. Two networks read the image; everything after the probability
        map is geometry and checks written for this project.
      </figcaption>
      <details className={styles.dataDetails}>
        <summary>All steps as text</summary>
        <ol className="small">
          {nodes.map((n) => (
            <li key={n.id}>
              <strong>{n.label}.</strong> {n.desc}
            </li>
          ))}
        </ol>
      </details>
    </figure>
  );
}
