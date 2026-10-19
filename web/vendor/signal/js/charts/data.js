/**
 * Pure data helpers: percentiles, scale bounds, smoothing, envelopes,
 * bursts and how unusual the newest point is. No DOM, no Chart.js.
 * Points are { x: ms, y: number | null }; null breaks the line.
 */

export const SCALE_MODES = ["clamp", "p95", "p90", "linear", "log"];
const PERCENTILE = { clamp: 99, p95: 95, p90: 90 };

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/**
 * Y bounds for a scale mode. clamp, p95 and p90 cut the axis at that
 * percentile so one spike can't flatten the rest; linear and log fit all.
 * Returns { max, ceiling } where ceiling is set when values run past max.
 */
export function scaleBounds(values, mode = "clamp", floorMax = 0) {
  const abs = values.filter(Number.isFinite).map(Math.abs);
  const maxAbs = abs.length ? Math.max(...abs) : 0;
  const p = PERCENTILE[mode];
  const cut = p ? percentile(abs, p) : maxAbs;
  const max = Math.max(cut * 1.05, floorMax) || 1;
  return { max, ceiling: max < maxAbs ? max : null };
}

/** Triangular weighted moving average; stops at gaps. */
export function smooth(points, { window = 7, iterations = 1 } = {}) {
  const radius = Math.floor(Math.min(Math.max(window, 3), 21) / 2);
  let out = points;
  for (let pass = 0; pass < Math.min(Math.max(iterations, 1), 3); pass++) {
    const src = out;
    out = src.map((point, i) => {
      if (point.y == null) return point;
      let sum = point.y * (radius + 1);
      let weight = radius + 1;
      for (const dir of [-1, 1]) {
        for (let d = 1; d <= radius; d++) {
          const n = src[i + dir * d];
          if (!n || n.y == null) break;
          sum += n.y * (radius + 1 - d);
          weight += radius + 1 - d;
        }
      }
      return { x: point.x, y: Math.round((sum / weight) * 1000) / 1000 };
    });
  }
  return out;
}

/**
 * Min/max ribbon over fixed time columns, for dense raw series.
 * Returns { min: points, max: points }, one point per column.
 */
export function envelope(points, columns = 120, bucketMs = 10_000) {
  const xs = points.filter((p) => p.y != null).map((p) => p.x);
  if (!xs.length) return { min: [], max: [] };
  const start = xs[0];
  const span = xs.at(-1) - start;
  const width = Math.max(bucketMs, Math.ceil(Math.ceil(span / columns) / bucketMs) * bucketMs);
  const cols = new Map();
  for (const p of points) {
    if (p.y == null) continue;
    const key = Math.floor((p.x - start) / width);
    const c = cols.get(key) ?? { x: start + key * width + width / 2, lo: p.y, hi: p.y };
    c.lo = Math.min(c.lo, p.y);
    c.hi = Math.max(c.hi, p.y);
    cols.set(key, c);
  }
  const list = [...cols.values()].sort((a, b) => a.x - b.x);
  return { min: list.map((c) => ({ x: c.x, y: c.lo })), max: list.map((c) => ({ x: c.x, y: c.hi })) };
}

/** Points at or above the 99th percentile, when they stand out. */
export function bursts(points) {
  const ys = points.map((p) => p.y).filter(Number.isFinite);
  if (ys.length < 60) return [];
  const threshold = percentile(ys, 99);
  if (Math.max(...ys) < threshold * 1.2) return [];
  return points.filter((p) => p.y != null && p.y >= threshold);
}

/** How unusual the newest point is: about 0.55 routine, up to 2.2. */
export function significance(points) {
  const ys = points.map((p) => p.y);
  if (ys.length < 9) return 1;
  const last = ys.at(-1);
  const window = ys.slice(-31, -1).filter(Number.isFinite);
  if (window.length < 8 || !Number.isFinite(last)) return 1;
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const std = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length);
  const dev = Math.max(std, Math.abs(mean) * 0.05, 1);
  return Math.min(0.55 + 0.45 * (Math.abs(last - mean) / dev), 2.2);
}

/** Packet rate for the flow effect: 0.04–1 of the recent peak. */
export function flowRate(current, peak) {
  if (!(current > 0) || !(peak > 0)) return 0;
  return Math.min(Math.max(Math.sqrt(current / peak), 0.04), 1);
}

/** Insert or replace points by x at the tail (live updates). */
export function upsertTail(points, incoming) {
  for (const p of incoming) {
    let i = points.length - 1;
    while (i >= 0 && points[i].x > p.x) i--;
    if (i >= 0 && points[i].x === p.x) points[i] = p;
    else points.splice(i + 1, 0, p);
  }
  return points;
}
