/**
 * Canvas plugins for signal charts. Each reads chart.$sd, the state the
 * chart factory keeps: { theme, options, hoverX, selection, ceiling }.
 * Everything is square: no arcs, no blur, no gradients.
 */
import { FONT, rgba } from "./theme.js";
import { formatValue } from "./format.js";
import { formatTime } from "./time.js";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const color = (chart, name, alpha) => rgba(chart.$sd.theme.colors[name], alpha);
const font = (size, weight = 400) => `${weight} ${size}px ${FONT}`;

/** Newest drawn point of a dataset: { x, y, value } in pixels. */
export function newestPoint(chart, index) {
  const meta = chart.getDatasetMeta(index);
  const data = chart.data.datasets[index].data;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i]?.y == null) continue;
    const el = meta.data[i];
    if (!el || !Number.isFinite(el.x) || !Number.isFinite(el.y)) return null;
    return { x: el.x, y: el.y, value: data[i].y, time: data[i].x };
  }
  return null;
}

/** Datasets that are real series lines (not bands, markers or proxies). */
export function lineIndexes(chart, { visual = false } = {}) {
  return chart.data.datasets
    .map((ds, i) => ({ ds, i }))
    .filter(({ ds, i }) => ds._role === (visual ? "visual" : "line") || (visual && ds._role === "line" && !ds._hasVisual))
    .filter(({ i }) => chart.isDatasetVisible(i))
    .map(({ i }) => i);
}

/** Track the pointer for the crosshair. */
export const pointer = {
  id: "sdPointer",
  afterEvent(chart, args) {
    const { event } = args;
    const area = chart.chartArea;
    if (event.type === "mouseout" || !area) chart.$sd.hoverX = null;
    else if (event.type === "mousemove") {
      chart.$sd.hoverX = event.x >= area.left && event.x <= area.right && event.y >= area.top && event.y <= area.bottom ? event.x : null;
    }
    args.changed = true;
  },
};

