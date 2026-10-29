/**
 * Signal App Shell behavior. State is data attributes on .sd-shell; the CSS
 * does the rest.
 *
 *   <button data-sd-shell="sidebar">   pin or collapse the sidebar (remembered)
 *   <button data-sd-shell="aside">     open or close the right panel
 *   <button data-sd-shell="drawer">    open or close the phone drawer
 *   <button data-sd-shell="close">     close the drawer or a peeking sidebar
 *   <div class="sd-sidebar-resize" role="separator" data-sd-shell="resize">
 *       drag, arrow keys, Home and End resize the sidebar between its
 *       aria-valuemin and aria-valuemax (remembered per sidebar id)
 *   <a class="sd-rail-item" data-sd-section="projects">
 *       shows <div class="sd-sidebar-panel" data-section="projects">; when the
 *       sidebar is collapsed it peeks over the page instead
 *
 * Fires "sd:shell" on the shell with detail { sidebar, aside, drawer, section, width }.
 */
import { getLabel } from "./labels.js";

const KEY = "sd-shell-sidebar";
const phone = () => matchMedia("(max-width: 47.99rem)").matches;
// Tablets keep the rail and content; the sidebar peeks in when a section is picked.
const TABLET = "(min-width: 48rem) and (max-width: 63.99rem)";
// Below 75rem the right panel floats over the content.
const floatingAside = () => matchMedia("(max-width: 74.99rem)").matches;

function emit(shell) {
  shell.dispatchEvent(
    new CustomEvent("sd:shell", {
      bubbles: true,
      detail: {
        sidebar: shell.dataset.sidebar || "pinned",
        aside: shell.dataset.aside || "closed",
        drawer: "drawer" in shell.dataset,
        section: shell.querySelector(".sd-sidebar-panel:not([hidden])")?.dataset.section,
        width: sidebarOf(shell)?.getBoundingClientRect().width,
      },
    }),
  );
}

function sync(shell) {
  const collapsed = shell.dataset.sidebar === "collapsed";
  for (const b of shell.querySelectorAll('[data-sd-shell="sidebar"]')) {
    b.setAttribute("aria-expanded", String(!collapsed));
    b.setAttribute("aria-label", getLabel(collapsed ? "shell.pin" : "shell.collapse"));
  }
  for (const b of shell.querySelectorAll('[data-sd-shell="aside"]')) {
    b.setAttribute("aria-expanded", String(shell.dataset.aside === "open"));
  }
  for (const b of shell.querySelectorAll('[data-sd-shell="drawer"]')) {
    b.setAttribute("aria-expanded", String("drawer" in shell.dataset));
  }
  // While the drawer is open the page behind it can't be reached.
  const main = shell.querySelector(".sd-shell-main");
  if (main) main.inert = "drawer" in shell.dataset;
}

export function setSidebar(shell, state) {
  if (state === "collapsed") shell.dataset.sidebar = "collapsed";
  else delete shell.dataset.sidebar;
  delete shell.dataset.peek;
  try {
    localStorage.setItem(KEY, state);
  } catch {
    /* storage blocked */
  }
  sync(shell);
  emit(shell);
}

export function setAside(shell, open) {
  if (open) shell.dataset.aside = "open";
  else delete shell.dataset.aside;
  sync(shell);
  emit(shell);
}

export function setDrawer(shell, open) {
  if (open) shell.dataset.drawer = "";
  else delete shell.dataset.drawer;
  sync(shell);
  if (open) shell.querySelector('.sd-rail-item[aria-current]:not([aria-current="false"])')?.focus();
  emit(shell);
}

/* ---- Sidebar width ------------------------------------------------- */

const RESIZE = '[data-sd-shell="resize"]';
const STEP = 16;
const BIG_STEP = 64;
let drag = null;

