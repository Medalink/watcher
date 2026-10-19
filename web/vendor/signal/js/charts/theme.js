/**
 * Chart colors come from CSS tokens (--sd-chart-*) on the .sd-chart frame,
 * resolved to numbers once per theme so drawing can mix alphas cheaply.
 */
export const TOKENS = [
  "grid", "tick", "label", "tooltip-bg", "tooltip-line", "tooltip-title", "tooltip-body", "tag-text", "cap-bg", "glint",
  "down", "up", "in", "out", "rtt", "jitter", "ghost", "baseline", "fallback",
  "accent", "warning", "critical", "burst", "surge", "drop",
  "maintenance", "missing", "alert", "dip", "spike", "hours", "day", "forecast", "stale", "dead",
  "1", "2", "3", "4", "5", "6", "heat",
];
const DASHES = ["up", "in", "out"];

export const FONT = "'Source Code Pro', ui-monospace, monospace";

/** "rgb(1 2 3)", "rgba(1, 2, 3, .5)" or "color(srgb .1 .2 .3 / .5)" → {r,g,b,a}. */
export function parseColor(text) {
  const nums = (text.match(/-?[\d.]+(e-?\d+)?/g) || []).map(Number);
  if (text.startsWith("color(")) {
    const [r = 0, g = 0, b = 0, a = 1] = nums;
    return { r: r * 255, g: g * 255, b: b * 255, a };
  }
  const [r = 0, g = 0, b = 0, a = 1] = nums;
  return { r, g, b, a };
}

export function rgba(c, alpha = 1) {
  if (!c) return "transparent";
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+(c.a * alpha).toFixed(4)})`;
}

/** Mix two colors; t = 0 gives a, 1 gives b. */
export function mix(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
}

/** Read every chart token under `el` (a probe resolves var() and color-mix()). */
export function readTheme(el) {
  const probe = document.createElement("span");
  probe.style.display = "none";
  el.append(probe);
  const colors = {};
  for (const name of TOKENS) {
    probe.style.color = "";
    probe.style.color = `var(--sd-chart-${name})`;
    colors[name] = parseColor(getComputedStyle(probe).color);
  }
  probe.remove();
  const style = getComputedStyle(el);
  const dashes = {};
  for (const name of DASHES) {
    const raw = style.getPropertyValue(`--sd-chart-${name}-dash`).trim();
    dashes[name] = !raw || raw === "none" ? [] : raw.split(/[\s,]+/).map(Number).filter(Number.isFinite);
  }
  const band = parseFloat(style.getPropertyValue("--sd-chart-band")) || 0.1;
  const series = ["1", "2", "3", "4", "5", "6"].map((k) => colors[k]);
  const mono = style.getPropertyValue("--sd-chart-dashes").trim() === "on";
  return { colors, dashes, band, series, mono };
}

/** Which palette slot a series uses, from its label when not given. */
export function kindOf(series) {
  if (series.kind) return series.kind;
  const label = String(series.label || "").toLowerCase();
  const up = /↑|upload|\bout\b| out$/.test(label);
  const down = /↓|download|\bin\b| in$/.test(label);
  if (label.includes("internet")) return up ? "out" : "in";
  if (/rtt|latency|ping/.test(label)) return "rtt";
  if (down) return "down";
  if (up) return "up";
  return "fallback";
}
