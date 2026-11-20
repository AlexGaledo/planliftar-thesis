/**
 * Typed access to src/content/model_viz_data.json (copied from
 * docs/research/model_viz_data.json), plus the small transforms the charts need.
 *
 * Every number shown on the Learn page comes from this file; nothing is typed
 * in by hand, so the page cannot drift from the research doc's data.
 */
import raw from "@/content/model_viz_data.json";

export type ChartType = "bar" | "grouped_bar" | "funnel" | "horizontal_bar" | "line" | "table";

export interface VizSeries {
  name: string;
  data: [string | number, number][];
}

export interface VizChart {
  id: string;
  title: string;
  type: ChartType;
  xLabel: string;
  yLabel: string;
  series: VizSeries[];
  caption: string;
  source: string;
}

export interface PipelineNode {
  id: string;
  label: string;
  group: string;
  desc: string;
}

export interface ArchBlock {
  model: string;
  id: string;
  label: string;
  detail: string;
  shape: string;
  next: string[];
}

export interface VizData {
  meta: { title: string; note: string; generated: string };
  pipeline: { nodes: PipelineNode[]; edges: [string, string][] };
  architecture: { blocks: ArchBlock[]; models: Record<string, string | number>[] };
  charts: VizChart[];
  glossary: { term: string; def: string }[];
  faq: { q: string; a: string }[];
}

export const viz = raw as unknown as VizData;

/** One row per x value with a column per series: the shape Recharts wants. */
export type Row = { x: string } & Record<string, number | string | null>;

/**
 * Merge series into rows keyed by x. Series of different lengths (e.g. a
 * metric only measured on some runs) leave the missing cells null, so no
 * bar is drawn for them rather than a fake zero.
 */
export function toRows(chart: VizChart): Row[] {
  const order: string[] = [];
  const rows = new Map<string, Row>();
  for (const s of chart.series) {
    for (const [x, y] of s.data) {
      const key = String(x);
      if (!rows.has(key)) {
        order.push(key);
        rows.set(key, { x: key } as Row);
      }
      rows.get(key)![s.name] = y;
    }
  }
  for (const r of rows.values()) for (const s of chart.series) if (!(s.name in r)) r[s.name] = null;
  return order.map((k) => rows.get(k)!);
}

/**
 * The resolution-invariance chart mixes counts, px and px^2. Its title says
 * "normalised to 1x", so divide each metric by its own 1x value and pivot:
 * one group per metric, one bar per input scale. All bars should sit at ~1.0.
 */
export function normaliseToBase(chart: VizChart, base = 1): { rows: Row[]; seriesNames: string[] } {
  const scales = chart.series[0]?.data.map(([x]) => Number(x)) ?? [];
  const seriesNames = scales.map((s) => `${s}x`);
  const rows = chart.series.map((s) => {
    const baseValue = s.data.find(([x]) => Number(x) === base)?.[1] ?? 1;
    const row = { x: s.name } as Row;
    s.data.forEach(([x, y]) => {
      row[`${Number(x)}x`] = Math.round((y / baseValue) * 1000) / 1000;
    });
    return row;
  });
  return { rows, seriesNames };
}
