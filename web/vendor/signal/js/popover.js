/**
 * Popovers and menus on the native popover API.
 *
 *   <button popovertarget="more">More</button>
 *   <div popover id="more" class="sd-popover">
 *     <div class="sd-menu" role="menu">
 *       <button role="menuitem">Later today <span class="sd-menu-hint">1</span></button>
 *     </div>
 *   </div>
 *
 * The popover opens next to the button that toggled it (data-sd-side and
 * data-sd-align on the popover pick the side). Inside a role="menu",
 * arrows move, Home/End jump, a letter jumps to the next item starting
 * with it, and choosing an item closes the menu.
 */
import { place } from "./position.js";

const ITEM = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]';
const invokers = new WeakMap();

function items(menu) {
  return [...menu.querySelectorAll(ITEM)].filter((el) => el.getAttribute("aria-disabled") !== "true" && !el.disabled);
}

function position(pop) {
  const anchor = invokers.get(pop);
  if (!anchor) return;
  place(pop, anchor, { side: pop.dataset.sdSide || "bottom", align: pop.dataset.sdAlign || "start" });
}

export function onPopoverClick(event) {
  const invoker = event.target.closest("[popovertarget]");
  if (invoker) {
    const pop = document.getElementById(invoker.getAttribute("popovertarget"));
    if (pop) invokers.set(pop, invoker);
    return;
  }
  const item = event.target.closest(ITEM);
  const pop = item?.closest("[popover]");
  if (pop && !("sdKeepOpen" in item.dataset) && item.getAttribute("role") !== "menuitemcheckbox") {
    pop.hidePopover();
    invokers.get(pop)?.focus();
  }
}

/** Hide the popover until it is positioned, so it never flashes in the wrong place. */
export function onPopoverBeforeToggle(event) {
  const pop = event.target;
  if (event.newState === "open" && invokers.has(pop) && pop.classList.contains("sd-popover")) pop.style.visibility = "hidden";
}

export function onPopoverToggle(event) {
  const pop = event.target;
  if (!(pop instanceof HTMLElement) || !pop.hasAttribute("popover")) return;
  const invoker = invokers.get(pop);
  if (event.newState === "open") {
    // Only .sd-popover is anchored; a plain [popover] keeps the browser's centered placement.
    if (pop.classList.contains("sd-popover")) position(pop);
    pop.style.visibility = "";
    invoker?.setAttribute("aria-expanded", "true");
    const first = pop.querySelector('[role="menu"], [role="listbox"]') && items(pop)[0];
    first?.focus();
  } else {
    invoker?.setAttribute("aria-expanded", "false");
  }
}

let typed = "";
let typedAt = 0;

export function onMenuKeydown(event) {
  const menu = event.target.closest('[role="menu"], [role="listbox"]');
  if (!menu) return;
  const list = items(menu);
  const i = list.indexOf(document.activeElement);
  let next = null;
  if (event.key === "ArrowDown") next = list[(i + 1) % list.length];
  else if (event.key === "ArrowUp") next = list[(i - 1 + list.length) % list.length];
  else if (event.key === "Home") next = list[0];
  else if (event.key === "End") next = list[list.length - 1];
  else if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey) {
    typed = event.timeStamp - typedAt < 600 ? typed + event.key.toLowerCase() : event.key.toLowerCase();
    typedAt = event.timeStamp;
    const ordered = [...list.slice(i + 1), ...list.slice(0, i + 1)];
    next = ordered.find((el) => el.textContent.trim().toLowerCase().startsWith(typed));
  }
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

/** Keep open popovers attached to their trigger while the page scrolls or resizes. */
export function repositionOpen() {
  for (const pop of document.querySelectorAll("[popover].sd-popover")) {
    if (pop.matches(":popover-open")) position(pop);
  }
}
