/**
 * Layered layout for the pipeline flowchart: each node's row is its longest
 * path from a start node, so every arrow points downward; nodes sharing a row
 * are centred side by side. Pure function, unit-tested.
 */
import type { PipelineNode } from "./vizData";

export const ROW_H = 72;
export const NODE_H = 44;
export const WIDTH = 640;
export const NODE_W = 260;
export const COL_GAP = 40;

export function layoutPipeline(nodes: PipelineNode[], edges: [string, string][]) {
  const row = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  // Longest-path layering; the graph is a DAG, so N passes always settle.
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const [a, b] of edges) {
      const want = (row.get(a) ?? 0) + 1;
      if ((row.get(b) ?? 0) < want) {
        row.set(b, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const byRow = new Map<number, PipelineNode[]>();
  for (const n of nodes) {
    const r = row.get(n.id)!;
    byRow.set(r, [...(byRow.get(r) ?? []), n]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [r, list] of byRow) {
    const total = list.length * NODE_W + (list.length - 1) * COL_GAP;
    list.forEach((n, i) => pos.set(n.id, { x: (WIDTH - total) / 2 + i * (NODE_W + COL_GAP), y: r * ROW_H + 8 }));
  }
  return { pos, rows: Math.max(...row.values()) + 1 };
}

