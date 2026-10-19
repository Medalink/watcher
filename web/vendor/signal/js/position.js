/**
 * Place a fixed-position element next to an anchor, flipping to the other
 * side when it would leave the viewport. No dependencies; works in every
 * engine Tauri ships (WebView2, WKWebView, WebKitGTK).
 *
 * @param {HTMLElement} floating  element with position: fixed
 * @param {Element} anchor
 * @param {{side?: "bottom"|"top"|"left"|"right", align?: "start"|"center"|"end", offset?: number}} [opts]
 */
export function place(floating, anchor, { side = "bottom", align = "start", offset = 6 } = {}) {
  const a = anchor.getBoundingClientRect();
  const f = floating.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const pad = 8;

  const fits = {
    bottom: a.bottom + offset + f.height <= vh - pad,
    top: a.top - offset - f.height >= pad,
    right: a.right + offset + f.width <= vw - pad,
    left: a.left - offset - f.width >= pad,
  };
  const opposite = { bottom: "top", top: "bottom", left: "right", right: "left" };
  if (!fits[side] && fits[opposite[side]]) side = opposite[side];

  let top;
  let left;
  if (side === "bottom" || side === "top") {
    top = side === "bottom" ? a.bottom + offset : a.top - offset - f.height;
    left = align === "start" ? a.left : align === "end" ? a.right - f.width : a.left + (a.width - f.width) / 2;
  } else {
    left = side === "right" ? a.right + offset : a.left - offset - f.width;
    top = align === "start" ? a.top : align === "end" ? a.bottom - f.height : a.top + (a.height - f.height) / 2;
  }

  left = Math.min(Math.max(pad, left), vw - f.width - pad);
  top = Math.min(Math.max(pad, top), vh - f.height - pad);
  floating.style.left = `${Math.round(left)}px`;
  floating.style.top = `${Math.round(top)}px`;
  floating.dataset.side = side;
}
