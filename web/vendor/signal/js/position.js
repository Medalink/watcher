/**
 * Place a fixed-position element next to an anchor, flipping to the other
 * side when it would leave the viewport. No dependencies; works in every
 * engine Tauri ships (WebView2, WKWebView, WebKitGTK).
 *
 * The anchor is an element, anything with getBoundingClientRect, a rect
 * ({ left, top } with right and bottom or width and height; a missing right or
 * bottom is left or top plus the width or height, or just left or top without
 * one) or a point ({ x, y }). A point has no size to
 * clear, so the default offset is 0 and the floating element's corner sits on
 * it (rounded down, so the point is inside the element). Where the element
 * flips above or left of the point, or shifts off an edge, it overlaps the
 * point instead of ending at it, so the element always contains the point:
 * by 1px, and by SLIDE more above it, so at the very bottom of the viewport the
 * last SLIDE px of the element can lie below it. An explicit positive offset keeps its gap.
 * Nothing is placed without a floating element and an anchor.
 *
 * @param {HTMLElement | null} floating  element with position: fixed
 * @param {Element | { getBoundingClientRect(): object } | { left: number, top: number, right?: number, bottom?: number, width?: number, height?: number } | { x: number, y: number } | null} anchor
 * @param {{side?: "bottom"|"top"|"left"|"right", align?: "start"|"center"|"end", offset?: number}} [opts]
 */
export function place(floating, anchor, { side = "bottom", align = "start", offset } = {}) {
  if (!floating || !anchor) return;
  const a = measure(anchor);
  offset ??= a.point ? 0 : 6;
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
    left = align === "start" ? a.left : align === "end" ? a.right - f.width : a.left + (a.right - a.left - f.width) / 2;
  } else {
    left = side === "right" ? a.right + offset : a.left - offset - f.width;
    top = align === "start" ? a.top : align === "end" ? a.bottom - f.height : a.top + (a.bottom - a.top - f.height) / 2;
  }

  left = Math.min(Math.max(pad, left), vw - f.width - pad);
  top = Math.min(Math.max(pad, top), vh - f.height - pad);
  if (a.point && offset <= 0) {
    // Keep the point inside the element however it flipped or shifted. It opens under a pointer that is
    // released over it next, and a hit test is half-open: the far edge is outside, and so is the edge
    // while the slide-in holds the element higher. Light dismiss then closes it.
    left = Math.min(Math.max(left, a.left - f.width + 1), a.left);
    top = Math.min(Math.max(top, a.top - f.height + 1 + SLIDE), a.top);
  }
  // Rounded down at a point, so snapping never moves the far edge back to the point.
  const snap = a.point ? Math.floor : Math.round;
  floating.style.left = `${snap(left)}px`;
  floating.style.top = `${snap(top)}px`;
  floating.dataset.side = side;
}

// A popover slides in from this far above its place over its first 120ms (overlays.css).
const SLIDE = 4;

function measure(anchor) {
  if (typeof anchor.getBoundingClientRect === "function") return anchor.getBoundingClientRect();
  if ("left" in anchor) {
    const { left, top } = anchor;
    return { left, top, right: anchor.right ?? left + (anchor.width ?? 0), bottom: anchor.bottom ?? top + (anchor.height ?? 0) };
  }
  return { left: anchor.x, top: anchor.y, right: anchor.x, bottom: anchor.y, point: true };
}
