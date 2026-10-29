/**
 * Stream scenes: alerts, latest-event labels, goals and timers for
 * `.sd-scene` (see components/broadcast.css). Mount explicitly.
 *
 *   import { mountStream } from "signal-design/js";
 *   const stream = mountStream(document.querySelector(".sd-scene"));
 *   stream.alert({ kind: "follow", name: "nightowl_42" });
 *   stream.alert({ kind: "raid", name: "tidepool", detail: "Raiding with 42 viewers" });
 *
 * Alerts queue: each one shows for `hold` ms, then the next comes in. Every
 * alert dispatches `sd:alert` on the scene with its detail. Inside the scene:
 *
 *   [data-sd-latest="follow"]          text set to the newest follower (also sub, raid, bits)
 *   [data-sd-goal="sub"] .sd-cells     data-value / data-max; one cell lights per sub
 *   [data-sd-timer="300"]              counts down from 300s as mm:ss
 *   [data-sd-timer="up"]               counts up from 0 as mm:ss
 *
 * Bursts are flat squares in the alert's tone. prefers-reduced-motion turns
 * the burst off and the card cuts in and out.
 *
 * The default label and detail of each kind are in the labels table
 * (`stream.<kind>.label`, `stream.<kind>.detail`); `setLabels` changes them.
 * A label in the alert itself wins, then one set with `setLabels`, then the
 * kind's own (which a custom kind in ALERT_KINDS supplies).
 */
import { DEFAULT_LABELS, customLabel } from "./labels.js";

const text = (kind, field) => DEFAULT_LABELS[`stream.${kind}.${field}`];

/** What each kind means, in Signal tones. */
export const ALERT_KINDS = {
  follow: { tone: "extra", label: text("follow", "label"), detail: text("follow", "detail") },
  sub: { tone: "success", label: text("sub", "label"), detail: text("sub", "detail") },
  raid: { tone: "accent", label: text("raid", "label"), detail: text("raid", "detail"), size: "big" },
  bits: { tone: "warning", label: text("bits", "label"), detail: text("bits", "detail") },
};

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

function createBurst(scene) {
  const canvas = document.createElement("canvas");
  canvas.className = "sd-scene-fx";
  canvas.setAttribute("aria-hidden", "true");
  scene.append(canvas);
  const ctx = canvas.getContext("2d");
  let parts = [];
  let frame = 0;
  let unit = 1;

  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    unit = canvas.width / 1920;
  }
  const observer = new ResizeObserver(size);
  observer.observe(canvas);

  function step() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    parts = parts.filter((p) => p.life > 0);
    for (const p of parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.5 * unit;
      p.life -= 1;
      ctx.globalAlpha = Math.min(1, p.life / 20);
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;
    frame = parts.length ? requestAnimationFrame(step) : 0;
  }

  return {
    /** x, y in 1920x1080 frame units. */
    fire(x, y, color, count) {
      if (reduced()) return;
      const flash = getComputedStyle(scene).getPropertyValue("--sd-flash").trim() || "#fff";
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = (4 + Math.random() * 14) * unit;
        parts.push({
          x: x * unit,
          y: y * unit,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 6 * unit,
          size: Math.max(1, Math.round((6 + Math.random() * 14) * unit)),
          color: Math.random() < 0.2 ? flash : color,
          life: 40 + Math.random() * 30,
        });
      }
      if (!frame) frame = requestAnimationFrame(step);
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.remove();
    },
  };
}

/**
 * @param {HTMLElement} scene  an `.sd-scene` holding one `.sd-stream-alert`
 * @param {{ hold?: number, burst?: boolean }} [options]
 */