/** Dashed vertical line under the pointer, across every panel. */
export const crosshair = {
  id: "sdCrosshair",
  afterDraw(chart) {
    const x = chart.$sd.hoverX;
    if (x == null) return;
    const { ctx, chartArea: a } = chart;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = color(chart, "accent", 0.25);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, a.top);
    ctx.lineTo(Math.round(x) + 0.5, a.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

/** Small titles at the top-left of each stacked panel. */
export const panelLabels = {
  id: "sdPanelLabels",
  afterDatasetsDraw(chart) {
    const { labels, compact } = chart.$sd.options;
    if (compact || !labels) return;
    const { ctx, chartArea: a, legend } = chart;
    ctx.save();
    ctx.font = font(11);
    ctx.textBaseline = "middle";
    // The main panel's title sits above the plot, on the legend row (the
    // keys align right) or in the top padding, so it never covers data.
    const primary = chart.scales.y && labels.primary;
    if (primary) {
      const shown = legend?.options?.display && legend.legendHitBoxes?.length;
      const y = shown ? legend.legendHitBoxes[0].top + legend.legendHitBoxes[0].height / 2 : a.top - 9;
      const room = shown ? legend.legendHitBoxes[0].left - a.left - 16 : Infinity;
      if (ctx.measureText(primary).width <= room) {
        ctx.fillStyle = color(chart, "tick");
        ctx.fillText(primary, a.left, y);
      }
    }
    // A stacked panel's title sits inside it, on a backing so lines pass under.
    const y1 = chart.scales.y1;
    if (y1 && labels.secondary) {
      const w = ctx.measureText(labels.secondary).width + 8;
      ctx.fillStyle = color(chart, "cap-bg", 0.85);
      ctx.fillRect(a.left + 1, y1.top + 1, w, 15);
      ctx.fillStyle = color(chart, "rtt");
      ctx.fillText(labels.secondary, a.left + 5, y1.top + 9);
    }
    ctx.restore();
  },
};

const RANGE_FILL = { maintenance: "maintenance", missing: "missing", alert: "alert", dip: "dip", spike: "spike" };
const RANGE_STROKE = { maintenance: "accent", alert: "critical", dip: "down", spike: "critical" };

/** Shaded time ranges with labels: maintenance, missing data, alerts. */
export const ranges = {
  id: "sdRanges",
  beforeDatasetsDraw(chart) {
    const list = chart.$sd.options.ranges;
    if (!list?.length) return;
    const { ctx, chartArea: a, scales } = chart;
    const y = scales.y;
    ctx.save();
    const rows = [];
    for (const r of list) {
      const x0 = Math.max(a.left, scales.x.getPixelForValue(r.from));
      const x1 = Math.min(a.right, scales.x.getPixelForValue(r.to));
      if (!(x1 > x0)) continue;
      const kind = RANGE_FILL[r.kind] ? r.kind : "alert";
      // Missing data covers only the main panel; the latency lane has its own gaps.
      const top = kind === "missing" && y ? y.top : a.top;
      const bottom = kind === "missing" && y ? y.bottom : a.bottom;
      ctx.fillStyle = color(chart, RANGE_FILL[kind]);
      ctx.fillRect(x0, top, x1 - x0, bottom - top);
      if (RANGE_STROKE[kind] && kind !== "missing") {
        ctx.strokeStyle = color(chart, RANGE_STROKE[kind], 0.5);
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x0) + 0.5, top + 0.5, Math.round(x1 - x0) - 1, bottom - top - 1);
      }
      const minWidth = kind === "alert" ? 74 : 120;
      if (r.label && x1 - x0 >= minWidth) {
        let row = 0;
        while (rows.some((o) => o.row === row && o.x1 > x0 && o.x0 < x1)) row++;
        rows.push({ row, x0, x1 });
        ctx.font = font(11, 600);
        ctx.textBaseline = "top";
        ctx.fillStyle = color(chart, RANGE_STROKE[kind] || "label");
        ctx.fillText(String(r.label).slice(0, 32), x0 + 6, top + 4 + row * 15);
      }
    }
    ctx.restore();
  },
};

/** The drag selection. */
export const selection = {
  id: "sdSelection",
  beforeDatasetsDraw(chart) {
    const s = chart.$sd.selection;
    if (!s) return;
    const { ctx, chartArea: a, scales } = chart;
    const x0 = Math.max(a.left, scales.x.getPixelForValue(Math.min(s.from, s.to)));
    const x1 = Math.min(a.right, scales.x.getPixelForValue(Math.max(s.from, s.to)));
    ctx.save();
    ctx.fillStyle = color(chart, "accent", 0.16);
    ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
    ctx.strokeStyle = color(chart, "accent", 0.42);
    ctx.strokeRect(Math.round(x0) + 0.5, a.top + 0.5, Math.round(x1 - x0) - 1, a.bottom - a.top - 1);
    ctx.restore();
  },
};

