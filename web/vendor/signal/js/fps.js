/**
 * Frame rate counter.
 *
 *   <span class="sd-fps" data-sd-fps><b>--</b> fps</span>
 *
 * Counts requestAnimationFrame callbacks over a 2s window. The value goes in
 * the <b>, and data-tone on the element colors it: success at 58 fps and up
 * (a 60 Hz screen reads 59 to 60), pending from 20, danger below. One loop
 * serves every counter on the page and stops when none are left.
 *
 *   import { fps } from "signal-design/js";
 *   const off = fps.subscribe((value) => console.log(value));
 */
const WINDOW_MS = 2000;
const listeners = new Set();
let rafId = null;
let lastTime = 0;
let frameCount = 0;
let current = 0;

export function toneFor(value) {
  return value >= 58 ? "success" : value >= 20 ? "pending" : "danger";
}

function paint(value) {
  const nodes = document.querySelectorAll("[data-sd-fps]");
  for (const el of nodes) {
    const slot = el.querySelector("b") || el;
    slot.textContent = String(value);
    el.dataset.tone = toneFor(value);
    el.setAttribute("aria-label", `${value} frames per second`);
  }
  return nodes.length;
}

function measure(now) {
  frameCount++;
  if (now - lastTime >= WINDOW_MS) {
    current = Math.round((frameCount * 1000) / (now - lastTime));
    frameCount = 0;
    lastTime = now;
    const shown = paint(current);
    for (const fn of listeners) fn(current);
    if (!shown && !listeners.size) return stop();
  }
  rafId = requestAnimationFrame(measure);
}

function start() {
  if (rafId !== null) return;
  lastTime = performance.now();
  frameCount = 0;
  rafId = requestAnimationFrame(measure);
}

function stop() {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
}

export const fps = {
  get value() {
    return current;
  },
  subscribe(fn) {
    listeners.add(fn);
    start();
    return () => listeners.delete(fn);
  },
};

/** Start the loop if the page has a counter; sleep while the tab is hidden. */
let watching = false;
export function initFps(root = document) {
  if (root.querySelector("[data-sd-fps]")) start();
  if (watching) return;
  watching = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (document.querySelector("[data-sd-fps]") || listeners.size) start();
  });
}