/** The element whose --shell-sidebar sets the width: the shell, or a sidebar used on its own. */
function resizeTarget(handle) {
  const sidebar = handle.closest(".sd-sidebar");
  return sidebar?.parentElement?.matches(".sd-shell") ? sidebar.parentElement : sidebar;
}
function sidebarOf(target) {
  return target.matches(".sd-sidebar") ? target : target.querySelector(":scope > .sd-sidebar");
}
function handlesOf(target) {
  return [...target.querySelectorAll(RESIZE)].filter((h) => resizeTarget(h) === target);
}
function widthKey(target) {
  const id = sidebarOf(target)?.id;
  return id ? `sd-shell-sidebar-width:${id}` : "sd-shell-sidebar-width";
}
function bounds(handle) {
  const min = Number(handle.getAttribute("aria-valuemin")) || 224;
  const max = Number(handle.getAttribute("aria-valuemax")) || 480;
  return { min, max: Math.max(min, max) };
}
function renderedWidth(target) {
  const width = sidebarOf(target)?.getBoundingClientRect().width;
  if (width) return Math.round(width);
  const value = getComputedStyle(target).getPropertyValue("--shell-sidebar").trim();
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Math.round(value.endsWith("rem") ? parseFloat(value) * rem : parseFloat(value) || 288);
}
// The inline --shell-sidebar each target had before the JS first wrote one, so
// null and a cancelled drag return to the author's value, not to the stylesheet.
const authored = new WeakMap();

/** Write --shell-sidebar as a CSS string ("" removes it) and update aria-valuenow. */
function writeWidth(target, value) {
  if (!authored.has(target)) authored.set(target, target.style.getPropertyValue("--shell-sidebar"));
  if (value) target.style.setProperty("--shell-sidebar", value);
  else target.style.removeProperty("--shell-sidebar");
  const now = renderedWidth(target);
  for (const h of handlesOf(target)) h.setAttribute("aria-valuenow", String(now));
}
/** A width in px, or null for the width the page was authored with. */
function applyWidth(target, width) {
  const original = authored.has(target) ? authored.get(target) : target.style.getPropertyValue("--shell-sidebar");
  writeWidth(target, width === null ? original : `${width}px`);
}

/**
 * Set the sidebar to `width` CSS px (clamped to the handle's aria-valuemin and
 * aria-valuemax) and remember it, or pass null to return to the width the page
 * was authored with and forget it. `target` is the .sd-shell, or a .sd-sidebar
 * used on its own; only a shell fires sd:shell.
 */
export function setSidebarWidth(target, width) {
  const handle = handlesOf(target)[0];
  let next = width;
  if (next !== null) {
    const { min, max } = handle ? bounds(handle) : { min: 0, max: Infinity };
    next = Math.round(Math.min(max, Math.max(min, next)));
  }
  applyWidth(target, next);
  try {
    if (next === null) localStorage.removeItem(widthKey(target));
    else localStorage.setItem(widthKey(target), String(next));
  } catch {
    /* storage blocked */
  }
  if (target.matches(".sd-shell")) emit(target);
}

const DRAG_EVENTS = ["pointermove", "pointerup", "pointercancel", "lostpointercapture"];

function endDrag(commit) {
  if (!drag) return;
  const { handle, target, pointerId, from } = drag;
  drag = null;
  delete target.dataset.resizing;
  for (const type of DRAG_EVENTS) handle.removeEventListener(type, onResizePointer);
  if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  if (commit) setSidebarWidth(target, renderedWidth(target));
  else writeWidth(target, from);
}

function onResizePointer(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (event.type === "pointermove") {
    const { min, max } = bounds(drag.handle);
    const next = drag.width + (event.clientX - drag.x) * drag.direction;
    applyWidth(drag.target, Math.round(Math.min(max, Math.max(min, next))));
  } else endDrag(event.type === "pointerup");
}

export function onShellPointerdown(event) {
  const handle = event.target.closest?.(RESIZE);
  if (!handle || event.button !== 0 || drag) return;
  const target = resizeTarget(handle);
  if (!target) return;
  event.preventDefault();
  handle.focus({ preventScroll: true });
  drag = {
    handle,
    target,
    pointerId: event.pointerId,
    x: event.clientX,
    width: renderedWidth(target),
    from: target.style.getPropertyValue("--shell-sidebar"),
    direction: getComputedStyle(handle).direction === "rtl" ? -1 : 1,
  };
  target.dataset.resizing = "";
  handle.setPointerCapture(event.pointerId);
  for (const type of DRAG_EVENTS) handle.addEventListener(type, onResizePointer);
}

function onResizeKeydown(event, handle) {
  const target = resizeTarget(handle);
  if (!target) return false;
  const { min, max } = bounds(handle);
  const direction = getComputedStyle(handle).direction === "rtl" ? -1 : 1;
  const step = event.shiftKey ? BIG_STEP : STEP;
  const now = renderedWidth(target);
  const next = { ArrowRight: now + step * direction, ArrowLeft: now - step * direction, Home: min, End: max }[event.key];
  if (next === undefined) return false;
  event.preventDefault();
  setSidebarWidth(target, next);
  return true;
}

