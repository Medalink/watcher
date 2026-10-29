/**
 * Scroll boxes that hold no focusable content get a tab stop while they
 * actually scroll, so keyboard users can reach and scroll them (WCAG 2.1.1).
 * The tab stop goes away when the box fits again.
 */
const SCROLLERS = ".sd-table-wrap, .sd-code > pre, pre.sd-diff, .sd-statusbar, [data-sd-scroll-tab]";

function sync(el) {
  const scrolls = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
  if (scrolls && !el.hasAttribute("tabindex")) {
    el.tabIndex = 0;
    el.dataset.sdScrollTabbed = "";
  } else if (!scrolls && "sdScrollTabbed" in el.dataset) {
    el.removeAttribute("tabindex");
    delete el.dataset.sdScrollTabbed;
  }
}

// Created on first use, so importing this module needs no browser.
let watch;

export function initScrollTabs(root = document) {
  for (const el of root.querySelectorAll(SCROLLERS)) {
    sync(el);
    (watch ??= new ResizeObserver((entries) => entries.forEach(({ target }) => sync(target)))).observe(el);
  }
}