/** Shade the forecast side of the axis and mark the boundary. */
export const forecast = {
  id: "sdForecast",
  beforeDatasetsDraw(chart) {
    const from = chart.$sd.options.forecastFrom;
    if (from == null) return;
    const { ctx, chartArea: a, scales } = chart;
    const x = scales.x.getPixelForValue(from);
    if (!(x < a.right)) return;
    const left = Math.max(a.left, x);
    ctx.save();
    ctx.fillStyle = color(chart, "forecast", 0.035);
    ctx.fillRect(left, a.top, a.right - left, a.bottom - a.top);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = color(chart, "forecast", 0.45);
    ctx.beginPath();
    ctx.moveTo(Math.round(left) + 0.5, a.top);
    ctx.lineTo(Math.round(left) + 0.5, a.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = font(10);
    ctx.textBaseline = "top";
    ctx.fillStyle = color(chart, "forecast", 0.8);
    ctx.fillText("FORECAST", left + 6, a.top + 4);
    ctx.restore();
  },
};

/** Multi-day windows: day boundaries and working hours. */
export const rhythm = {
  id: "sdRhythm",
  beforeDatasetsDraw(chart) {
    const opt = chart.$sd.options.rhythm;
    if (!opt) return;
    const { ctx, chartArea: a, scales } = chart;
    const { min, max } = scales.x;
    if (max - min < 2 * 864e5) return;
    const [from, to] = opt.hours ?? [7.5, 15.5];
    ctx.save();
    const day = new Date(min);
    day.setHours(0, 0, 0, 0);
    let drawn = 0;
    for (let t = day.getTime(); t <= max && drawn < 16; t += 864e5) {
      const d = new Date(t);
      if (d.getDay() > 0 && d.getDay() < 6) {
        const x0 = Math.max(a.left, scales.x.getPixelForValue(t + from * 36e5));
        const x1 = Math.min(a.right, scales.x.getPixelForValue(t + to * 36e5));
        if (x1 > x0) {
          ctx.fillStyle = color(chart, "hours");
          ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
        }
      }
      if (t > min) {
        const x = Math.round(scales.x.getPixelForValue(t)) + 0.5;
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = color(chart, "day");
        ctx.beginPath();
        ctx.moveTo(x, a.top);
        ctx.lineTo(x, a.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        drawn++;
      }
    }
    ctx.restore();
  },
};

/** A square dot and ring on each live series' newest point. */
export const liveEdge = {
  id: "sdLiveEdge",
  afterDatasetsDraw(chart) {
    const live = chart.$sd.options.live;
    if (!(live >= 1 && live <= 10)) return;
    const { ctx } = chart;
    ctx.save();
    for (const i of lineIndexes(chart, { visual: true })) {
      const p = newestPoint(chart, i);
      if (!p) continue;
      const c = chart.data.datasets[i]._color;
      ctx.fillStyle = rgba(c, 0.95);
      ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5);
      ctx.strokeStyle = rgba(c, 0.3);
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x - 5.5, p.y - 5.5, 11, 11);
    }
    ctx.restore();
  },
};

/** Right-gutter value tags for the newest point of each line. */
export const valueTags = {
  id: "sdValueTags",
  afterDatasetsDraw(chart) {
    if (!chart.$sd.valueTags) return;
    const { ctx, chartArea: a } = chart;
    const tags = [];
    for (const i of lineIndexes(chart)) {
      const ds = chart.data.datasets[i];
      const p = newestPoint(chart, i);
      if (!p) continue;
      // A series that stopped reporting gets no tag.
      if (chart.$sd.newestX - p.time > (chart.$sd.bucketMs || 10_000) * 3) continue;
      // Sit the tag on the drawn line (the trend, when the raw line is faint).
      const drawn = (ds._visualIndex != null && newestPoint(chart, ds._visualIndex)) || p;
      tags.push({ y: drawn.y, text: formatValue(p.value, ds._unit), color: ds._color });
    }
    tags.sort((m, n) => m.y - n.y);
    for (let k = 1; k < tags.length; k++) tags[k].y = Math.max(tags[k].y, tags[k - 1].y + 18);
    ctx.save();
    ctx.font = font(10, 600);
    ctx.textBaseline = "middle";
    for (const t of tags) {
      const w = ctx.measureText(t.text).width + 10;
      ctx.fillStyle = rgba(t.color);
      ctx.fillRect(a.right + 4, t.y - 8, w, 16);
      ctx.fillStyle = color(chart, "tag-text");
      ctx.fillText(t.text, a.right + 9, t.y);
    }
    ctx.restore();
  },
};

