/**
 * The live layer over a chart: square packets riding the bandwidth lines,
 * a heartbeat on each series tip and pings on unexpected events. It is
 * motion by design, so it is guarded: off for reduced motion, paused while
 * the tab is hidden, the chart is off screen or under the pointer, and a
 * frame-rate governor steps it down (full, half, quarter, off) when the
 * page runs slow. One rAF loop drives every chart on the page.
 *
 * Levels: "full" (1), "subtle" (0.4), "off". Remembered in localStorage
 * under sd-chart-effects when set through setEffectsLevel().
 */
import { rgba as rgbaExact } from "./theme.js";

// Packets and tails ask for many alpha steps of a few colors every frame;
// reuse the strings instead of building new ones each time.
const strings = new Map();
function rgba(c, alpha = 1) {
  if (!c) return "transparent";
  const key = `${c.r},${c.g},${c.b},${c.a},${Math.round(alpha * 64)}`;
  let s = strings.get(key);
  if (!s) {
    if (strings.size > 4000) strings.clear();
    s = rgbaExact(c, Math.round(alpha * 64) / 64);
    strings.set(key, s);
  }
  return s;
}

export const EFFECTS = {
  flow: { size: 2.6, tail: 16, spacing: 70, alpha: 0.55, baseSpeed: 12, speedScale: 130, surgeGain: 0.9, surgeDecay: 1.1 },
  heartbeat: { dot: 2.5, ring: 18, ringMs: 700, staleAfter: 2, deadAfter: 4 },
  sonar: { intervalMs: 3200, maxRadius: 26, alpha: 0.45 },
  governor: { fullFps: 45, subtleFps: 30, suspendFps: 20, recoverFps: 55 },
  /** Draw rate. Packets move slowly; 30 is smooth and halves the work. */
  fps: 30,
};
const LEVELS = { off: 0, subtle: 0.4, full: 1 };
const KEY = "sd-chart-effects";
const TAIL = 4;

export function effectsLevel() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return "off";
  try {
    return localStorage.getItem(KEY) || "full";
  } catch {
    return "full";
  }
}
export function setEffectsLevel(level) {
  try {
    localStorage.setItem(KEY, level);
  } catch {
    /* storage blocked */
  }
  for (const layer of layers) layer.level = level;
  wake();
}

/* ---- geometry over x-sorted pixel samples ---------------------------- */

function pointAtX(samples, x) {
  if (!samples.length || x < samples[0].x || x > samples.at(-1).x) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  if (b.breakBefore && x > a.x && x < b.x) return null;
  const f = b.x > a.x ? (x - a.x) / (b.x - a.x) : 0;
  return { x, y: a.y + (b.y - a.y) * f, segment: a.segment };
}

/** Walk `distance` px along the line from x (negative goes left). */
function walk(samples, x, distance) {
  const start = pointAtX(samples, x);
  if (!start) return { point: null, vertices: [] };
  const vertices = [start];
  const dir = distance < 0 ? -1 : 1;
  let remaining = Math.abs(distance);
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].x < x) lo = mid + 1;
    else hi = mid;
  }
  let index = dir < 0 ? lo - 1 : lo;
  if (dir > 0 && samples[index]?.x === x) index++;
  let prev = start;
  while (index >= 0 && index < samples.length) {
    const next = samples[index];
    if (next.segment !== start.segment) break;
    const len = Math.hypot(next.x - prev.x, next.y - prev.y);
    if (len > 0 && remaining <= len) {
      const f = remaining / len;
      const point = { x: prev.x + (next.x - prev.x) * f, y: prev.y + (next.y - prev.y) * f, segment: start.segment };
      vertices.push(point);
      return { point, vertices };
    }
    vertices.push(next);
    remaining -= len;
    prev = next;
    index += dir;
  }
  return { point: null, vertices };
}

/* ---- one layer per chart --------------------------------------------- */

const layers = new Set();

class Layer {
  constructor(plot, level) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "sd-chart-fx";
    this.canvas.setAttribute("aria-hidden", "true");
    plot.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.plot = plot;
    this.level = level;
    this.paths = [];
    this.streams = new Map();
    this.tips = [];
    this.rings = [];
    this.targets = [];
    this.surgeLevel = 0;
    this.lastFeedAt = 0;
    this.expectedMs = 10_000;
    this.colors = {};
    this.onScreen = true;
    this.hovered = false;
    this.io = new IntersectionObserver((e) => {
      this.onScreen = e.at(-1).isIntersecting;
      wake();
    });
    this.io.observe(plot);
    this.enter = () => {
      this.hovered = true;
    };
    this.leave = () => {
      this.hovered = false;
      wake();
    };
    plot.addEventListener("pointerenter", this.enter);
    plot.addEventListener("pointerleave", this.leave);
    this.resize();
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const { width, height } = this.plot.getBoundingClientRect();
    this.width = width;
    this.height = height;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  get active() {
    return LEVELS[this.level] > 0 && this.onScreen && !this.hovered && !document.hidden && (this.paths.length || this.tips.length || this.targets.length || this.rings.length);
  }

