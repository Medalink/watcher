/**
 * signal-design/charts: time-series charts on Chart.js (an optional peer
 * dependency; nothing in signal-design/js imports this module).
 *
 *   import { createChart } from "signal-design/charts";
 *   const core = createChart(canvas, {
 *     preset: "core",             // "bandwidth" | "latency" | "core" (both, stacked)
 *     series: [
 *       { label: "Core ↓", data: [{ x: ms, y: mbps }, …] },
 *       { label: "Core ↑", data: […] },
 *       { label: "Core → MDF RTT", unit: " ms", data: […], min: […], max: […] },
 *     ],
 *     bucketSeconds: 10, live: 10,
 *   });
 *   core.append({ "Core ↓": [{ x, y }] });
 *
 * The canvas sits in .sd-chart-plot inside a .sd-chart frame; colors come
 * from the frame's --sd-chart-* tokens (data-chart-theme="mono|spectrum").
 */
import {
  Chart, LineController, LineElement, PointElement, LinearScale, TimeScale, Filler, Tooltip, Legend,
  Interaction, _adapters, Scale, BarController, BarElement, CategoryScale, ScatterController,
} from "chart.js";
import { formatValue, formatDelta } from "./format.js";
import { SCALE_MODES, scaleBounds, smooth, envelope, bursts, significance, flowRate, upsertTail } from "./data.js";
import { createSymlogScale } from "./scales.js";
import { timeAdapter, formatTime } from "./time.js";
import { FONT, readTheme, rgba, mix, kindOf } from "./theme.js";
import * as plugins from "./plugins.js";
import { createLayer, effectsLevel } from "./effects.js";
import { createBasicChart } from "./basic.js";

export { formatValue, formatBandwidth, formatMs, formatDelta } from "./format.js";
export { SCALE_MODES, percentile, scaleBounds, smooth, envelope, bursts, significance, flowRate } from "./data.js";
export { setEffectsLevel, effectsLevel, EFFECTS } from "./effects.js";
export { formatTime } from "./time.js";

let registered = false;
function register() {
  if (registered) return;
  registered = true;
  Chart.register(
    LineController, LineElement, PointElement, LinearScale, TimeScale, Filler, Tooltip, Legend,
    BarController, BarElement, CategoryScale, ScatterController, createSymlogScale(Scale),
  );
  _adapters._date.override(timeAdapter);
  Tooltip.positioners.sdCursor = plugins.cursorPositioner;
  Interaction.modes.sdTime = plugins.timeMode;
}

const SCALE_KEY = "sd-chart-scale";
const PRESETS = {
  bandwidth: { unit: "Mbps", labels: { primary: "aggregate bandwidth" } },
  latency: { unit: " ms", labels: { primary: "path health · RTT ms + jitter band" } },
  core: { unit: "Mbps", labels: { primary: "aggregate bandwidth", secondary: "core path health · RTT ms + jitter band" } },
};
const HEAT_WARM = 0.55;
const HEAT_HOT = 0.8;

function storedScaleMode() {
  try {
    const mode = localStorage.getItem(SCALE_KEY);
    return SCALE_MODES.includes(mode) ? mode : null;
  } catch {
    return null;
  }
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} options see README "Charts"
 */