function closeOverlays(shell) {
  // Where the right panel floats over the page, it closes like the others.
  const aside = floatingAside() && shell.dataset.aside === "open";
  const had = "peek" in shell.dataset || "drawer" in shell.dataset || aside;
  delete shell.dataset.peek;
  if (aside) setAside(shell, false);
  if ("drawer" in shell.dataset) setDrawer(shell, false);
  else if (had && !aside) emit(shell);
  return had;
}

export function selectSection(shell, name) {
  for (const item of shell.querySelectorAll(".sd-rail-item[data-sd-section]")) {
    if (item.dataset.sdSection === name) item.setAttribute("aria-current", "true");
    else item.removeAttribute("aria-current");
  }
  for (const panel of shell.querySelectorAll(".sd-sidebar-panel")) {
    panel.hidden = panel.dataset.section !== name;
  }
  if (shell.dataset.sidebar === "collapsed" && !phone()) shell.dataset.peek = "";
  emit(shell);
}

export function onShellClick(event) {
  const control = event.target.closest("[data-sd-shell]");
  const shell = (control || event.target).closest?.(".sd-shell");
  if (!shell) return;

  if (control) {
    const what = control.dataset.sdShell;
    if (what === "sidebar") {
      // On phones the sidebar lives in the drawer; its collapse button closes the drawer.
      if (phone()) setDrawer(shell, false);
      else setSidebar(shell, shell.dataset.sidebar === "collapsed" ? "pinned" : "collapsed");
    } else if (what === "aside") setAside(shell, shell.dataset.aside !== "open");
    else if (what === "drawer") setDrawer(shell, !("drawer" in shell.dataset));
    else if (what === "close") closeOverlays(shell);
    return;
  }

  const section = event.target.closest(".sd-rail-item[data-sd-section]");
  if (section) {
    if (section.tagName === "BUTTON" || section.getAttribute("href") === "#") event.preventDefault();
    selectSection(shell, section.dataset.sdSection);
    return;
  }

  // A link chosen in a peeking sidebar or the drawer closes it.
  if (event.target.closest(".sd-sidebar-link") && ("peek" in shell.dataset || "drawer" in shell.dataset)) {
    closeOverlays(shell);
  }
}

export function onShellKeydown(event) {
  if (drag && event.key === "Escape") {
    event.preventDefault();
    endDrag(false);
    return;
  }
  const handle = event.target.closest?.(RESIZE);
  if (handle && !drag && onResizeKeydown(event, handle)) return;
  if (event.key !== "Escape") return;
  for (const shell of document.querySelectorAll(".sd-shell[data-peek], .sd-shell[data-drawer], .sd-shell[data-aside='open']")) {
    if (closeOverlays(shell)) event.preventDefault();
  }
}

/** Restore the remembered sidebar state and set ARIA on every shell. */
let tabletWatch = null;

export function initShell(root = document) {
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  // Only sidebars with a resize handle get a remembered width.
  for (const handle of root.querySelectorAll(RESIZE)) {
    const target = resizeTarget(handle);
    if (!target) continue;
    let width = null;
    try {
      width = Number(localStorage.getItem(widthKey(target))) || null;
    } catch {
      /* storage blocked */
    }
    if (width !== null) {
      const { min, max } = bounds(handle);
      width = Math.min(max, Math.max(min, width));
      applyWidth(target, width);
    } else handle.setAttribute("aria-valuenow", String(renderedWidth(target)));
  }
  for (const shell of root.querySelectorAll(".sd-shell")) {
    if (saved === "collapsed") shell.dataset.sidebar = "collapsed";
    else if (saved === "pinned") delete shell.dataset.sidebar;
    // Where the right panel would cover the page, it starts closed.
    if (floatingAside() && shell.dataset.aside === "open") delete shell.dataset.aside;
    // Tablets start with the sidebar tucked away (not remembered).
    if (matchMedia(TABLET).matches) shell.dataset.sidebar = "collapsed";
    sync(shell);
  }
  if (!tabletWatch) {
    tabletWatch = matchMedia(TABLET);
    tabletWatch.addEventListener("change", (e) => {
      for (const shell of document.querySelectorAll(".sd-shell")) {
        if (e.matches) shell.dataset.sidebar = "collapsed";
        else {
          let pref = null;
          try {
            pref = localStorage.getItem(KEY);
          } catch {
            /* storage blocked */
          }
          if (pref !== "collapsed") delete shell.dataset.sidebar;
        }
        delete shell.dataset.peek;
        sync(shell);
      }
    });
  }
}
