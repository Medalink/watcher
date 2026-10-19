/**
 * Digital rain backdrop. Monochrome glyph streams (the theme text color) behind the app.
 *
 *   <canvas class="sd-rain" data-sd-rain></canvas>          still frame
 *   <canvas class="sd-rain" data-sd-rain="play"></canvas>   animating
 *   <canvas class="sd-rain" data-sd-rain data-sd-rain-style="squares">  squares instead of glyphs
 *   <canvas … data-sd-rain-skip=".card, .panel">  opaque elements on top; rain isn't drawn under them
 *       (inside .sd-shell this defaults to the content box and the header bars)
 *   <button data-sd-rain-toggle>Rain</button>               toggles, remembered
 *
 *   import { rain } from "signal-design/js";
 *   rain.busy(true);   // animate while work runs (unless the user turned it off)
 *   rain.busy(false);  // back to the still frame (unless the user turned it on)
 *
 * Signal's motion rule holds: it is still by default and moves only while
 * something is running or the user asks for it. prefers-reduced-motion
 * keeps it still, and it pauses while the tab is hidden. Rendering happens
 * in a worker when OffscreenCanvas exists, on the main thread otherwise.
 */
import { createRainRenderer } from "./rain/renderer.js";

const KEY = "sd-rain"; // "on" | "off" | null (follow busy state)
const SHELL_SKIP = ".sd-shell-content, .sd-shell-crumbs, .sd-shell-header-end, .sd-shell-bar, .sd-shell-dock";
const FADE = 64; // the header bars fade over their last 4rem; rain shows through there

/** Rectangles, relative to the canvas, that opaque elements cover. */
function measureHoles(canvas) {
  const selector = canvas.dataset.sdRainSkip ?? (canvas.closest(".sd-shell") ? SHELL_SKIP : "");
  if (!selector) return [];
  const root = canvas.closest(".sd-shell") ?? document;
  const origin = canvas.getBoundingClientRect();
  return [...root.querySelectorAll(selector)]
    .filter((el) => el.offsetParent !== null)
    .map((el) => {
      const r = el.getBoundingClientRect();
      let x = r.left - origin.left;
      let w = r.width;
      if (el.matches(".sd-shell-crumbs")) w -= FADE;
      if (el.matches(".sd-shell-header-end")) {
        x += FADE;
        w -= FADE;
      }
      return [Math.round(x), Math.round(r.top - origin.top), Math.max(0, Math.round(w)), Math.round(r.height)];
    })
    .filter(([, , w, h]) => w > 0 && h > 0);
}
const mounts = new Set();

function preference() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function themeColors(canvas) {
  const style = getComputedStyle(canvas);
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  // Monochrome: the theme's text color, white on dark themes and black on
  // light. Signal colors carry meaning, so the backdrop never uses them.
  const fg = read("--sd-fg", "#f4f4f6");
  return {
    color: fg,
    head: fg,
    background: read("--sd-shell-bg", read("--sd-canvas", "#050506")),
  };
}

/**
 * Mount the rain on a canvas. Returns { play, pause, update, destroy }.
 * @param {HTMLCanvasElement} canvas
 * @param {{ playing?: boolean }} [opts]
 */