export function mountStream(scene, { hold = 4500, burst = true } = {}) {
  const card = scene.querySelector(".sd-stream-alert");
  const fx = burst && card ? createBurst(scene) : null;
  const queue = [];
  const timers = new Set();
  let showing = false;
  let disposed = false;

  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  // Timers: mm:ss, counting down to 0 or up from 0.
  const clocks = [...scene.querySelectorAll("[data-sd-timer]")].map((el) => ({
    el,
    up: el.dataset.sdTimer === "up",
    value: el.dataset.sdTimer === "up" ? 0 : Number(el.dataset.sdTimer) || 0,
  }));
  const paint = () => clocks.forEach((c) => (c.el.textContent = clock(c.value)));
  paint();
  const ticker = clocks.length
    ? setInterval(() => {
        for (const c of clocks) c.value = c.up ? c.value + 1 : Math.max(0, c.value - 1);
        paint();
      }, 1000)
    : 0;

  // Goals: data-value of data-max, one cell each.
  function paintGoal(goal, hit) {
    const cells = goal.querySelector(".sd-cells");
    const max = Number(goal.dataset.max) || 1;
    const value = Math.min(max, Number(goal.dataset.value) || 0);
    if (cells.children.length !== max) cells.replaceChildren(...Array.from({ length: max }, () => document.createElement("i")));
    [...cells.children].forEach((cell, i) => {
      const on = i < value;
      if (hit && on && !cell.hasAttribute("data-on")) {
        cell.removeAttribute("data-hit");
        void cell.offsetWidth;
        cell.setAttribute("data-hit", "");
      }
      cell.toggleAttribute("data-on", on);
    });
    const label = goal.querySelector("[data-sd-goal-value]");
    if (label) label.textContent = `${value} / ${max}`;
  }
  scene.querySelectorAll("[data-sd-goal]").forEach((goal) => paintGoal(goal, false));

  function show(alert) {
    showing = true;
    const kind = ALERT_KINDS[alert.kind] ?? {};
    const tone = alert.tone ?? kind.tone ?? "neutral";
    card.dataset.tone = tone;
    if (alert.size ?? kind.size) card.dataset.size = alert.size ?? kind.size;
    else delete card.dataset.size;
    card.querySelector(".sd-stream-alert-kind").textContent = alert.label ?? customLabel(`stream.${alert.kind}.label`) ?? kind.label ?? "";
    card.querySelector(".sd-stream-alert-name").textContent = alert.name ?? "";
    const detail = card.querySelector(".sd-stream-alert-detail");
    if (detail) detail.textContent = alert.detail ?? customLabel(`stream.${alert.kind}.detail`) ?? kind.detail ?? "";
    card.hidden = false;
    delete card.dataset.state;
    void card.offsetWidth;
    card.dataset.state = "in";
    // Settle once the entrance and the shimmer have run.
    later(() => card.dataset.state === "in" && (card.dataset.state = "shown"), 1000);

    for (const el of scene.querySelectorAll(`[data-sd-latest="${alert.kind}"]`)) {
      el.textContent = alert.name ?? "";
      const label = el.closest(".sd-scene-label");
      if (label) {
        label.removeAttribute("data-new");
        void label.offsetWidth;
        label.setAttribute("data-new", "");
      }
    }
    for (const goal of scene.querySelectorAll(`[data-sd-goal="${alert.kind}"]`)) {
      goal.dataset.value = String((Number(goal.dataset.value) || 0) + (alert.amount ?? 1));
      paintGoal(goal, true);
    }

    if (fx) {
      requestAnimationFrame(() => {
        const s = scene.getBoundingClientRect();
        const b = card.getBoundingClientRect();
        const k = 1920 / (s.width || 1920);
        const color = getComputedStyle(card).getPropertyValue("--tone").trim();
        fx.fire((b.left - s.left + b.width / 2) * k, (b.top - s.top + b.height / 2) * k, color, card.dataset.size === "big" ? 90 : 46);
      });
    }

    scene.dispatchEvent(new CustomEvent("sd:alert", { bubbles: true, detail: { ...alert, tone } }));

    later(() => {
      card.dataset.state = "out";
      later(() => {
        card.hidden = true;
        delete card.dataset.state;
        showing = false;
        next();
      }, reduced() ? 0 : 200);
    }, alert.hold ?? (card.dataset.size === "big" ? hold + 1500 : hold));
  }

  function next() {
    if (disposed || showing || !queue.length) return;
    show(queue.shift());
  }

  return {
    /** Queue an alert: { kind, name, detail?, label?, tone?, size?, amount?, hold? }. */
    alert(alert) {
      if (!card || disposed) return;
      queue.push(alert);
      next();
    },
    /** Alerts still waiting their turn. */
    get pending() {
      return queue.length;
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      timers.forEach(clearTimeout);
      timers.clear();
      clearInterval(ticker);
      fx?.dispose();
    },
  };
}
