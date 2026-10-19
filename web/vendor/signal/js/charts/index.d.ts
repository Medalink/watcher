// Types for signal-design/charts. Requires chart.js 4 (optional peer dependency).
import type { Chart } from "chart.js";

export type ScaleMode = "clamp" | "p95" | "p90" | "linear" | "log";
export type EffectsLevel = "full" | "subtle" | "off";
export type SeriesKind = "down" | "up" | "in" | "out" | "rtt" | "ghost" | "baseline" | "fallback";

export interface Point {
  /** Time in ms since the epoch. */
  x: number;
  /** null breaks the line (missing data). */
  y: number | null;
}

export interface Series {
  label: string;
  data: Point[];
  /** "Mbps" (default for bandwidth) or " ms" (latency). */
  unit?: string;
  /** Palette slot; inferred from the label (↓ ↑ in out internet rtt) when left out. */
  kind?: SeriesKind;
  /** Any CSS color; overrides the theme. */
  color?: string;
  /** "y" bandwidth panel, "y1" latency panel (core preset). */
  axis?: "y" | "y1";
  /** Band under the line, e.g. jitter: per-point lower and upper values. */
  min?: Point[];
  max?: Point[];
  /** Week-over-week comparison: thin dashed line. */
  ghost?: boolean;
  dash?: number[];
  borderWidth?: number;
}

export interface Range {
  from: number;
  to: number;
  kind?: "maintenance" | "missing" | "alert" | "dip" | "spike";
  label?: string;
  detail?: string;
}

export interface ChartOptions {
  preset?: "bandwidth" | "latency" | "core";
  series: Series[];
  /** Bucket size of the data; ≤10 adds tooltip deltas and burst markers. Default 10. */
  bucketSeconds?: number;
  /** Live refresh in seconds: value tags, live edge, heartbeat, 500ms scroll. */
  live?: number;
  /** Keep only this many ms of history while live. */
  window?: number;
  /** Turn off the live drift of the time window. */
  scroll?: boolean;
  xMin?: number;
  xMax?: number;
  scaleMode?: ScaleMode;
  /** Raw dense data: min/max ribbon over this many columns plus a trend line. */
  envelope?: number | false;
  smoothing?: { window?: number; iterations?: number };
  tension?: number;
  /** Lines warm toward warning and critical as they near the axis top. Default true. */
  heat?: boolean;
  bursts?: boolean;
  thresholds?: { value: number; label?: string; level?: "warning" | "critical"; axis?: "y" | "y1"; unit?: string }[];
  baselines?: { value: number; label?: string; color?: string; axis?: "y" | "y1" }[];
  events?: { x: number; y: number; kind: "surge" | "drop"; label?: string; unexpected?: boolean }[];
  peaks?: Point[];
  ranges?: Range[];
  forecastFrom?: number;
  /** Working hours and day lines on windows of 2 days or more. Default true. */
  rhythm?: boolean | { hours?: [number, number] };
  /** Drag to select (fires sd:chart-select). Default true. */
  select?: boolean;
  /** Apply a drag selection as the window; double click resets. */
  zoom?: boolean;
  compact?: boolean;
  legend?: boolean;
  labels?: { primary?: string; secondary?: string };
  /** Weight of the latency panel in the core preset (bandwidth gets the rest of 100). Default 26. */
  secondaryWeight?: number;
  effects?: EffectsLevel;
}

export interface SignalChart {
  readonly chart: Chart;
  readonly scaleMode: ScaleMode;
  /** Add or replace points by series label. Band points may carry min and max. */
  append(updates: Record<string, (Point & { min?: number; max?: number })[]>): void;
  setScaleMode(mode: ScaleMode): void;
  /** Show a time window; no arguments resets it. */
  setWindow(from?: number, to?: number): void;
  select(range: { from: number; to: number } | null): void;
  setRanges(ranges: Range[]): void;
  destroy(): void;
}

export interface BasicSeries {
  label: string;
  /** Numbers for category charts; { x, y } points for scatter or time. */
  data: (number | null)[] | { x: number; y: number | null }[];
  /** Any CSS color; otherwise series colors 1–6 in order. */
  color?: string;
  /** A theme role instead: "critical", "warning", "accent", … */
  tone?: string;
  dash?: number[];
  borderWidth?: number;
  /** Scatter point size. */
  size?: number;
}

export interface BasicChartOptions {
  type: "line" | "area" | "step" | "bar" | "hbar" | "histogram" | "scatter";
  series: BasicSeries[];
  labels?: string[];
  unit?: string;
  /** Scatter x unit. */
  xUnit?: string;
  stacked?: boolean;
  /** Square points on lines. */
  points?: boolean;
  legend?: boolean;
  /** Value labels at bar ends (hbar). Default true. */
  valueLabels?: boolean;
  beginAtZero?: boolean;
  yMax?: number;
  /** Dashed reference lines; x markers take a category index or x value. */
  markers?: { value: number; axis?: "x" | "y"; label?: string; tone?: string }[];
}

export interface BasicChart {
  readonly chart: Chart;
  setData(data: { labels?: string[]; series?: BasicSeries[] }): void;
  destroy(): void;
}

export function createChart(canvas: HTMLCanvasElement, options: BasicChartOptions): BasicChart;
export function createChart(canvas: HTMLCanvasElement, options: ChartOptions): SignalChart;
/** Build every [data-sd-chart] figure from its JSON payload. */
export function initCharts(root?: ParentNode): SignalChart[];

export const SCALE_MODES: readonly ScaleMode[];
export function formatValue(value: number | null | undefined, unit?: string): string;
export function formatBandwidth(mbps: number): string;
export function formatMs(ms: number): string;
export function formatDelta(diff: number, unit?: string): string;
export function formatTime(time: number, pattern: string): string;
export function percentile(values: number[], p: number): number;
export function scaleBounds(values: (number | null)[], mode?: ScaleMode, floorMax?: number): { max: number; ceiling: number | null };
export function smooth(points: Point[], options?: { window?: number; iterations?: number }): Point[];
export function envelope(points: Point[], columns?: number, bucketMs?: number): { min: Point[]; max: Point[] };
export function bursts(points: Point[]): Point[];
export function significance(points: Point[]): number;
export function flowRate(current: number, peak: number): number;
export function effectsLevel(): EffectsLevel;
export function setEffectsLevel(level: EffectsLevel): void;
export const EFFECTS: Record<string, Record<string, number>>;

declare global {
  interface HTMLElementEventMap {
    "sd:chart-select": CustomEvent<{ from: number; to: number }>;
    "sd:chart-scale": CustomEvent<{ mode: ScaleMode }>;
  }
}
