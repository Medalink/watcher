/**
 * Generic charts on the same tokens as the time-series presets.
 *
 *   createChart(canvas, {
 *     type: "line" | "area" | "step" | "bar" | "hbar" | "histogram" | "scatter",
 *     labels: ["Mon", "Tue", …],            // category axis (or omit for time / numeric x)
 *     series: [{ label: "p95", data: [12, 14, …] }, …],
 *     unit: " ms",                           // formatValue unit for ticks and tooltips
 *     stacked: true,                         // area and bar
 *   });
 *
 * Series take colors 1–6 from the theme in order (or `color`). In mono,
 * lines also take a dash per series so they stay apart without hue.
 */
import { Chart } from "chart.js";
import { formatValue } from "./format.js";
import { formatTime } from "./time.js";
import { FONT, readTheme, rgba } from "./theme.js";
import { pointer, crosshair, cursorPositioner } from "./plugins.js";

const DASHES = [[], [6, 3], [2, 3], [8, 3, 2, 3], [1, 2], [10, 4]];

/** Value labels at the end of each bar (ranking charts). */
const barLabels = {
  id: "sdBarLabels",
  afterDatasetsDraw(chart) {
    const st = chart.$sd;
    if (!st?.barLabels) return;
    const { ctx } = chart;
    ctx.save();
    ctx.font = `400 12px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = rgba(st.theme.colors.label);
    const horizontal = chart.options.indexAxis === "y";
    chart.data.datasets.forEach((ds, i) => {
      if (!chart.isDatasetVisible(i)) return;
      chart.getDatasetMeta(i).data.forEach((bar, k) => {
        const text = formatValue(ds.data[k], st.unit);
        if (horizontal) ctx.fillText(text, bar.x + 6, bar.y);
        else {
          ctx.textAlign = "center";
          ctx.fillText(text, bar.x, bar.y - 9);
        }
      });
    });
    ctx.restore();
  },
};

/** Dashed reference lines: percentile markers, targets, quadrant splits. */
const markers = {
  id: "sdMarkers",
  afterDatasetsDraw(chart) {
    const st = chart.$sd;
    if (!st?.markers?.length) return;
    const { ctx, chartArea: a, scales } = chart;
    ctx.save();
    ctx.font = `600 11px ${FONT}`;
    ctx.textBaseline = "top";
    for (const m of st.markers) {
      const c = st.theme.colors[m.tone ?? "accent"] ?? st.theme.colors.accent;
      ctx.strokeStyle = rgba(c, 0.7);
      ctx.fillStyle = rgba(c);
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      if (m.axis === "y") {
        const y = Math.round(scales.y.getPixelForValue(m.value)) + 0.5;
        ctx.moveTo(a.left, y);
        ctx.lineTo(a.right, y);
        ctx.stroke();
        if (m.label) ctx.fillText(m.label, a.right - ctx.measureText(m.label).width - 4, y + 4);
      } else {
        const x = Math.round(scales.x.getPixelForValue(m.value)) + 0.5;
        ctx.moveTo(x, a.top);
        ctx.lineTo(x, a.bottom);
        ctx.stroke();
        if (m.label) ctx.fillText(m.label, x + 5, a.top + 2);
      }
    }
    ctx.restore();
  },
};

export function createBasicChart(canvas, opts) {
  const frame = canvas.closest(".sd-chart") ?? canvas.parentElement;
  const type = opts.type;
  const unit = opts.unit ?? "";
  const xUnit = opts.xUnit ?? "";
  const state = {
    theme: readTheme(frame),
    options: opts,
    hoverX: null,
    unit,
    barLabels: type === "hbar" && opts.valueLabels !== false,
    markers: opts.markers ?? [],
  };
  const timeX = !opts.labels && type !== "scatter" && type !== "hbar" && (opts.series?.[0]?.data?.[0]?.x ?? 0) > 1e11;

  function datasets() {
    const t = state.theme;
    return (opts.series ?? []).map((s, i) => {
      const c = s.color ? probe(frame, s.color) : t.series[i % t.series.length];
      const line = type === "line" || type === "area" || type === "step";
      const base = {
        label: s.label,
        data: s.data,
        _color: c,
        borderColor: rgba(c),
        backgroundColor: rgba(c, type === "area" ? (opts.stacked ? 0.55 : 0.18) : 1),
        borderWidth: line ? (s.borderWidth ?? 1.75) : 0,
        pointStyle: "rect",
        pointRadius: type === "scatter" ? (s.size ?? 3) : opts.points ? 2.5 : 0,
        pointHoverRadius: type === "scatter" ? 5 : 4,
        pointHoverBorderWidth: 4,
        pointHoverBorderColor: rgba(c, 0.3),
        pointBackgroundColor: rgba(c),
        tension: 0,
        borderDash: line && t.mono && !opts.stacked ? (s.dash ?? DASHES[i % DASHES.length]) : (s.dash ?? []),
        fill: type === "area" ? (opts.stacked ? (i === 0 ? "origin" : "-1") : "origin") : false,
        stepped: type === "step" ? "before" : false,
        spanGaps: false,
        borderRadius: 0,
        borderSkipped: false,
        barPercentage: type === "histogram" ? 0.96 : 0.72,
        categoryPercentage: type === "histogram" ? 1 : 0.8,
        order: i,
      };
      if (type === "area" && opts.stacked) base.borderColor = rgba(c);
      if (s.tone) {
        const tc = t.colors[s.tone];
        if (tc) Object.assign(base, { _color: tc, borderColor: rgba(tc), backgroundColor: rgba(tc, type === "area" ? 0.18 : 1), pointBackgroundColor: rgba(tc) });
      }
      return base;
    });
  }

  function scales() {
    const t = state.theme.colors;
    const grid = { color: rgba(t.grid), drawTicks: false };
    const ticks = { color: rgba(t.tick), font: { family: FONT, size: 12 }, padding: 8 };
    const valueTicks = { ...ticks, maxTicksLimit: 6, callback: (v) => formatValue(v, unit) };
    const stacked = !!opts.stacked;
    const horizontal = type === "hbar";
    const x = timeX
      ? { type: "time", grid, border: { display: false }, ticks: { ...ticks, maxRotation: 0, autoSkipPadding: 24 }, time: { displayFormats: { minute: "h:mm a", hour: "h a", day: "MMM d" } } }
      : type === "scatter"
        ? { type: "linear", grid, border: { display: false }, ticks: { ...ticks, maxTicksLimit: 8, callback: (v) => formatValue(v, xUnit) } }
        : { type: "category", grid: { ...grid, display: type !== "bar" && type !== "histogram" && !horizontal }, border: { display: false }, ticks: { ...ticks, maxRotation: 0, autoSkipPadding: 12 } };
    if (horizontal) {
      return {
        x: { type: "linear", beginAtZero: true, grid, border: { display: false }, ticks: valueTicks, stacked },
        y: { type: "category", grid: { display: false }, border: { display: false }, ticks: { ...ticks, color: rgba(t.label) }, stacked },
      };
    }
    return {
      x: { ...x, stacked },
      y: { type: "linear", beginAtZero: opts.beginAtZero !== false, grid, border: { display: false }, ticks: valueTicks, stacked, ...(opts.yMax != null ? { max: opts.yMax } : {}) },
    };
  }

  function tooltip() {
    const t = state.theme.colors;
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
      boxWidth: 10,
      boxHeight: 10,
      boxPadding: 5,
      callbacks: {
        title: (items) => {
          const it = items[0];
          if (!it) return "";
          if (type === "scatter") return `${formatValue(it.parsed.x, xUnit)}`;
          if (timeX) return formatTime(it.parsed.x, "MMM d, h:mm a");
          return it.label;
        },
        label: (item) => ` ${item.dataset.label}: ${formatValue(type === "hbar" ? item.parsed.x : item.parsed.y, unit)}`,
        footer: (items) => {
          if (!opts.stacked || items.length < 2) return "";
          const total = items.reduce((sum, it) => sum + (type === "hbar" ? it.parsed.x : it.parsed.y), 0);
          return `Total ${formatValue(total, unit)}`;
        },
        labelColor: (item) => ({ borderColor: rgba(item.dataset._color), backgroundColor: rgba(item.dataset._color), borderWidth: 0, borderRadius: 0 }),
      },
      footerColor: rgba(t["tooltip-title"]),
      footerFont: { family: FONT, size: 12, weight: 600 },
    };
  }

  function legend() {
    const t = state.theme.colors;
    return {
      display: opts.legend ?? (opts.series?.length ?? 0) > 1,
      position: "top",
      align: "end",
      labels: {
        color: rgba(t.tick),
        font: { family: FONT, size: 12 },
        boxWidth: type === "line" || type === "step" ? 14 : 10,
        boxHeight: type === "line" || type === "step" ? 2 : 10,
        padding: 14,
        generateLabels: (c) =>
          Chart.defaults.plugins.legend.labels.generateLabels(c).map((item) => {
            const ds = c.data.datasets[item.datasetIndex];
            return { ...item, fillStyle: rgba(ds._color), strokeStyle: rgba(ds._color), lineWidth: 0, lineDash: [], fontColor: rgba(t.tick) };
          }),
      },
    };
  }

  const interaction =
    type === "scatter" ? { mode: "nearest", intersect: true } : type === "hbar" ? { mode: "index", intersect: false, axis: "y" } : { mode: "index", intersect: false, axis: "x" };

  const chart = new Chart(canvas, {
    type: type === "area" || type === "step" ? "line" : type === "hbar" || type === "histogram" ? "bar" : type,
    data: { labels: opts.labels, datasets: datasets() },
    plugins: [{ id: "sdState", beforeInit: (c) => (c.$sd = state) }, pointer, ...(type === "line" || type === "area" || type === "step" ? [crosshair] : []), barLabels, markers],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      indexAxis: type === "hbar" ? "y" : "x",
      interaction,
      layout: { padding: { top: 4, right: type === "hbar" ? 72 : 8, bottom: 0, left: 0 } },
      scales: scales(),
      plugins: { legend: legend(), tooltip: tooltip() },
    },
  });

  const refresh = () =>
    requestAnimationFrame(() => {
      state.theme = readTheme(frame);
      chart.data.datasets = datasets();
      chart.options.scales = scales();
      chart.options.plugins.legend = legend();
      chart.options.plugins.tooltip = tooltip();
      chart.update("none");
    });
  document.addEventListener("sd:theme", refresh);
  const scheme = matchMedia("(prefers-color-scheme: light)");
  scheme.addEventListener("change", refresh);
  document.fonts?.load?.(`13px ${FONT}`).then(() => chart.update("none"), () => {});

  const api = {
    chart,
    /** Replace the data: { labels?, series? } (series by position). */
    setData({ labels, series }) {
      if (labels) {
        opts.labels = labels;
        chart.data.labels = labels;
      }
      if (series) opts.series = series;
      chart.data.datasets = datasets();
      chart.update("none");
    },
    destroy() {
      document.removeEventListener("sd:theme", refresh);
      scheme.removeEventListener("change", refresh);
      chart.$sd = null;
      chart.destroy();
    },
  };
  canvas.sdChart = api;
  return api;
}

function probe(el, css) {
  const span = document.createElement("span");
  span.style.color = css;
  el.append(span);
  const n = (getComputedStyle(span).color.match(/[\d.]+/g) || []).map(Number);
  span.remove();
  return { r: n[0] ?? 0, g: n[1] ?? 0, b: n[2] ?? 0, a: n[3] ?? 1 };
}

export { cursorPositioner };
