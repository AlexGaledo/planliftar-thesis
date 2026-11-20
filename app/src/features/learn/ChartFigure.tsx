/**
 * One research chart: title, the chart, caption + source, and a data table.
 *
 * The chart form follows the data's job (dataviz skill):
 *  - bar / funnel / horizontal_bar: magnitude per category -> bars from zero
 *  - grouped_bar: same, several series side by side (max 3 colour slots)
 *  - line: change along a continuous x
 *  - table: values with mixed units -> a plain table, not a chart
 * Every chart has a hover tooltip, a legend when there are 2+ series, and a
 * "Show the numbers" table so nothing depends on colour or hover alone.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { normaliseToBase, toRows, type Row, type VizChart } from "./vizData";
import { useChartColors, type ChartColors } from "./useChartColors";
import styles from "./learn.module.css";

/** Charts whose shape needs a specific treatment, by id. */
const NORMALISED = new Set(["resolution_invariance"]);
/** A target line drawn instead of a bar for the "target" category. */
const TARGETS: Record<string, { label: string; value: number }> = {
  consensus_metric_comparison: { label: "target CONSENSUS_MIN", value: 0.7 },
};
const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0];
const HBAR_RADIUS: [number, number, number, number] = [0, 4, 4, 0];
const AXIS_FONT = 12;

export function ChartFigure({ chart }: { chart: VizChart }) {
  const colors = useChartColors();
  const normalised = NORMALISED.has(chart.id);
  const target = TARGETS[chart.id];

  let rows: Row[];
  let seriesNames: string[];
  if (normalised) {
    ({ rows, seriesNames } = normaliseToBase(chart));
  } else {
    rows = toRows(chart);
    seriesNames = chart.series.map((s) => s.name);
  }
  if (target) rows = rows.filter((r) => r.x !== target.label);

  const headingId = `chart-${chart.id}`;
  return (
    <figure className={styles.chart} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.chartTitle}>
        {chart.title}
      </h3>
      {chart.type !== "table" && (
        <div className={styles.plot} role="img" aria-label={`${chart.title}. ${chart.caption}`}>
          <ChartBody
            chart={chart}
            rows={rows}
            seriesNames={seriesNames}
            colors={colors}
            normalised={normalised}
            target={target?.value}
          />
        </div>
      )}
      <figcaption className="small">
        {chart.caption} <span className="muted">Source: {chart.source}</span>
      </figcaption>
      <DataTable
        chart={chart}
        rows={rows}
        seriesNames={seriesNames}
        open={chart.type === "table"}
      />
    </figure>
  );
}

interface BodyProps {
  chart: VizChart;
  rows: Row[];
  seriesNames: string[];
  colors: ChartColors;
  normalised: boolean;
  target?: number;
}

