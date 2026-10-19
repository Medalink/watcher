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
const lastScroll = new WeakMap();

// Scroll events fire every frame, so this touches the DOM only when the state
// changes: mark on the first event, unmark once 2s pass with no new one.
export function onScrollActivity(event) {
  const el = event.target === document ? document.documentElement : event.target;
  if (!(el instanceof Element)) return;
  lastScroll.set(el, performance.now());
  if (el.hasAttribute("data-sd-scrolling")) return;
  el.setAttribute("data-sd-scrolling", "");
  const check = () => {
    const idle = performance.now() - lastScroll.get(el);
    if (idle >= IDLE_MS) el.removeAttribute("data-sd-scrolling");
    else setTimeout(check, IDLE_MS - idle);
  };
  setTimeout(check, IDLE_MS);
}

export function setScrollbars(mode = "auto") {
  document.documentElement.dataset.sdScrollbars = mode;
}
