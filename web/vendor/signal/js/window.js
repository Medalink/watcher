/**
 * Window controls for frameless desktop apps (Tauri, or anything else).
 *
 *   <header class="sd-titlebar" data-tauri-drag-region>
 *     …<div class="sd-window-controls">
 *       <button data-sd-window="minimize">…</button>
 *       <button data-sd-window="maximize">…</button>
 *       <button data-sd-window="close">…</button>
 *
 * In Tauri (with app.withGlobalTauri, or window.__TAURI__ otherwise set) the
 * buttons call the window API, and the title bar tracks maximized state.
 * Elsewhere they fire "sd:window" with detail.action so the app can act.
 * The title bar gets data-platform = mac | windows | linux; on macOS the
 * custom buttons hide and the native traffic lights are used.
 */
import { getLabel } from "./labels.js";

function platform() {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  if (p.includes("mac")) return "mac";
  if (p.includes("win")) return "windows";
  return "linux";
}

function tauriWindow() {
  const api = window.__TAURI__?.window;
  return api?.getCurrentWindow?.() ?? null;
}

async function syncMaximized(bar) {
  const win = tauriWindow();
  if (!win) return;
  const max = await win.isMaximized();
  bar.toggleAttribute("data-maximized", max);
  bar.querySelector('[data-sd-window="maximize"]')?.setAttribute("aria-label", getLabel(max ? "window.restore" : "window.maximize"));
}

export async function windowAction(action, bar = document.querySelector(".sd-titlebar")) {
  const win = tauriWindow();
  if (win) {
    if (action === "minimize") await win.minimize();
    else if (action === "maximize") await win.toggleMaximize();
    else if (action === "close") await win.close();
    if (bar) syncMaximized(bar);
    return;
  }
  (bar ?? document).dispatchEvent(new CustomEvent("sd:window", { bubbles: true, detail: { action } }));
}

export function onWindowClick(event) {
  const button = event.target.closest("[data-sd-window]");
  if (button) windowAction(button.dataset.sdWindow, button.closest(".sd-titlebar"));
}

export function onWindowDblClick(event) {
  const bar = event.target.closest(".sd-titlebar");
  if (bar && !event.target.closest("button, a, input, [data-sd-window]")) windowAction("maximize", bar);
}

export function initWindow(root = document) {
  for (const bar of root.querySelectorAll(".sd-titlebar")) {
    if (!bar.dataset.platform) bar.dataset.platform = platform();
    syncMaximized(bar);
  }
  window.__TAURI__?.event?.listen?.("tauri://resize", () => {
    for (const bar of document.querySelectorAll(".sd-titlebar")) syncMaximized(bar);
  });
}