export function mountRain(canvas, { playing = false, style = canvas.dataset.sdRainStyle || "glyphs" } = {}) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const box = () => canvas.getBoundingClientRect();
  const state = {
    width: Math.max(1, Math.round(box().width)),
    height: Math.max(1, Math.round(box().height)),
    mobile: innerWidth < 768 || (navigator.maxTouchPoints > 1 && "ontouchstart" in window),
    ...themeColors(canvas),
    playing: playing && !reduced.matches,
    style,
    holes: measureHoles(canvas),
    visible: !document.hidden,
  };
  let wanted = playing;
  let worker = null;
  let renderer = null;
  let transferred = false;
  let destroyed = false;

  function useFallback() {
    if (destroyed || renderer) return;
    worker?.terminate();
    worker = null;
    if (transferred) {
      // A transferred canvas can't come back; swap in a fresh one.
      const replacement = canvas.cloneNode(false);
      canvas.replaceWith(replacement);
      canvas = replacement;
      transferred = false;
    }
    renderer = createRainRenderer(canvas, state);
    canvas.dataset.rainRenderer = "main";
  }

  function start() {
    if (!window.Worker || !window.OffscreenCanvas || !canvas.transferControlToOffscreen) return useFallback();
    try {
      worker = new Worker(new URL("./rain/worker.js", import.meta.url), { type: "module", name: "sd-rain" });
      worker.onerror = (event) => {
        event.preventDefault();
        useFallback();
      };
      worker.onmessage = ({ data }) => {
        if (destroyed || !worker) return;
        if (data.type === "started") {
          canvas.dataset.rainRenderer = "worker";
          return;
        }
        if (data.type !== "ready" || transferred) return;
        if (!data.supported) return useFallback();
        try {
          const offscreen = canvas.transferControlToOffscreen();
          transferred = true;
          worker.postMessage({ type: "init", canvas: offscreen, options: { ...state } }, [offscreen]);
        } catch {
          useFallback();
        }
      };
    } catch {
      useFallback();
    }
  }

  function update(options) {
    if (destroyed) return;
    Object.assign(state, options);
    renderer?.update(options);
    if (worker && transferred) worker.postMessage({ type: "update", options });
  }

  const resizeObserver = new ResizeObserver(() => {
    const { width, height } = box();
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w !== state.width || h !== state.height) update({ width: w, height: h });
    remeasure();
  });
  let pending = 0;
  function remeasure() {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      const holes = measureHoles(canvas);
      if (JSON.stringify(holes) !== JSON.stringify(state.holes)) update({ holes });
    });
  }
  // Draw only while the tab is shown and the canvas is on screen.
  let onScreen = true;
  const onVisibility = () => update({ visible: !document.hidden && onScreen });
  const intersection = new IntersectionObserver((entries) => {
    onScreen = entries.at(-1).isIntersecting;
    onVisibility();
  });
  // Theme changes swap variables; read them after styles apply.
  const onTheme = () => requestAnimationFrame(() => update(themeColors(canvas)));
  const onMotion = () => update({ playing: wanted && !reduced.matches });
  const scheme = matchMedia("(prefers-color-scheme: light)");

  start();
  resizeObserver.observe(canvas);
  intersection.observe(canvas);
  const skip = canvas.dataset.sdRainSkip ?? (canvas.closest(".sd-shell") ? SHELL_SKIP : "");
  if (skip) for (const el of (canvas.closest(".sd-shell") ?? document).querySelectorAll(skip)) resizeObserver.observe(el);
  document.addEventListener("sd:shell", remeasure);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("sd:theme", onTheme);
  scheme.addEventListener("change", onTheme);
  reduced.addEventListener("change", onMotion);

  const api = {
    get canvas() {
      return canvas;
    },
    get playing() {
      return wanted;
    },
    play() {
      wanted = true;
      update({ playing: !reduced.matches });
    },
    pause() {
      wanted = false;
      update({ playing: false });
    },
    update,
    destroy() {
      destroyed = true;
      worker?.terminate();
      renderer?.destroy();
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener("sd:shell", remeasure);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("sd:theme", onTheme);
      scheme.removeEventListener("change", onTheme);
      reduced.removeEventListener("change", onMotion);
      mounts.delete(api);
    },
  };
  mounts.add(api);
  return api;
}

function syncToggles() {
  const on = [...mounts].some((m) => m.playing);
  for (const b of document.querySelectorAll("[data-sd-rain-toggle]")) b.setAttribute("aria-pressed", String(on));
}

/** Control every mounted rain at once. */
export const rain = {
  play() {
    for (const m of mounts) m.play();
    syncToggles();
  },
  pause() {
    for (const m of mounts) m.pause();
    syncToggles();
  },
  /** The user's switch: remembered across visits. */
  toggle() {
    const on = ![...mounts].some((m) => m.playing);
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      /* storage blocked */
    }
    on ? rain.play() : rain.pause();
  },
  /** Work started or finished. Respects the user's explicit on or off. */
  busy(isBusy) {
    const pref = preference();
    if (isBusy && pref !== "off") rain.play();
    if (!isBusy && pref !== "on") rain.pause();
  },
};

export function initRain(root = document) {
  const pref = preference();
  for (const canvas of root.querySelectorAll("canvas[data-sd-rain]")) {
    if (canvas.dataset.rainMounted) continue;
    canvas.dataset.rainMounted = "";
    const playing = pref === "on" || (pref !== "off" && canvas.dataset.sdRain === "play");
    mountRain(canvas, { playing });
  }
  syncToggles();
}

export function onRainClick(event) {
  if (event.target.closest("[data-sd-rain-toggle]")) rain.toggle();
}
