/**
 * <button data-sd-tip="Approve (a)">…</button>
 * Shows on hover and keyboard focus, hides on leave, blur or Escape.
 * data-sd-tip-side="top|bottom|left|right" picks the side (default top).
 */
import { place } from "./position.js";

let tip;
let owner;

function show(el) {
  if (owner === el) return;
  hide();
  owner = el;
  tip = document.createElement("div");
  tip.className = "sd-tooltip";
  tip.id = "sd-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.textContent = el.dataset.sdTip;
  document.body.append(tip);
  el.setAttribute("aria-describedby", tip.id);
  place(tip, el, { side: el.dataset.sdTipSide || "top", align: "center" });
}

function hide() {
  owner?.removeAttribute("aria-describedby");
  tip?.remove();
  tip = owner = undefined;
}

export function onTipOver(event) {
  const el = event.target.closest?.("[data-sd-tip]");
  if (el) show(el);
  else if (owner && !owner.contains(event.target)) hide();
}

export function onTipOut(event) {
  if (owner && !owner.contains(event.relatedTarget)) hide();
}

export function onTipKeydown(event) {
  if (event.key === "Escape") hide();
}

export const hideTooltip = hide;