/** Peaks cut off by a clamped axis: a marker at the top with the real value. */
export const offScaleCaps = {
  id: "sdOffScaleCaps",
  afterDatasetsDraw(chart) {
    const ceiling = chart.$sd.ceiling;
    if (ceiling == null) return;
    const { ctx, chartArea: a, scales } = chart;
    const y = scales.y;
    const caps = [];
    for (const i of lineIndexes(chart)) {
      const ds = chart.data.datasets[i];
      if (ds.yAxisID !== "y") continue;
      const src = ds._source;
      let run = null;
      const flush = () => {
        if (run) caps.push({ x: scales.x.getPixelForValue(run.x), value: run.y, color: ds._color, unit: ds._unit, up: !ds._kind || ds._kind !== "up" });
        run = null;
      };
      for (const p of src) {
        if (p.y != null && p.y > ceiling) {
          if (!run || p.y > run.y) run = { ...p, start: run?.start ?? p.x };
        } else flush();
      }
      flush();
    }
    if (!caps.length) return;
    ctx.save();
    ctx.font = font(11, 600);
    ctx.textBaseline = "top";
    caps.sort((m, n) => m.x - n.x);
    let lastRight = -Infinity;
    for (const c of caps) {
      if (c.x < a.left || c.x > a.right) continue;
      ctx.fillStyle = rgba(c.color);
      ctx.beginPath();
      ctx.moveTo(c.x - 4, y.top + 6);
      ctx.lineTo(c.x + 4, y.top + 6);
      ctx.lineTo(c.x, y.top);
      ctx.closePath();
      ctx.fill();
      const text = `↑ ${formatValue(c.value, c.unit)}`;
      const w = ctx.measureText(text).width + 10;
      let x = Math.min(Math.max(c.x - w / 2, a.left), a.right - w);
      if (x < lastRight + 6) continue;
      lastRight = x + w;
      ctx.fillStyle = color(chart, "cap-bg", 0.9);
      ctx.fillRect(x, y.top + 9, w, 17);
      ctx.strokeStyle = rgba(c.color);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y.top + 9.5, w - 1, 16);
      ctx.fillStyle = rgba(c.color);
      ctx.fillText(text, x + 5, y.top + 12);
    }
    ctx.restore();
  },
};

/** Tooltip beside the cursor; flips left past the middle. */
export function cursorPositioner(items, position) {
  if (!items.length || !position) return false;
  const area = this.chart.chartArea;
  const right = position.x > (area.left + area.right) / 2;
  return { x: position.x + (right ? -24 : 24), y: position.y, xAlign: right ? "right" : "left", yAlign: "center" };
}

/**
 * Interaction mode "sdTime": the point nearest the pointer's time in every
 * visible series, so series on different time grids share one tooltip.
 */
export function timeMode(chart, event) {
  const x = event.x;
  const items = [];
  const tolerance = (chart.$sd.bucketMs || 10_000) * 1.5;
  const time = chart.scales.x.getValueForPixel(x);
  chart.data.datasets.forEach((ds, datasetIndex) => {
    if (!chart.isDatasetVisible(datasetIndex) || ds._noHover) return;
    const data = ds.data;
    let lo = 0;
    let hi = data.length - 1;
    if (hi < 0) return;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (data[mid].x <= time) lo = mid;
      else hi = mid;
    }
    const index = Math.abs(data[lo].x - time) <= Math.abs(data[hi].x - time) ? lo : hi;
    if (data[index].y == null || Math.abs(data[index].x - time) > tolerance) return;
    const element = chart.getDatasetMeta(datasetIndex).data[index];
    if (element) items.push({ element, datasetIndex, index });
  });
  return items;
}

/** Tooltip title: the bucket span for fine data, else date and time. */
export function tooltipTitle(chart, items) {
  const x = items[0]?.raw?.x;
  if (x == null) return "";
  const bucket = chart.$sd.bucketMs / 1000;
  if (bucket && bucket <= 60) {
    return `${formatTime(x, "MMM d, h:mm:ss")} → ${formatTime(x + bucket * 1000, "h:mm:ss")} · ${bucket}s bucket`;
  }
  return formatTime(x, "MMM d, h:mm a");
}

export const ALL = [pointer, rhythm, forecast, ranges, selection, crosshair, panelLabels, liveEdge, valueTags, offScaleCaps];