export function createChart(canvas, options = {}) {
  register();
  // Generic charts (line, area, bar, …) share the tokens but not the
  // time-series engine.
  if (options.type) return createBasicChart(canvas, options);
  const preset = PRESETS[options.preset] ? options.preset : "bandwidth";
  const frame = canvas.closest(".sd-chart") ?? canvas.parentElement;
  const plot = canvas.closest(".sd-chart-plot") ?? canvas.parentElement;
  const opts = {
    compact: false,
    heat: true,
    rhythm: true,
    select: true,
    zoom: false,
    secondaryWeight: 26,
    labels: PRESETS[preset].labels,
    ...options,
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let scaleMode = opts.scaleMode ?? storedScaleMode() ?? "clamp";
  const bucketMs = (opts.bucketSeconds ?? 10) * 1000;

  // Source series, keyed by label; the chart's datasets are derived from them.
  const sources = (opts.series ?? []).map((s) => ({
    ...s,
    unit: s.unit ?? (s.axis === "y1" || /rtt|latency|ping/i.test(s.label) ? " ms" : PRESETS[preset].unit),
    kind: kindOf(s),
    data: (s.data ?? []).map((p) => ({ x: +p.x, y: p.y == null ? null : +p.y })),
    min: s.min?.map((p) => ({ x: +p.x, y: p.y == null ? null : +p.y })),
    max: s.max?.map((p) => ({ x: +p.x, y: p.y == null ? null : +p.y })),
  }));
  for (const s of sources) {
    s.axis = s.axis ?? (preset === "core" && s.unit.trim() === "ms" ? "y1" : "y");
  }

  let theme = readTheme(frame);
  const state = {
    theme,
    options: opts,
    hoverX: null,
    selection: null,
    ceiling: null,
    bucketMs,
    newestX: 0,
    valueTags: !opts.compact && opts.live > 0,
  };

  /* ---- datasets ------------------------------------------------------- */

  function colorFor(kind, explicit) {
    if (explicit) {
      const probe = document.createElement("span");
      probe.style.color = explicit;
      frame.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return readColor(c);
    }
    return theme.colors[kind] ?? theme.colors.fallback;
  }
  const readColor = (text) => {
    const n = (text.match(/[\d.]+/g) || []).map(Number);
    return { r: n[0] ?? 0, g: n[1] ?? 0, b: n[2] ?? 0, a: n[3] ?? 1 };
  };

  function heatSegment(base) {
    const warn = theme.colors.warning;
    const hot = theme.colors.critical;
    return (ctx) => {
      const max = ctx.chart.scales.y?.max;
      if (!max) return undefined;
      const f = Math.max(ctx.p0.parsed.y, ctx.p1.parsed.y) / max;
      if (f <= HEAT_WARM) return undefined;
      const c = f < HEAT_HOT ? mix(base, warn, (f - HEAT_WARM) / (HEAT_HOT - HEAT_WARM)) : mix(warn, hot, Math.min((f - HEAT_HOT) / (1 - HEAT_HOT), 1));
      return rgba(c);
    };
  }

  function build() {
    const sets = [];
    const raw = !!opts.envelope;
    const clampSmooth = ["clamp", "p95", "p90"].includes(scaleMode);
    for (const s of sources) {
      if (s.hidden === "remove") continue;
      const c = colorFor(s.kind, s.color);
      const dash = s.dash ?? (s.ghost ? [4, 4] : theme.dashes[s.kind] ?? []);
      const tension = opts.tension ?? 0;
      const points = opts.smoothing && !raw ? smooth(s.data, opts.smoothing) : s.data;
      const line = {
        label: s.label,
        data: points,
        yAxisID: s.axis,
        _role: "line",
        _source: s.data,
        _unit: s.unit,
        _kind: s.kind,
        _color: c,
        borderColor: rgba(c),
        backgroundColor: rgba(c),
        borderWidth: s.ghost ? 1 : s.axis === "y1" ? 1.6 : opts.compact ? 1.5 : (s.borderWidth ?? 2),
        borderDash: dash,
        borderCapStyle: "round",
        borderJoinStyle: "round",
        tension,
        cubicInterpolationMode: tension > 0 ? "monotone" : "default",
        fill: false,
        pointRadius: 0,
        pointHoverRadius: s.axis === "y1" ? 5 : opts.compact ? 3 : 4,
        pointHoverBorderWidth: opts.compact ? 4 : 6,
        pointHoverBorderColor: rgba(c, 0.3),
        pointHoverBackgroundColor: rgba(c),
        pointStyle: "rect",
        pointHitRadius: 1,
        spanGaps: false,
        order: s.ghost ? 0 : 1,
      };
      if (s.ghost) line._ghost = true;
      if (opts.heat && s.axis === "y" && !s.ghost && !raw) line.segment = { borderColor: heatSegment(c) };
      if (raw && s.axis === "y" && !s.ghost) {
        // Dense raw data: the exact line is faint, a ribbon shows the spread
        // and a smoothed trend is the line people read.
        line.borderWidth = 1;
        line.borderColor = rgba(c, 0.25);
        line._hasVisual = true;
      }
      const lineIndex = sets.push(line) - 1;

      if (raw && s.axis === "y" && !s.ghost) {
        const env = envelope(s.data, opts.envelope, bucketMs);
        sets.push(
          { label: `${s.label} (max)`, data: env.max, yAxisID: "y", _role: "band", _bandOf: lineIndex, fill: "+1", backgroundColor: rgba(c, theme.band), borderWidth: 0, pointRadius: 0, pointHitRadius: 0, tension: 0, order: 2, _noHover: true },
          { label: `${s.label} (min)`, data: env.min, yAxisID: "y", _role: "band", _bandOf: lineIndex, fill: false, backgroundColor: "transparent", borderColor: "transparent", borderWidth: 0, pointRadius: 0, pointHitRadius: 0, tension: 0, order: 2, _noHover: true },
        );
        const trend = smooth(s.data, clampSmooth ? { window: 21, iterations: 3 } : { window: 13 });
        const visual = {
          label: `${s.label} trend`, data: trend, yAxisID: "y", _role: "visual", _bandOf: lineIndex, _color: c, _unit: s.unit,
          borderColor: rgba(c), borderWidth: 1.5, borderDash: dash, tension: 0, fill: false, pointRadius: 0, pointHitRadius: 0, order: 0, _noHover: true,
        };
        if (opts.heat) visual.segment = { borderColor: heatSegment(c) };
        line._visualIndex = sets.push(visual) - 1;
      }

      if (s.min && s.max) {
        const band = s.kind === "rtt" ? rgba(theme.colors.jitter) : rgba(c, theme.band);
        line._band = { min: s.min, max: s.max };
        sets.push(
          { label: `${s.label} (max)`, data: s.max, yAxisID: s.axis, _role: "band", _bandOf: lineIndex, fill: "+1", backgroundColor: band, borderWidth: 0, pointRadius: 0, pointHitRadius: 0, tension: 0, order: 2, _noHover: true },
          { label: `${s.label} (min)`, data: s.min, yAxisID: s.axis, _role: "band", _bandOf: lineIndex, fill: false, backgroundColor: "transparent", borderColor: "transparent", borderWidth: 0, pointRadius: 0, pointHitRadius: 0, tension: 0, order: 2, _noHover: true },
        );
      }

      // Burst markers: points at the 99th percentile on fine raw data.
      if (bucketMs <= 10_000 && s.axis === "y" && !s.ghost && opts.bursts !== false) {
        const b = bursts(s.data);
        if (b.length) {
          sets.push({ label: `${s.label} bursts`, data: b, yAxisID: "y", _role: "marker", _legend: false, showLine: false, pointStyle: "rect", pointRadius: 3, pointHoverRadius: 4, backgroundColor: rgba(theme.colors.burst), borderColor: rgba(theme.colors.burst), _color: theme.colors.burst, _unit: s.unit, order: 0, _noHover: true });
        }
      }
    }

    const xs = sources.flatMap((s) => [s.data[0]?.x, s.data.at(-1)?.x]).filter(Number.isFinite);
    const xMin = opts.xMin ?? Math.min(...xs);
    const xMax = opts.xMax ?? Math.max(...xs);
    const across = (value) => [{ x: xMin, y: value }, { x: xMax, y: value }];
    for (const t of opts.thresholds ?? []) {
      const c = theme.colors[t.level === "critical" ? "critical" : "warning"];
      sets.push({ label: t.label ?? t.level, data: across(t.value), yAxisID: t.axis ?? "y", _role: "threshold", _color: c, _unit: t.unit ?? PRESETS[preset].unit, borderColor: rgba(c), borderWidth: 1, borderDash: [6, 4], pointRadius: 0, pointHitRadius: 0, fill: false, order: 3, _noHover: true });
    }
    for (const b of opts.baselines ?? []) {
      const c = b.color ? colorFor(null, b.color) : theme.colors.baseline;
      sets.push({ label: b.label ?? "baseline", data: across(b.value), yAxisID: b.axis ?? "y", _role: "threshold", _color: c, borderColor: rgba(c), borderWidth: 1, borderDash: [3, 4], pointRadius: 0, pointHitRadius: 0, fill: false, order: 3, _noHover: true });
    }
    const events = opts.events ?? [];
    for (const kind of ["surge", "drop"]) {
      const list = events.filter((e) => e.kind === kind);
      if (!list.length) continue;
      const c = theme.colors[kind];
      sets.push({ label: kind, data: list.map((e) => ({ x: +e.x, y: e.y, label: e.label, unexpected: e.unexpected })), yAxisID: "y", _role: "event", _eventKind: kind, _color: c, _unit: PRESETS[preset].unit, showLine: false, pointStyle: "rect", pointRadius: 4, pointHoverRadius: 5, backgroundColor: rgba(c), borderColor: rgba(c), order: 0 });
    }
    if (opts.peaks?.length) {
      const c = theme.colors.burst;
      sets.push({ label: "daily peak", data: opts.peaks.map((p) => ({ x: +p.x, y: p.y })), yAxisID: "y", _role: "event", _color: c, _unit: PRESETS[preset].unit, showLine: false, pointStyle: "rect", pointRadius: 5, pointHoverRadius: 6, borderWidth: 1.5, backgroundColor: "transparent", borderColor: rgba(c), order: 0 });
    }
    return { sets, xMin, xMax };
  }

  /* ---- scales ---------------------------------------------------------- */

  function yBounds() {
    const ys = sources.filter((s) => s.axis === "y" && !s.ghost).flatMap((s) => s.data.map((p) => p.y));
    const floor = Math.max(0, ...(opts.thresholds ?? []).filter((t) => (t.axis ?? "y") === "y").map((t) => t.value));
    const b = scaleBounds(ys, scaleMode, floor);
    state.ceiling = b.ceiling;
    return b;
  }

  function timeUnit(span) {
    if (span <= 2 * 36e5) return "minute";
    if (span <= 36 * 36e5) return "hour";
    return "day";
  }

  function scales(xMin, xMax) {
    const t = theme.colors;
    const size = opts.compact ? 11 : 13;
    const grid = { color: rgba(t.grid), drawTicks: false };
    const ticks = { color: rgba(t.tick), font: { family: FONT, size }, padding: 8 };
    const b = yBounds();
    const stacked = preset === "core";
    const primaryUnit = PRESETS[preset].unit;
    const result = {
      x: {
        type: "time",
        min: xMin,
        max: xMax,
        time: { unit: timeUnit(xMax - xMin), displayFormats: { minute: "h:mm a", hour: "h a", day: "MMM d" }, tooltipFormat: "MMM d, h:mm a" },
        grid,
        border: { display: false },
        ticks: { ...ticks, maxRotation: 0, autoSkipPadding: 24 },
      },
    };
    if (stacked) {
      // Defined first so it stacks below the bandwidth panel.
      result.y1 = {
        type: "linear",
        position: "left",
        stack: "core",
        stackWeight: opts.secondaryWeight,
        min: 0,
        grid: { ...grid, drawOnChartArea: true },
        border: { display: false },
        ticks: { ...ticks, display: !opts.compact, maxTicksLimit: 4, callback: (v) => formatValue(v, " ms") },
      };
    }
    result.y = {
      type: scaleMode === "log" ? "sdSymlog" : "linear",
      position: "left",
      min: 0,
      max: b.max,
      grid,
      border: { display: false },
      ticks: {
        ...ticks,
        callback: (v, i) => (stacked && i === 0 ? "" : formatValue(v, primaryUnit)),
      },
      ...(stacked ? { stack: "core", stackWeight: Math.max(10, 100 - opts.secondaryWeight) } : {}),
    };
    if (preset === "latency") delete result.y.max;
    return result;
  }

  /* ---- chart ----------------------------------------------------------- */

  const built = build();
  state.newestX = built.xMax;
  let defaultX = { min: built.xMin, max: built.xMax };

  const chart = new Chart(canvas, {
    type: "line",
    data: { datasets: built.sets },
    // State is attached before the first layout so every plugin can read it.
    plugins: [{ id: "sdState", beforeInit: (c) => (c.$sd = state) }, ...plugins.ALL],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      normalized: true,
      animation: false,
      interaction: { mode: "sdTime", intersect: false, axis: "x" },
      layout: { padding: { top: opts.compact ? 2 : opts.legend === false && opts.labels?.primary ? 20 : 4, right: state.valueTags ? 64 : 4, bottom: 0, left: 0 } },
      scales: scales(built.xMin, built.xMax),
      plugins: {
        legend: legendOptions(),
        tooltip: tooltipOptions(),
      },
    },
  });
  chart.$sd = state;

  function legendOptions() {
    const t = theme.colors;
    return {
      display: !opts.compact && opts.legend !== false,
      position: "top",
      align: "end",
      labels: {
        color: rgba(t.tick),
        font: { family: FONT, size: 12 },
        boxWidth: 14,
        boxHeight: 2,
        padding: 14,
        filter: (item, data) => {
          const ds = data.datasets[item.datasetIndex];
          return ds && ds._role !== "band" && ds._role !== "visual" && ds._role !== "marker" && !/\((min|max)\)/.test(ds.label);
        },
        generateLabels: (c) => {
          const items = Chart.defaults.plugins.legend.labels.generateLabels(c);
          for (const item of items) {
            const ds = c.data.datasets[item.datasetIndex];
            if (!ds?._color) continue;
            item.fillStyle = rgba(ds._color);
            item.strokeStyle = rgba(ds._color);
            item.lineWidth = 0;
            item.fontColor = rgba(t.tick);
          }
          if ((opts.ranges ?? []).some((r) => r.kind === "maintenance")) {
            items.push({ text: "maintenance", fillStyle: rgba(t.accent, 0.5), strokeStyle: rgba(t.accent, 0.5), lineWidth: 0, fontColor: rgba(t.tick), hidden: false, datasetIndex: -1 });
          }
          return items;
        },
      },
      onClick: (_e, item, legend) => {
        const c = legend.chart;
        const i = item.datasetIndex;
        if (i < 0) return;
        const show = !c.isDatasetVisible(i);
        c.setDatasetVisibility(i, show);
        c.data.datasets.forEach((ds, k) => {
          if (ds._bandOf === i) c.setDatasetVisibility(k, show);
        });
        c.update("none");
      },
    };
  }

  function tooltipOptions() {
    const t = theme.colors;
    return {
      position: "sdCursor",
      backgroundColor: rgba(t["tooltip-bg"], 0.95),
      titleColor: rgba(t["tooltip-title"]),
      bodyColor: rgba(t["tooltip-body"]),
      borderColor: rgba(t["tooltip-line"]),
      borderWidth: 1,
      cornerRadius: 0,
      caretSize: 0,
      padding: { top: 10, right: 12, bottom: 10, left: 12 },
      titleFont: { family: FONT, size: 13, weight: 600 },
      bodyFont: { family: FONT, size: 13 },
      titleMarginBottom: 6,
      displayColors: true,
      boxWidth: 10,
      boxHeight: 10,
      boxPadding: 5,
      filter: (item) => {
        const ds = item.dataset;
        return ds._role === "line" || ds._role === "event";
      },
      callbacks: {
        title: (items) => plugins.tooltipTitle(chart, items),
        label: (item) => {
          const ds = item.dataset;
          const p = item.raw;
          if (ds._role === "event") return ` ${ds.label}${p.label ? ` · ${p.label}` : ""}: ${formatValue(p.y, ds._unit)}`;
          let text = ` ${ds.label}: ${formatValue(p.y, ds._unit)}`;
          if (ds._band) {
            const lo = nearest(ds._band.min, p.x);
            const hi = nearest(ds._band.max, p.x);
            if (lo != null && hi != null) {
              text += ds._kind === "rtt" ? ` · jitter ±${formatValue(Math.round(((hi - lo) / 2) * 100) / 100, " ms").trim()}` : ` · range ${formatValue(lo, ds._unit)} – ${formatValue(hi, ds._unit)}`;
            }
          }
          if (bucketMs <= 10_000) {
            const prev = ds.data[item.dataIndex - 1];
            if (prev?.y != null) text += formatDelta(p.y - prev.y, ds._unit);
          }
          return text;
        },
        labelColor: (item) => ({ borderColor: rgba(item.dataset._color), backgroundColor: rgba(item.dataset._color), borderWidth: 0, borderRadius: 0 }),
        afterBody: (items) => {
          const x = items[0]?.raw?.x;
          const r = (opts.ranges ?? []).find((range) => x >= range.from && x <= range.to);
          return r ? [`${r.label ?? r.kind}${r.detail ? ` · ${r.detail}` : ""}`] : [];
        },
      },
    };
  }

  function nearest(points, x) {
    let best = null;
    for (const p of points) {
      if (p.x > x + bucketMs * 1.5) break;
      if (Math.abs(p.x - x) <= bucketMs * 1.5) best = p.y;
    }
    return best;
  }

  /* ---- theme ------------------------------------------------------------ */

  function refresh() {
    const x = chart.options.scales.x;
    const { sets } = build();
    // Keep legend toggles across rebuilds.
    const hidden = new Set(chart.data.datasets.filter((_, i) => !chart.isDatasetVisible(i)).map((d) => d.label));
    chart.data.datasets = sets;
    chart.options.scales = scales(x.min, x.max);
    chart.options.plugins.legend = legendOptions();
    chart.options.plugins.tooltip = tooltipOptions();
    chart.update("none");
    sets.forEach((ds, i) => hidden.has(ds.label) && chart.setDatasetVisibility(i, false));
    if (hidden.size) chart.update("none");
  }
  const onTheme = () =>
    requestAnimationFrame(() => {
      theme = readTheme(frame);
      state.theme = theme;
      refresh();
    });
  document.addEventListener("sd:theme", onTheme);
  const scheme = matchMedia("(prefers-color-scheme: light)");
  scheme.addEventListener("change", onTheme);
  // Canvas text needs the font loaded before the first real layout.
  document.fonts?.load?.(`13px ${FONT}`).then(() => chart.update("none"), () => {});

  /* ---- scale mode toolbar ------------------------------------------------ */

  const toolbar = frame.querySelector("[data-sd-chart-scale]");
  function syncToolbar() {
    for (const b of toolbar?.querySelectorAll("[data-value]") ?? []) b.setAttribute("aria-pressed", String(b.dataset.value === scaleMode));
  }
  const onToolbar = (e) => {
    const b = e.target.closest("[data-value]");
    if (b) api.setScaleMode(b.dataset.value);
  };
  toolbar?.addEventListener("click", onToolbar);
  syncToolbar();

  /* ---- selection and zoom ------------------------------------------------ */

  let drag = null;
  const timeAt = (e) => {
    const r = canvas.getBoundingClientRect();
    return chart.scales.x.getValueForPixel(e.clientX - r.left);
  };
  const onDown = (e) => {
    if (!opts.select || e.button !== 0) return;
    const r = canvas.getBoundingClientRect();
    const a = chart.chartArea;
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x < a.left || x > a.right || y < a.top || y > a.bottom) return;
    drag = { from: timeAt(e), to: timeAt(e), startX: e.clientX };
  };
  const onMove = (e) => {
    if (!drag) return;
    drag.to = timeAt(e);
    if (Math.abs(e.clientX - drag.startX) > 3) {
      state.selection = { from: drag.from, to: drag.to };
      chart.draw();
    }
  };
  const onUp = (e) => {
    if (!drag) return;
    const moved = Math.abs(e.clientX - drag.startX) > 3;
    const range = { from: Math.min(drag.from, drag.to), to: Math.max(drag.from, drag.to) };
    drag = null;
    if (!moved) return;
    canvas.dispatchEvent(new CustomEvent("sd:chart-select", { bubbles: true, detail: range }));
    if (opts.zoom) {
      state.selection = null;
      api.setWindow(range.from, range.to);
    }
  };
  const onDbl = () => {
    state.selection = null;
    if (opts.zoom) api.setWindow(defaultX.min, defaultX.max);
    else chart.draw();
  };
  canvas.addEventListener("pointerdown", onDown);
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
  canvas.addEventListener("dblclick", onDbl);

  /* ---- effects ------------------------------------------------------------ */

  const level = opts.effects ?? (opts.compact ? "off" : effectsLevel());
  const layer = level !== "off" && plot.getBoundingClientRect().height >= 200 ? createLayer(plot, reduced.matches ? "off" : level) : null;
  if (layer) layer.expectedMs = Math.max((opts.live || 10) * 1000, 250);

  function geometry() {
    if (!layer) return;
    const a = chart.chartArea;
    const x = chart.scales.x;
    // Additive glow reads on dark surfaces only.
    const dark = luminance(readColorOf(frame, "background-color") ?? { r: 0, g: 0, b: 0 }) < 0.5;
    const paths = [];
    const tips = [];
    for (const i of plugins.lineIndexes(chart, { visual: true })) {
      const ds = chart.data.datasets[i];
      if (ds.yAxisID !== "y" || ds._ghost) continue;
      const meta = chart.getDatasetMeta(i).data;
      const samples = [];
      let segment = 0;
      ds.data.forEach((p, k) => {
        const el = meta[k];
        if (p.y == null || !el || !Number.isFinite(el.y)) {
          segment++;
          return;
        }
        samples.push({ x: el.x, y: el.y, segment, breakBefore: samples.length > 0 && samples.at(-1).segment !== segment });
      });
      const ys = ds.data.map((p) => p.y).filter(Number.isFinite);
      paths.push({ id: ds.label, samples, color: ds._color, rate: flowRate(ys.at(-1), Math.max(...ys)) });
      if (opts.live > 0) {
        const tip = plugins.newestPoint(chart, i);
        if (tip) tips.push({ x: tip.x, y: tip.y, color: ds._color });
      }
    }
    const targets = [];
    chart.data.datasets.forEach((ds, i) => {
      if (ds._role !== "event" || !ds._eventKind || !chart.isDatasetVisible(i)) return;
      chart.getDatasetMeta(i).data.forEach((el, k) => {
        if (ds.data[k].unexpected && el.x >= a.left && el.x <= a.right) targets.push({ x: el.x, y: el.y, color: ds._color });
      });
    });
    layer.resize();
    layer.setGeometry({
      paths,
      tips,
      targets,
      xScale: { minMs: x.min, maxMs: x.max, leftPx: a.left, rightPx: a.right },
      colors: { glint: theme.colors.glint, stale: theme.colors.stale, dead: theme.colors.dead, dark },
    });
  }
  const geometryPlugin = { id: "sdGeometry", afterRender: () => queueGeometry() };
  chart.config.plugins.push(geometryPlugin);
  let geomQueued = 0;
  function queueGeometry() {
    if (!layer || geomQueued) return;
    geomQueued = requestAnimationFrame(() => {
      geomQueued = 0;
      geometry();
    });
  }
  chart.update("none");

  /* ---- live ---------------------------------------------------------------- */

  let scroll = 0;
  let lastScroll = performance.now();
  if (opts.live > 0 && opts.scroll !== false) {
    scroll = setInterval(() => {
      const now = performance.now();
      const elapsed = now - lastScroll;
      if (document.hidden || state.hoverX != null || drag || state.zoomed) {
        lastScroll = now;
        return;
      }
      const x = chart.options.scales.x;
      const px = (elapsed / (x.max - x.min)) * (chart.chartArea.right - chart.chartArea.left);
      if (px < 1) return;
      // Stop drifting once the newest point is more than five minutes old.
      if (x.max + elapsed - state.newestX > 300_000) return;
      x.min += elapsed;
      x.max += elapsed;
      lastScroll = now;
      chart.update("none");
    }, 500);
  }

  const api = {
    chart,
    /** Add or replace points by label: { "Core ↓": [{ x, y }], … }. */
    append(updates) {
      let magnitude = 1;
      for (const [label, points] of Object.entries(updates)) {
        const s = sources.find((src) => src.label === label);
        if (!s) continue;
        upsertTail(s.data, points.map((p) => ({ x: +p.x, y: p.y == null ? null : +p.y })));
        if (s.min && points.some((p) => p.min != null)) upsertTail(s.min, points.filter((p) => p.min != null).map((p) => ({ x: +p.x, y: +p.min })));
        if (s.max && points.some((p) => p.max != null)) upsertTail(s.max, points.filter((p) => p.max != null).map((p) => ({ x: +p.x, y: +p.max })));
        if (s.axis === "y") magnitude = Math.max(magnitude, significance(s.data));
        if (opts.window) {
          const cut = s.data.at(-1).x - opts.window;
          while (s.data.length && s.data[0].x < cut) s.data.shift();
          while (s.min?.length && s.min[0].x < cut) s.min.shift();
          while (s.max?.length && s.max[0].x < cut) s.max.shift();
        }
      }
      const newest = Math.max(...sources.map((s) => s.data.at(-1)?.x ?? 0));
      const x = chart.options.scales.x;
      if (!state.zoomed && newest > state.newestX) {
        const shift = Math.max(0, newest - x.max);
        x.min += shift;
        x.max += shift;
        defaultX = { min: x.min, max: x.max };
      }
      state.newestX = newest;
      lastScroll = performance.now();
      refresh();
      // The effects layer rings the newest points; the chart itself is not
      // redrawn per frame for it.
      layer?.ingest(magnitude);
    },
    /** "clamp" | "p95" | "p90" | "linear" | "log"; remembered. */
    setScaleMode(mode) {
      if (!SCALE_MODES.includes(mode)) return;
      scaleMode = mode;
      try {
        localStorage.setItem(SCALE_KEY, mode);
      } catch {
        /* storage blocked */
      }
      syncToolbar();
      refresh();
      canvas.dispatchEvent(new CustomEvent("sd:chart-scale", { bubbles: true, detail: { mode } }));
    },
    get scaleMode() {
      return scaleMode;
    },
    /** Show a time window; called with no arguments it resets. */
    setWindow(from = defaultX.min, to = defaultX.max) {
      const x = chart.options.scales.x;
      x.min = from;
      x.max = to;
      state.zoomed = from !== defaultX.min || to !== defaultX.max;
      x.time.unit = timeUnit(to - from);
      chart.update("none");
    },
    /** Highlight a range (or clear with null). */
    select(range) {
      state.selection = range;
      chart.draw();
    },
    /** Replace the shaded ranges. */
    setRanges(list) {
      opts.ranges = list;
      refresh();
    },
    destroy() {
      clearInterval(scroll);
      cancelAnimationFrame(geomQueued);
      toolbar?.removeEventListener("click", onToolbar);
      canvas.removeEventListener("pointerdown", onDown);
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onUp);
      canvas.removeEventListener("dblclick", onDbl);
      document.removeEventListener("sd:theme", onTheme);
      scheme.removeEventListener("change", onTheme);
      layer?.destroy();
      chart.$sd = null;
      chart.destroy();
    },
  };
  canvas.sdChart = api;
  return api;
}