  /** New geometry from the chart: line samples, tips and event targets. */
  setGeometry({ paths, xScale, tips, targets, colors }) {
    this.colors = colors;
    this.xScale = xScale;
    this.tips = tips;
    this.targets = targets;
    const old = this.streams;
    this.streams = new Map();
    this.paths = paths;
    if (!xScale) return;
    const width = xScale.rightPx - xScale.leftPx;
    const span = xScale.maxMs - xScale.minMs;
    for (const series of paths) {
      const s = series.samples;
      series.inlets = s.filter((p, i) => p.x > xScale.leftPx && p.x <= xScale.rightPx && (i === s.length - 1 || s[i + 1].segment !== p.segment));
      if (old.has(series.id)) {
        this.streams.set(series.id, old.get(series.id));
        continue;
      }
      const packets = [];
      const count = series.rate > 0 ? Math.max(1, Math.round((width / EFFECTS.flow.spacing) * (0.2 + 0.8 * series.rate))) : 0;
      for (let i = 0; i < count; i++) {
        const x = xScale.leftPx + ((i + Math.random()) / count) * width;
        if (pointAtX(s, x)) packets.push(packet(xScale.minMs + ((x - xScale.leftPx) / width) * span));
      }
      this.streams.set(series.id, { packets, travel: 0, spawn: 0 });
    }
    wake();
  }

  /** New data arrived; magnitude ≈ 0.55 routine … 2+ unusual. */
  ingest(magnitude = 1, now = performance.now()) {
    this.surgeLevel = Math.min(this.surgeLevel + EFFECTS.flow.surgeGain * magnitude, 2.5);
    this.lastFeedAt = now;
    for (const tip of this.tips) this.rings.push({ ...tip, start: now });
    wake();
  }

  tick(dt, now, scale) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    const intensity = LEVELS[this.level] * scale;
    if (!intensity) return;
    this.flow(ctx, dt, now, intensity);
    this.heartbeat(ctx, now);
    this.sonar(ctx, now);
  }

  flow(ctx, dt, now, intensity) {
    if (!this.xScale) return;
    const cfg = EFFECTS.flow;
    const { minMs, maxMs, leftPx, rightPx } = this.xScale;
    const pxPerMs = (rightPx - leftPx) / Math.max(maxMs - minMs, 1);
    const width = rightPx - leftPx;
    // A late feed drains the stream: still at 4× the expected interval.
    const overdue = this.lastFeedAt ? (now - this.lastFeedAt) / this.expectedMs : 0;
    const fresh = overdue <= 1.5 ? 1 : Math.max(0, 1 - (overdue - 1.5) / 2.5);
    this.surgeLevel = Math.max(0, this.surgeLevel - cfg.surgeDecay * dt);
    const surge = 1 + this.surgeLevel;
    const glint = this.colors.glint;
    ctx.save();
    ctx.globalCompositeOperation = this.colors.dark ? "lighter" : "source-over";
    ctx.lineCap = "butt";
    for (const series of this.paths) {
      const stream = this.streams.get(series.id);
      const s = series.samples;
      if (!stream || s.length < 2) continue;
      if (!(series.rate > 0)) {
        stream.packets = [];
        continue;
      }
      const speed = (cfg.baseSpeed + cfg.speedScale * series.rate) * surge * fresh;
      if (fresh > 0) {
        stream.packets = stream.packets.filter((p) => {
          const x = leftPx + (p.xMs - minMs) * pxPerMs;
          const { point } = walk(s, x, -speed * (1 + p.jitter) * dt);
          if (!point || point.x < leftPx || point.x > rightPx) return false;
          p.xMs = minMs + (point.x - leftPx) / pxPerMs;
          return true;
        });
      }
      const target = Math.max(1, Math.round((width / cfg.spacing) * (0.2 + 0.8 * series.rate) * intensity));
      if (stream.packets.length > target) stream.packets.length = target;
      stream.travel = Math.min(cfg.spacing, stream.travel + speed * dt);
      if (stream.packets.length < target && fresh > 0 && series.inlets.length && (stream.travel >= cfg.spacing * 0.5 || !stream.packets.length)) {
        const inlet = series.inlets[stream.spawn++ % series.inlets.length];
        stream.packets.push(packet(minMs + (inlet.x - leftPx) / pxPerMs));
        stream.travel = 0;
      }
      const alpha = cfg.alpha * intensity * (0.45 + 0.55 * series.rate) * Math.min(surge, 1.5) * (0.25 + 0.75 * fresh);
      for (const p of stream.packets) {
        const head = pointAtX(s, leftPx + (p.xMs - minMs) * pxPerMs);
        if (!head) continue;
        const size = cfg.size * p.scale;
        let prev = head;
        for (let k = 1; k <= TAIL; k++) {
          const { point, vertices } = walk(s, prev.x, cfg.tail / TAIL);
          ctx.strokeStyle = rgba(series.color, alpha * (1 - k / (TAIL + 0.5)) * 0.7);
          ctx.lineWidth = Math.max(size * (1 - k / (TAIL + 1)), 0.5);
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          for (const v of vertices.slice(1)) ctx.lineTo(v.x, v.y);
          ctx.stroke();
          if (!point) break;
          prev = point;
        }
        ctx.fillStyle = rgba(series.color, alpha);
        ctx.fillRect(head.x - size / 2, head.y - size / 2, size, size);
        ctx.fillStyle = rgba(glint, alpha * 0.55);
        ctx.fillRect(head.x - size * 0.22, head.y - size * 0.22, size * 0.44, size * 0.44);
      }
    }
    ctx.restore();
  }

  heartbeat(ctx, now) {
    const cfg = EFFECTS.heartbeat;
    ctx.save();
    this.rings = this.rings.filter((r) => now - r.start < cfg.ringMs);
    for (const r of this.rings) {
      const t = Math.max(0, now - r.start) / cfg.ringMs;
      const size = cfg.dot + t * cfg.ring;
      ctx.strokeStyle = rgba(r.color, (1 - t) * 0.8);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x - size, r.y - size, size * 2, size * 2);
    }
    const overdue = this.lastFeedAt ? (now - this.lastFeedAt) / this.expectedMs : 0;
    for (const tip of this.tips) {
      let c = tip.color;
      let alpha = 0.9;
      if (overdue > cfg.deadAfter) c = this.colors.dead;
      else if (overdue > cfg.staleAfter) {
        c = this.colors.stale;
        alpha = 0.45 + 0.45 * (0.5 + 0.5 * Math.sin(now / 320));
      }
      ctx.fillStyle = rgba(c, alpha);
      ctx.fillRect(tip.x - cfg.dot, tip.y - cfg.dot, cfg.dot * 2, cfg.dot * 2);
    }
    ctx.restore();
  }

  sonar(ctx, now) {
    const cfg = EFFECTS.sonar;
    ctx.save();
    for (const t of this.targets) {
      const phase = ((now + t.x * 7) % cfg.intervalMs) / cfg.intervalMs;
      if (phase > 0.45) continue;
      const k = phase / 0.45;
      const size = 4 + k * cfg.maxRadius;
      ctx.strokeStyle = rgba(t.color, (1 - k) * cfg.alpha);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(t.x - size, t.y - size, size * 2, size * 2);
    }
    ctx.restore();
  }

  destroy() {
    this.io.disconnect();
    this.plot.removeEventListener("pointerenter", this.enter);
    this.plot.removeEventListener("pointerleave", this.leave);
    this.canvas.remove();
    layers.delete(this);
  }
}