function ChartBody({ chart, rows, seriesNames, colors, normalised, target }: BodyProps) {
  const multi = seriesNames.length > 1;
  const fill = (i: number) => (multi ? colors.series[i % 3] : colors.ink);
  const axis = {
    stroke: colors.muted,
    tick: { fill: colors.muted, fontSize: AXIS_FONT },
    tickLine: false,
  };
  const tooltip = (
    <Tooltip content={<ChartTooltip />} cursor={{ fill: colors.grid, stroke: colors.grid }} />
  );
  // Legend on top, text in ink: below the plot it collided with the x-axis
  // title on phones, and series-coloured text failed contrast on white.
  const legend = multi ? (
    <Legend
      verticalAlign="top"
      wrapperStyle={{ fontSize: 13, paddingBottom: 8 }}
      iconType="square"
      formatter={(value: string) => <span style={{ color: colors.ink }}>{value}</span>}
    />
  ) : null;
  // The value-axis title sits above the plot as text: rotated inside a 390 px
  // wide chart it overlapped the tick numbers.
  const yLabel = normalised ? "Value relative to 1x" : chart.yLabel;
  const yTitle = <p className={styles.axisTitle}>{yLabel}</p>;

  if (chart.type === "line") {
    return (
      <>
        {yTitle}
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
            <CartesianGrid stroke={colors.grid} vertical={false} />
            <XAxis
              dataKey="x"
              {...axis}
              label={{
                value: chart.xLabel,
                position: "insideBottom",
                offset: -12,
                fill: colors.muted,
                fontSize: AXIS_FONT,
              }}
            />
            <YAxis {...axis} width={40} />
            {tooltip}
            {legend}
            {seriesNames.map((n, i) => (
              <Line
                key={n}
                dataKey={n}
                stroke={fill(i)}
                strokeWidth={2}
                dot={{ r: 4, fill: fill(i), stroke: colors.paper, strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </>
    );
  }

  // Funnel and horizontal bars read better sideways: long category names fit.
  const horizontal =
    chart.type === "horizontal_bar" || chart.type === "funnel" || rows.some((r) => r.x.length > 16);
  if (horizontal) {
    const height = Math.max(200, rows.length * (multi ? 22 * seriesNames.length + 16 : 34) + 60);
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
          barGap={2}
        >
          <CartesianGrid stroke={colors.grid} horizontal={false} />
          <XAxis type="number" {...axis} />
          <YAxis type="category" dataKey="x" {...axis} width={150} interval={0} />
          {tooltip}
          {legend}
          {target !== undefined && (
            <ReferenceLine
              x={target}
              stroke={colors.ink}
              strokeDasharray="4 3"
              label={{
                value: `target ${target}`,
                fill: colors.ink,
                fontSize: AXIS_FONT,
                position: "top",
              }}
            />
          )}
          {seriesNames.map((n, i) => (
            <Bar
              key={n}
              dataKey={n}
              fill={fill(i)}
              radius={HBAR_RADIUS}
              maxBarSize={22}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <>
      {yTitle}
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={rows} margin={{ top: 16, right: 16, bottom: 24, left: 8 }} barGap={2}>
          <CartesianGrid stroke={colors.grid} vertical={false} />
          <XAxis
            dataKey="x"
            {...axis}
            interval={0}
            label={{
              value: chart.xLabel,
              position: "insideBottom",
              offset: -12,
              fill: colors.muted,
              fontSize: AXIS_FONT,
            }}
          />
          <YAxis {...axis} width={48} />
          {tooltip}
          {legend}
          {target !== undefined && (
            <ReferenceLine
              y={target}
              stroke={colors.ink}
              strokeDasharray="4 3"
              label={{
                value: `target ${target}`,
                fill: colors.ink,
                fontSize: AXIS_FONT,
                position: "insideTopRight",
              }}
            />
          )}
          {seriesNames.map((n, i) => (
            <Bar
              key={n}
              dataKey={n}
              fill={fill(i)}
              radius={BAR_RADIUS}
              maxBarSize={48}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </>
  );
}

interface TooltipEntry {
  name?: string | number;
  value?: number | string;
  color?: string;
}

/** Text in ink; the coloured square beside each row carries series identity. */
function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className={styles.tooltip}>
      <strong>{label}</strong>
      {payload.map((p) => (
        <div key={String(p.name)} className={styles.tooltipRow}>
          <span className={styles.swatch} style={{ background: p.color }} aria-hidden="true" />
          <span>{p.name}</span>
          <span className={styles.tooltipValue}>
            {typeof p.value === "number" ? p.value.toLocaleString() : (p.value ?? "n/a")}
          </span>
        </div>
      ))}
    </div>
  );
}

function DataTable({
  chart,
  rows,
  seriesNames,
  open,
}: {
  chart: VizChart;
  rows: Row[];
  seriesNames: string[];
  open: boolean;
}) {
  const table = (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="visually-hidden">{chart.title}</caption>
        <thead>
          <tr>
            <th scope="col">{chart.xLabel}</th>
            {seriesNames.map((n) => (
              <th key={n} scope="col">
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.x}>
              <th scope="row">{r.x}</th>
              {seriesNames.map((n) => (
                <td key={n}>
                  {r[n] === null || r[n] === undefined ? "n/a" : Number(r[n]).toLocaleString()}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  if (open) return table;
  return (
    <details className={styles.dataDetails}>
      <summary>Show the numbers</summary>
      {table}
    </details>
  );
}