function readColorOf(el, prop) {
  let node = el;
  while (node && node.nodeType === 1) {
    const c = getComputedStyle(node)[prop === "background-color" ? "backgroundColor" : prop];
    const n = (c.match(/[\d.]+/g) || []).map(Number);
    if (n.length >= 3 && (n[3] ?? 1) > 0) return { r: n[0], g: n[1], b: n[2], a: 1 };
    node = node.parentElement;
  }
  return null;
}
function luminance(c) {
  return c ? (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 : 0;
}

/**
 * Build every chart in `root` from a JSON payload, for server-rendered pages:
 *   <figure class="sd-chart" data-sd-chart>
 *     <div class="sd-chart-plot"><canvas></canvas></div>
 *     <script type="application/json">{ "preset": "core", "series": [...] }</script>
 *   </figure>
 */
export function initCharts(root = document) {
  const made = [];
  for (const fig of root.querySelectorAll("[data-sd-chart]")) {
    const canvas = fig.querySelector("canvas:not(.sd-chart-fx)");
    const payload = fig.querySelector('script[type="application/json"], template[data-chart-payload]');
    if (!canvas || canvas.sdChart || !payload) continue;
    const text = payload.content ? payload.content.textContent : payload.textContent;
    made.push(createChart(canvas, JSON.parse(text)));
  }
  return made;
}