function packet(xMs) {
  return { xMs, jitter: (Math.random() * 2 - 1) * 0.15, scale: 0.8 + Math.random() * 0.5 };
}

/* ---- the shared loop and governor ------------------------------------ */

let scheduled = false;
let last = 0;
let tier = 0;
let frames = 0;
let sampleStart = 0;
const SCALES = [1, 0.5, 0.25, 0];

function nextTier(fps) {
  const g = EFFECTS.governor;
  if (fps < g.suspendFps) return 3;
  if (fps < g.subtleFps) return Math.max(tier, 2);
  if (fps < g.fullFps) return Math.max(tier, 1);
  if (fps >= g.recoverFps) return Math.max(tier - 1, 0);
  return tier;
}

// Ask for a frame only when one is due (EFFECTS.fps), so the page is not
// woken at the display's full rate just to skip most frames.
function schedule(delay = 0) {
  if (scheduled) return;
  scheduled = true;
  const go = () => requestAnimationFrame(loop);
  if (delay > 1) setTimeout(go, delay);
  else go();
}

function loop(now) {
  scheduled = false;
  const live = [...layers].filter((l) => l.active);
  for (const l of layers) {
    // Clear a layer once when it goes quiet, not on every frame after.
    if (!l.active && !l.cleared) {
      l.ctx.clearRect(0, 0, l.width, l.height);
      l.cleared = true;
    }
  }
  if (!live.length) {
    last = 0;
    sampleStart = 0;
    return;
  }
  const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
  last = now;
  frames++;
  if (!sampleStart) sampleStart = now;
  if (now - sampleStart >= 1000) {
    // Drawn frames against the target rate, expressed on a 60 fps scale for
    // the governor: on time is 60, half as many is 30.
    tier = nextTier(((frames * 1000) / (now - sampleStart)) * (60 / EFFECTS.fps));
    frames = 0;
    sampleStart = now;
  }
  // Suspended still samples the frame rate, so it can recover.
  for (const l of live) {
    l.cleared = false;
    l.tick(dt, now, SCALES[tier]);
  }
  schedule(1000 / EFFECTS.fps - (performance.now() - now) - 6);
}

export function wake() {
  schedule();
}
document.addEventListener("visibilitychange", wake);

export function createLayer(plot, level = effectsLevel()) {
  const layer = new Layer(plot, level);
  layers.add(layer);
  return layer;
}
