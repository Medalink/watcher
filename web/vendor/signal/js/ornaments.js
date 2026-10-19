/**
 * Ornaments: a field of small squares in two opposite corners of a
 * box, dense and strong at the corner and thinning out as it spreads.
 *
 *   <div class="sd-shell-content" data-sd-ornaments>…</div>          bottom right (default)
 *   <div data-sd-ornaments="tl br">…</div>                          two corners: blocks + dust
 *   <div data-sd-ornaments data-sd-ornaments-size="420">…</div>       reach in px (default 340)
 *   <nav data-sd-ornaments="bottom" data-sd-ornaments-size="240">     full width, rising from the bottom
 *   <div data-sd-edges>…</div>   border bright at the corners, faint along the sides, sharp at each center
 *
 * The first corner gets "blocks" (large squares, mostly outlines and dotted
 * outlines, spreading along a straight diagonal); the second gets "dust"
 * (small filled squares and dots, spreading in a curve), so the two read as
 * separate pieces rather than a mirror image.
 *
 * Squares use the theme's text color only (white on dark, black on light).
 * The pattern is seeded, so it is the same on every load, and it is drawn as
 * the element's own background: it stays put while the content scrolls and
 * never takes clicks.
 */
const DEFAULT_SIZE = 340;

// Each style: grid step, how the reach is measured, merge chance near the
// corner, and the mix of square kinds (filled, outline, dotted, dot).
export const ORNAMENT_STYLES = {
  blocks: { cell: 12, metric: "diagonal", falloff: 1.15, merge: 0.18, mix: [0.18, 0.42, 0.3, 0.1] },
  dust: { cell: 8, metric: "radial", falloff: 1.6, merge: 0.05, mix: [0.42, 0.12, 0.12, 0.34] },
};

function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One ornament as SVG shapes, with the origin at the top-left. Flip it with a
 * transform for other corners. edge: true spreads from the whole top edge
 * (full width) instead of from the corner point.
 */
/**
 * sparkle: the share of squares that brighten now and then (0 = still).
 * Each one rests most of a slow 6–14s cycle and lifts briefly, at its own
 * offset, so the ornament glints without drawing the eye.
 *
 * With a `glints` array the sparkling squares are pushed there (for CSS
 * animation on the compositor) instead of animating inside the SVG.
 */
export function ornamentShapes({ size = DEFAULT_SIZE, width = size, edge = false, center = false, color = "#fff", seed = 7, strength = 1, style = "blocks", sparkle = 0, glints = null } = {}) {
  const preset = ORNAMENT_STYLES[style] ?? ORNAMENT_STYLES.blocks;
  const { cell, falloff, merge, mix } = preset;
  const metric = edge ? "edge" : center ? "center" : preset.metric;
  const random = seeded(seed);
  const cells = Math.floor(size / cell);
  const cols = Math.ceil(width / cell);
  const shapes = [];
  const taken = new Set();
  const [filled, outline, dotted] = [mix[0], mix[0] + mix[1], mix[0] + mix[1] + mix[2]];
  const gap = cell >= 12 ? 3 : 2;

  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cols; col++) {
      if (taken.has(`${col},${row}`)) continue;
      // Edge mode keeps a clear column on each side so dividers stay crisp.
      if (metric === "edge" && (col === 0 || col >= cols - 1)) continue;
      // 0 at the corner (or edge), 1 at the reach.
      const d =
        metric === "edge" ? (row + 0.5) / cells
        : metric === "center" ? Math.hypot(col + 0.5 - cells / 2, row + 0.5 - cells / 2) / (cells / 2)
        : metric === "diagonal" ? (col + row + 1) / cells
        : Math.hypot(col + 0.5, row + 0.5) / cells;
      if (d >= 1) continue;
      const near = 1 - d;
      if (random() > Math.pow(near, falloff) * 0.92) continue;

      const x = col * cell;
      const y = row * cell;
      const alpha = Math.min(1, (0.04 + 0.62 * Math.pow(near, 1.8)) * strength).toFixed(3);
      const pick = random();

      let span = 1;
      // Merged squares stay small: never more than 2x2 cells.
      if (near > 0.5 && random() < merge) span = 2;
      if (span > 1) {
        let free = col + span <= cols && row + span <= cells;
        for (let a = 0; free && a < span; a++) for (let b = 0; b < span; b++) if (taken.has(`${col + a},${row + b}`)) free = false;
        if (!free) span = 1;
        else for (let a = 0; a < span; a++) for (let b = 0; b < span; b++) taken.add(`${col + a},${row + b}`);
      }

      const w = span * cell - gap;
      const at = `x="${x + gap / 2}" y="${y + gap / 2}" width="${w}" height="${w}"`;
      const kind = pick < filled ? "fill" : pick < outline ? "line" : pick < dotted ? "dots" : "dot";
      const dot = kind === "dot" ? Math.max(2, Math.round(cell / 4 + random() * 2)) : 0;
      // A twinkle: rest at the base alpha, lift to a peak, settle back.
      let glint = "";
      if (sparkle > 0 && random() < sparkle) {
        const peak = Math.min(1, alpha * 2.6 + 0.12 * strength);
        const dur = 6 + random() * 8;
        const begin = random() * 14;
        if (glints) {
          const o = kind === "dot" ? (cell - dot) / 2 : gap / 2;
          glints.push({ x: x + o, y: y + o, w: kind === "dot" ? dot : w, kind, lift: +(peak - alpha).toFixed(3), dur: +dur.toFixed(1), begin: +begin.toFixed(1) });
        } else {
          const attr = kind === "line" || kind === "dots" ? "stroke-opacity" : "fill-opacity";
          glint = `<animate attributeName="${attr}" values="${alpha};${alpha};${peak.toFixed(3)};${alpha}" keyTimes="0;0.72;0.84;1" dur="${dur.toFixed(1)}s" begin="${begin.toFixed(1)}s" repeatCount="indefinite"/>`;
        }
      }
      const rect = (attrs) => (glint ? `<rect ${attrs}>${glint}</rect>` : `<rect ${attrs}/>`);
      if (kind === "fill") shapes.push(rect(`${at} fill="${color}" fill-opacity="${alpha}"`));
      else if (kind === "line") shapes.push(rect(`${at} fill="none" stroke="${color}" stroke-opacity="${alpha}"`));
      else if (kind === "dots") shapes.push(rect(`${at} fill="none" stroke="${color}" stroke-opacity="${alpha}" stroke-dasharray="1 2"`));
      else {
        const o = (cell - dot) / 2;
        shapes.push(rect(`x="${x + o}" y="${y + o}" width="${dot}" height="${dot}" fill="${color}" fill-opacity="${alpha}"`));
      }
    }
  }
  return shapes.join("");
}

