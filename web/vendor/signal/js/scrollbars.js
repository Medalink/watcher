/**
 * Scrollbars that show while scrolling and hide 2s after the position stops
 * changing. Only the thumb's color changes, not the scrollbar's width, so the
 * layout never shifts.
 *
 * init() turns it on by setting data-sd-scrollbars="auto" on <html>; pass
 * init({ scrollbars: "always" }) to keep them visible. While an element
 * scrolls it carries data-sd-scrolling.
 */
const IDLE_MS = 2000;
const timers = new WeakMap();

export function onScrollActivity(event) {
  const el = event.target === document ? document.documentElement : event.target;
  if (!(el instanceof Element)) return;
  el.setAttribute("data-sd-scrolling", "");
  clearTimeout(timers.get(el));
  timers.set(el, setTimeout(() => el.removeAttribute("data-sd-scrolling"), IDLE_MS));
}

export function setScrollbars(mode = "auto") {
  document.documentElement.dataset.sdScrollbars = mode;
}