const POSITION = { tl: "left top", tr: "right top", bl: "left bottom", br: "right bottom", top: "left top", bottom: "left bottom", center: "center center" };
const EDGES = new Set(["top", "bottom"]);

function ornamentURL(corner, options) {
  const { size } = options;
  const edge = EDGES.has(corner);
  const center = corner === "center";
  const width = edge ? options.width : size;
  const flipX = !edge && corner.endsWith("r");
  const flipY = corner.startsWith("b");
  const transform = flipX || flipY ? ` transform="translate(${flipX ? width : 0} ${flipY ? size : 0}) scale(${flipX ? -1 : 1} ${flipY ? -1 : 1})"` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${size}" viewBox="0 0 ${width} ${size}" shape-rendering="crispEdges"><g${transform}>${ornamentShapes({ ...options, width, edge, center })}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * A border drawn as an image: white for a short stretch at each corner,
 * falling fast to a dark-grey hairline. The top edge also eases up into a
 * short white segment at its center. Sizes are the element's border box.
 */
export function edgesSVG({ width, height, color = "#fff", dim = 0.12, center = 32, corner = 14, fall = 48, ramp = 60 }) {
  // Distances are in px along each side, so short and long sides look alike.
  const side = (id, x1, y1, x2, y2, length, withCenter) => {
    const at = (px) => Math.max(0, Math.min(1, px / length));
    const mid = length / 2;
    const middle = withCenter
      ? [
          [at(mid - center / 2 - ramp), dim],
          [at(mid - center / 2), 1],
          [at(mid + center / 2), 1],
          [at(mid + center / 2 + ramp), dim],
        ]
      : [];
    const stops = [
      [0, 1],
      [at(corner), 0.95],
      [at(fall), dim],
      ...middle,
      [at(length - fall), dim],
      [at(length - corner), 0.95],
      [1, 1],
    ]
      .map(([o, a]) => `<stop offset="${o.toFixed(4)}" stop-color="${color}" stop-opacity="${a}"/>`)
      .join("");
    return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient>`;
  };
  // Only the top edge carries the center segment.
  const defs = side("t", 0, 0, width, 0, width, true) + side("b", 0, 0, width, 0, width, false) + side("l", 0, 0, 0, height, height, false);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">` +
    `<defs>${defs}</defs>` +
    `<rect x="0" y="0" width="${width}" height="1" fill="url(#t)"/>` +
    `<rect x="0" y="${height - 1}" width="${width}" height="1" fill="url(#b)"/>` +
    `<rect x="0" y="0" width="1" height="${height}" fill="url(#l)"/>` +
    `<rect x="${width - 1}" y="0" width="1" height="${height}" fill="url(#l)"/>` +
    `</svg>`
  );
}

/** Paint the ornaments on one element, in the current theme's text color. */
export function paintOrnaments(el) {
  // Empty states get a center ornament unless they ask for something else
  // (data-sd-ornaments="none" turns it off).
  const fallback = el.matches(".sd-empty") ? "center" : "br";
  const corners = "sdOrnaments" in el.dataset || el.matches(".sd-empty") ? (el.dataset.sdOrnaments || fallback).split(/\s+/).filter((c) => c in POSITION) : [];
  const size = Number(el.dataset.sdOrnamentsSize) || DEFAULT_SIZE;
  // A center ornament fits the box's height, so it sits behind the message.
  const centerSize = Math.max(80, Math.min(size, Math.round(el.clientHeight) || size, 320));
  const width = Math.max(1, Math.round(el.clientWidth));
  const style = getComputedStyle(el);
  const color = style.getPropertyValue("--sd-fg").trim() || "#ffffff";
  // Light themes need a touch more ink to read on white.
  const strength = style.colorScheme === "light" ? 0.42 : 0.28;
  // A slow sparkle on a few squares, unless the user asks for less motion or
  // the element opts out with data-sd-ornaments-still.
  const sparkle = matchMedia("(prefers-reduced-motion: reduce)").matches || "sdOrnamentsStill" in el.dataset ? 0 : 0.12;
  // One corner gets "dust"; a second corner, when asked for, gets "blocks".
  const styles = corners.filter((c) => !EDGES.has(c)).length > 1 ? ["blocks", "dust"] : ["dust"];
  const images = [];
  const positions = [];
  const sizes = [];
  // Sparkling squares, placed in CSS px from the corner they grow from.
  const glints = [];
  const collect = (corner, list, area) => {
    for (const g of list) glints.push({ ...g, corner, area });
  };

  // The border glow goes on top; the element's own border turns transparent.
  if ("sdEdges" in el.dataset) {
    const w = Math.max(2, Math.round(el.offsetWidth));
    const h = Math.max(2, Math.round(el.offsetHeight));
    const dim = style.colorScheme === "light" ? 0.16 : 0.14;
    images.push(`url("data:image/svg+xml,${encodeURIComponent(edgesSVG({ width: w, height: h, color, dim }))}")`);
    positions.push("left top");
    sizes.push(`${w}px ${h}px`);
    el.style.borderColor = "transparent";
  }

  // Edges always use a softer "dust"; corners alternate blocks, dust.
  corners.forEach((corner, i) => {
    const edge = EDGES.has(corner);
    if (corner === "center") {
      const list = [];
      images.push(ornamentURL(corner, { size: centerSize, width: centerSize, color, strength: strength * 0.7, seed: 31 + centerSize, style: "dust", sparkle: sparkle ? sparkle * 1.5 : 0, glints: list }));
      collect(corner, list, centerSize);
      positions.push(POSITION.center);
      sizes.push(`${centerSize}px ${centerSize}px`);
      return;
    }
    const list = [];
    images.push(
      ornamentURL(corner, {
        size,
        width,
        color,
        // Blocks sit behind headings, so they stay quieter than the dust.
        strength: edge ? strength * 0.5 : styles[i % styles.length] === "blocks" ? strength * 0.5 : strength,
        seed: 11 + i * 97 + (edge ? width : 0),
        sparkle,
        glints: list,
        style: edge ? "dust" : styles[i % styles.length],
      }),
    );
    collect(corner, list, size);
    positions.push(POSITION[corner]);
    sizes.push(edge ? `${width}px ${size}px` : `${size}px ${size}px`);
  });

  el.style.backgroundImage = images.join(", ");
  el.style.backgroundPosition = positions.join(", ");
  el.style.backgroundSize = sizes.join(", ");
  el.style.backgroundRepeat = "no-repeat";
  el.style.backgroundOrigin = "border-box";
  layGlints(el, glints, color, style, width);
}

/**
 * The sparkle runs as CSS opacity animations on small squares in a layer
 * under the content, so the compositor animates it and the page itself does
 * no work per frame. In a scroller the layer is a sticky first child, so it
 * stays put like the background does.
 */
function layGlints(el, glints, color, style, edgeWidth) {
  let layer = el.querySelector(":scope > .sd-glints");
  if (!glints.length) {
    layer?.remove();
    return;
  }
  const scroller = /(auto|scroll)/.test(style.overflowY);
  const px = (v) => parseFloat(v) || 0;
  const bt = px(style.borderTopWidth);
  const bl = px(style.borderLeftWidth);
  const br = px(style.borderRightWidth);
  const bb = px(style.borderBottomWidth);
  const W = el.offsetWidth;
  const H = el.offsetHeight;
  if (!layer) {
    layer = document.createElement("span");
    layer.className = "sd-glints";
    layer.setAttribute("aria-hidden", "true");
    if (scroller) el.prepend(layer);
    else el.append(layer);
  }
  if (style.position === "static") el.style.position = "relative";
  el.style.isolation = "isolate";
  layer.style.color = color;
  let box = layer;
  if (scroller) {
    // Pinned at the top of the visible area; the box inside covers it.
    layer.dataset.sticky = "";
    layer.style.top = `${px(style.paddingTop)}px`;
    box = layer.firstElementChild || layer.appendChild(document.createElement("span"));
    box.className = "sd-glints-box";
    Object.assign(box.style, { top: `${-px(style.paddingTop)}px`, left: `${-px(style.paddingLeft)}px`, width: `${W - bl - br}px`, height: `${H - bt - bb}px` });
  }
  // Each ornament's glints split into three groups, each one SVG layer with
  // its own slow rhythm. A few composited layers instead of one element per
  // square keeps the per-frame style work near zero when the page is busy.
  const groups = new Map();
  glints.forEach((g, i) => {
    const key = `${g.corner}|${i % GLINT_RHYTHMS.length}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  });
  let html = "";
  for (const [key, list] of groups) {
    const [corner, n] = key.split("|");
    const edge = EDGES.has(corner);
    const w = edge ? edgeWidth : list[0].area;
    const h = list[0].area;
    const flipX = corner === "tr" || corner === "br";
    const flipY = corner === "bl" || corner === "br" || corner === "bottom";
    const transform = flipX || flipY ? ` transform="translate(${flipX ? w : 0} ${flipY ? h : 0}) scale(${flipX ? -1 : 1} ${flipY ? -1 : 1})"` : "";
    const rects = list
      .map((g) =>
        g.kind === "line" || g.kind === "dots"
          ? `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.w}" fill="none" stroke="${color}" stroke-opacity="${g.lift}"${g.kind === "dots" ? ' stroke-dasharray="1 2"' : ""}/>`
          : `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.w}" fill="${color}" fill-opacity="${g.lift}"/>`,
      )
      .join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges"><g${transform}>${rects}</g></svg>`;
    // Placed like the ornament: on the border box, so outside the border by its width.
    const place =
      corner === "center"
        ? `left:${(W - w) / 2 - bl}px;top:${(H - h) / 2 - bt}px`
        : `${flipX ? `right:${-br}px` : `left:${-bl}px`};${flipY ? `bottom:${-bb}px` : `top:${-bt}px`}`;
    const rhythm = GLINT_RHYTHMS[n];
    const delay = (list[0].begin % rhythm).toFixed(1);
    html += `<i style="${place};width:${w}px;height:${h}px;background-image:url(&quot;data:image/svg+xml,${encodeURIComponent(svg)}&quot;);animation-duration:${rhythm}s;animation-delay:-${delay}s"></i>`;
  }
  box.innerHTML = html;
}

// Seconds per glint cycle for the three groups: unrelated lengths, so the
// groups drift apart and the twinkles never line up into a pattern.
const GLINT_RHYTHMS = [7.3, 9.7, 12.1];

const SELECTOR = "[data-sd-ornaments], [data-sd-edges], .sd-empty";

// Painting reads an element's size, which would force layout of content the
// browser is skipping (content-visibility, display: none). Paint those when
// they come into view instead.
const waiting = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    waiting.unobserve(e.target);
    paintOrnaments(e.target);
  }
});

function rendered(el) {
  return el.checkVisibility ? el.checkVisibility({ contentVisibilityAuto: true }) : true;
}

function paintAll(root = document) {
  for (const el of root.querySelectorAll(SELECTOR)) {
    if (rendered(el)) paintOrnaments(el);
    else waiting.observe(el);
  }
}

let listening = false;

// Edge ornaments span the element's width, so repaint when it changes.
const resized = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    if (!rendered(target)) continue;
    const scroller = target.querySelector(":scope > .sd-glints[data-sticky]");
    if (scroller || target.matches(".sd-empty") || "sdEdges" in target.dataset || /(top|bottom|center)/.test(target.dataset.sdOrnaments || "")) paintOrnaments(target);
  }
});

export function initOrnaments(root = document) {
  paintAll(root);
  for (const el of root.querySelectorAll(SELECTOR)) resized.observe(el);
  if (listening) return;
  listening = true;
  // Theme changes swap the variables; repaint once styles apply.
  const repaint = () => requestAnimationFrame(() => paintAll());
  document.addEventListener("sd:theme", repaint);
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", repaint);
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", repaint);
}
