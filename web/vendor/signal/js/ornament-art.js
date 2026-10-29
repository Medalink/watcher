/**
 * Art ornaments: drawn imagery for a box's background, in the same square,
 * monochrome language as the dust and blocks, ported from Publighter's
 * generated covers and its landing book.
 *
 *   <div data-sd-ornaments="contours">…</div>            br by default
 *   <div data-sd-ornaments="tl lattice">…</div>           a placement and a style
 *   <article data-sd-ornaments="contours" data-sd-ornaments-seed="elderwood">…</article>
 *
 *   contours  nested hand-drawn rings, like map hills: fiction
 *   lattice   a grid of small squares that thins out: research
 *   waveform  a signal over its noise: blogs and notes
 *   dashed    nested dashed frames: empty and planned things
 *   book      the hero's open book, its pages and its pixel text, as lines
 *   stack     a manuscript: a page, two more behind it, ruled text and a caret
 *
 * Thin 1px lines and small squares in the theme's text color at a low alpha.
 * They are still pictures: nothing animates, nothing takes a click, and the
 * pattern is a pure function of the style, size and seed.
 */

/** Mulberry32: a small seeded generator, so a pattern is the same on every load. */
export function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The dust is strongest at its corner, at 0.66 of its strength. The art stays
// well under that: its lines overlap where they cross, and text has to stay
// readable on the brightest pixel (the contrast budget in the README).
const PEAK = 0.46;
const TAU = Math.PI * 2;

const n = (v) => +v.toFixed(1);
const square = (x, y, s) => `M${n(x)} ${n(y)}h${s}v${s}h${-s}z`;

/** Paths grouped by alpha (to 1%), so a hundred squares are one element. */
function layers() {
  const groups = new Map();
  return {
    add(alpha, d) {
      const a = Math.round(alpha * 100) / 100;
      if (a < 0.01 || !d) return;
      groups.set(a, (groups.get(a) ?? "") + d);
    },
    strokes(color, extra = "") {
      let out = "";
      for (const [a, d] of groups) out += `<path d="${d}" fill="none" stroke="${color}" stroke-opacity="${a}"${extra}/>`;
      return out;
    },
    fills(color) {
      let out = "";
      for (const [a, d] of groups) out += `<path d="${d}" fill="${color}" fill-opacity="${a}"/>`;
      return out;
    },
  };
}

/** A polyline as a path, keeping only the segments that touch the box. */
function trace(points, w, h, closed = false) {
  const count = points.length;
  const inside = ([x, y]) => x > -4 && x < w + 4 && y > -4 && y < h + 4;
  let d = "";
  let pen = false;
  for (let i = 0; i < (closed ? count : count - 1); i++) {
    const a = points[i];
    const b = points[(i + 1) % count];
    if (!inside(a) && !inside(b)) {
      pen = false;
      continue;
    }
    if (!pen) d += `M${n(a[0])} ${n(a[1])}`;
    d += `L${n(b[0])} ${n(b[1])}`;
    pen = true;
  }
  return d;
}

/** A polyline that dissolves in steps: cut wherever its alpha level changes. */
function dissolve(points, alphaOf, into, w, h) {
  let run = [];
  let level = null;
  const flush = () => {
    if (run.length > 1) into.add(level, trace(run, w, h));
    run = [];
  };
  for (const point of points) {
    const a = Math.round(alphaOf(point) * 100) / 100;
    if (a !== level) {
      const joint = run.at(-1);
      flush();
      level = a;
      if (joint) run.push(joint);
    }
    run.push(point);
  }
  flush();
}

/**
 * Where the art grows from and how far it reaches: the corner, the middle of
 * an edge, or the center, with the reach on each axis. `fade(x, y)` is 1 at
 * that point and 0 at the reach; an edge fades by its depth alone.
 */
function frame({ size, width, edge, center, right, bottom, strength }) {
  const w = edge ? width : size;
  const h = size;
  const ax = edge || center ? w / 2 : 0;
  const ay = center ? h / 2 : 0;
  const ex = Math.max(ax, w - ax);
  const ey = Math.max(ay, h - ay);
  const fade = (x, y) => Math.max(0, 1 - (edge ? Math.abs(y - ay) / ey : Math.hypot((x - ax) / ex, (y - ay) / ey)));
  return { w, h, ax, ay, ex, ey, edge, center, right, bottom, fade, peak: Math.min(1, PEAK * strength) };
}

/**
 * Where an upright figure (the book, the stack) goes: centered for the center
 * and along an edge, else 6% in from the corner it is anchored to. Figures
 * are placed, never mirrored, so they do not turn upside down in a bottom corner.
 */
function place(f, width, height) {
  const pad = f.h * 0.06;
  const left = f.edge || f.center ? (f.w - width) / 2 : f.right ? f.w - width - pad : pad;
  const top = f.center ? (f.h - height) / 2 : f.bottom ? f.h - height - pad : pad;
  return [left, top];
}

/* ---- contours: fiction ---------------------------------------------------- */

function contours(f, random, color) {
  const rings = Math.max(5, Math.min(12, Math.round(Math.min(f.ex, f.ey) / 22)));
  const steps = 56;
  const phase = [random() * TAU, random() * TAU];
  const lines = layers();
  for (let k = 1; k <= rings; k++) {
    // The wobble can push a ring 1.23 times out, so the last one still fits the reach.
    const rx = (f.ex * k) / rings / 1.23;
    const ry = (f.ey * k) / rings / 1.23;
    const points = [];
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * TAU;
      const swell = 1 + 0.16 * Math.sin(3 * a + k * 0.7 + phase[0]) + 0.07 * Math.cos(5 * a + k * 0.3 + phase[1]);
      points.push([f.ax + Math.cos(a) * rx * swell, f.ay + Math.sin(a) * ry * swell]);
    }
    lines.add(f.peak * 0.8 * Math.pow(1 - (k - 1) / rings, 1.3), trace(points, f.w, f.h, true));
  }
  return lines.strokes(color);
}

/* ---- lattice: research ---------------------------------------------------- */

function lattice(f, random, color) {
  const cell = 12;
  const fills = layers();
  for (let gx = 0; gx * cell < f.w; gx++) {
    for (let gy = 0; gy * cell < f.h; gy++) {
      const jitter = 0.55 + random() * 0.9;
      const s = random() < 0.85 ? 3 : 5;
      const alpha = f.peak * Math.pow(f.fade(gx * cell + cell / 2, gy * cell + cell / 2), 1.25) * jitter;
      const o = Math.floor((cell - s) / 2);
      fills.add(Math.min(alpha, f.peak), square(gx * cell + o, gy * cell + o, s));
    }
  }
  return fills.fills(color);
}

/* ---- waveform: blogs and notes -------------------------------------------- */

function waveform(f, random, color) {
  const amp = Math.max(8, Math.min(28, f.h * 0.08));
  const mid = f.center ? f.h / 2 : f.h * 0.3;
  const wavelength = 150 + random() * 30;
  const shift = random() * TAU;
  const noise = [];
  const signal = [];
  const step = 6;
  for (let x = 0; x <= f.w + step; x += step) {
    const along = f.center ? 1 - Math.abs(x - f.w / 2) / (f.w / 2) : f.edge ? 1 : 1 - Math.abs(x - f.ax) / f.w;
    const env = Math.pow(Math.max(0, Math.min(1, along)), 0.9);
    noise.push([x, mid + (random() * 2 - 1) * amp * 1.35 * env, env]);
    signal.push([x, mid + Math.sin((x / wavelength) * TAU + shift) * amp * env, env]);
  }
  // The noise is a hairline under the signal, a third as strong.
  const faint = layers();
  const strong = layers();
  dissolve(noise, (p) => f.peak * 0.3 * p[2], faint, f.w, f.h);
  dissolve(signal, (p) => f.peak * 0.9 * p[2], strong, f.w, f.h);
  return faint.strokes(color) + strong.strokes(color, ' stroke-width="1.5"');
}

/* ---- dashed: empty and planned -------------------------------------------- */

function dashed(f, random, color) {
  const frames = Math.max(3, Math.min(9, Math.round(Math.min(f.ex, f.ey) / 26)));
  const lines = layers();
  for (let k = 1; k <= frames; k++) {
    const reach = (k - 0.35) / frames;
    const hx = Math.round(f.ex * reach);
    const hy = Math.round(f.ey * reach);
    const left = Math.round(f.ax) - hx + 0.5;
    const top = Math.round(f.ay) - hy + 0.5;
    lines.add(f.peak * 0.75 * Math.pow(1 - (k - 1) / frames, 1.2), `M${left} ${top}h${2 * hx}v${2 * hy}h${-2 * hx}z`);
  }
  return lines.strokes(color, ' stroke-dasharray="4 4"');
}

/* ---- book: the hero ------------------------------------------------------- */

// Geometry ported from Publighter's book hero (the scene's pure geometry and
// its camera): two pages hinged on the Y axis, 14 rows of 22 text points per
// page in reading order, a wire lattice on each page and two page-edge layers.
const ROWS = 14;
const COLS = 22;
const ROW_PITCH = 0.085;
const COL_PITCH = 0.04;
const MARGIN = 0.1;
const WORD_GAP = 0.18;
const PARAGRAPH_EVERY = 4;
const PARAGRAPH_FRACTION = 0.55;
const PAGE_TOP = 0.7;
const LAYERS = 2;
const LAYER_STEP = 0.018;
const WRITTEN = 0.6;
const CAMERA = 3.6;
const POSE = [-0.72, 0.08, -0.12];

const hashOf = (i) => {
  const v = Math.sin(i * 12.9898 + 4.1) * 43758.5453;
  return v - Math.floor(v);
};

/** The gutter, lifted fore-edge and gentle bow of a page: u across, v up. */
function surface(side, u, v, depth = 0) {
  const bow = Math.sin(Math.PI * u);
  return [side * (u * 0.98 + depth * 0.08), v * PAGE_TOP, -0.08 * Math.exp(-u * 14) + bow * 0.14 + u * u * 0.19 + Math.cos((v * Math.PI) / 2) * bow * 0.045 - depth];
}

function pageLines(side) {
  const columns = 6;
  const rows = 8;
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const flip = (r + c) % 2;
      out.push([surface(side, (c + flip) / columns, -1 + (2 * r) / rows), surface(side, (c + 1 - flip) / columns, -1 + (2 * (r + 1)) / rows)]);
    }
  }
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c < columns; c++) out.push([surface(side, c / columns, -1 + (2 * r) / rows), surface(side, (c + 1) / columns, -1 + (2 * r) / rows)]);
  }
  for (let c = 0; c <= columns; c++) {
    for (let r = 0; r < rows; r++) out.push([surface(side, c / columns, -1 + (2 * r) / rows), surface(side, c / columns, -1 + (2 * (r + 1)) / rows)]);
  }
  for (let layer = 1; layer <= LAYERS; layer++) {
    const depth = layer * LAYER_STEP;
    for (const v of [-1, 1]) {
      for (let c = 0; c < columns; c++) out.push([surface(side, c / columns, v, depth), surface(side, (c + 1) / columns, v, depth)]);
    }
    for (let r = 0; r < rows; r++) out.push([surface(side, 1, -1 + (2 * r) / rows, depth), surface(side, 1, -1 + (2 * (r + 1)) / rows, depth)]);
  }
  return out;
}

function pagePoints(side, out) {
  for (let row = 0; row < ROWS; row++) {
    const paragraphEnd = row % PARAGRAPH_EVERY === PARAGRAPH_EVERY - 1;
    let gap = false;
    for (let col = 0; col < COLS; col++) {
      if (gap) {
        gap = false;
        continue;
      }
      if (hashOf(row * COLS + col) < WORD_GAP) {
        gap = true;
        continue;
      }
      if (paragraphEnd && col > COLS * PARAGRAPH_FRACTION) continue;
      const y = PAGE_TOP - MARGIN - row * ROW_PITCH;
      const p = surface(side, MARGIN + col * COL_PITCH, y / PAGE_TOP);
      out.push([p[0], p[1], p[2] + 0.004]);
    }
  }
}

/** The hero's pose (X tipped back, a touch of Y and Z), then the camera's perspective. */
function project([x, y, z]) {
  const [rx, ry, rz] = POSE;
  let [a, b] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  [x, y] = [a, b];
  [a, b] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [x, z] = [a, b];
  [a, b] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  [y, z] = [a, b];
  const depth = CAMERA - z;
  return { x: x / depth, y: -y / depth, z, depth };
}

const smooth = (lo, hi, v) => {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

function book(f, random, color) {
  const sides = [-1, 1];
  const segments = sides.flatMap(pageLines);
  const points = [];
  for (const side of sides) pagePoints(side, points);

  const seg = segments.map(([a, b]) => ({ a: project(a), b: project(b), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] }));
  const dots = points.map(project);
  const xs = [...seg.flatMap((s) => [s.a.x, s.b.x]), ...dots.map((p) => p.x)];
  const ys = [...seg.flatMap((s) => [s.a.y, s.b.y]), ...dots.map((p) => p.y)];
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];

  // Fit the figure in the box.
  const pad = f.h * 0.06;
  const room = [f.center ? f.w * 0.88 : Math.min(f.w - 2 * pad, f.h * 1.8), f.center ? f.h * 0.88 : f.h - 2 * pad];
  const scale = Math.min(room[0] / (x1 - x0), room[1] / (y1 - y0));
  const [left, top] = place(f, (x1 - x0) * scale, (y1 - y0) * scale);
  const at = (p) => [left + (p.x - x0) * scale, top + (p.y - y0) * scale];

  // The hero's own shading: brighter toward the fore-edge and the near page,
  // a fixed light sweep, and hidden where a layer sinks under the paper.
  const lines = layers();
  for (const s of seg) {
    const [mx, my, mz] = s.mid;
    const u = Math.min(1, Math.abs(mx) / 0.98);
    const bow = Math.sin(Math.PI * u);
    const paper = -0.08 * Math.exp(-u * 14) + bow * 0.14 + u * u * 0.19 + Math.cos(((my / PAGE_TOP) * Math.PI) / 2) * bow * 0.045;
    const light = 0.5 + 0.5 * Math.sin(mx * 3.5 + my * 2);
    const depth = Math.max(0.25, Math.min(1, 1 - (CAMERA - mz - 3.2) * 0.55));
    const shade = (0.09 + 0.1 * smooth(0.04, 0.32, Math.abs(mx)) + 0.06 * light) * depth * Math.exp(-Math.max(0, paper - mz) * 32);
    const [a, b] = [at(s.a), at(s.b)];
    lines.add(Math.min(1, (shade / 0.22) * 0.38) * f.peak, `M${n(a[0])} ${n(a[1])}L${n(b[0])} ${n(b[1])}`);
  }

  // Text points are small squares in reading order: the first 60% written.
  const dot = Math.max(1.5, Math.min(3, Math.round(((x1 - x0) * scale) / 75) / 2));
  const squares = layers();
  const written = Math.floor(dots.length * WRITTEN);
  dots.forEach((p, i) => {
    const fadeDepth = Math.max(0.12, Math.min(1, 1.15 + p.z * 1.6));
    const [x, y] = at(p);
    if (i === written) squares.add(f.peak, square(x - dot * 0.8, y - dot * 0.8, n(dot * 1.6)));
    else squares.add(f.peak * 0.85 * fadeDepth * (i < written ? 1 : 0.115), square(x - dot / 2, y - dot / 2, dot));
  });
  return lines.strokes(color) + squares.fills(color);
}

/* ---- stack: a manuscript ------------------------------------------------- */

// Ported from Publighter's manuscript illustration: a page with two more
// peeking out behind it, five ruled lines of text, a caret square at the end
// of the first, and two margin notes. Authored in a 320x240 space.
const STACK = {
  pages: [[54, 52, 230, 220], [72, 36, 248, 204], [90, 20, 266, 188]],
  rules: [[78, 86, 160], [78, 112, 200], [78, 128, 206], [78, 144, 180], [78, 174, 150]],
  notes: [[240, 82, 292], [240, 98, 278], [28, 170, 62]],
  marks: [[160, 86], [292, 82], [28, 170]],
  from: [28, 16],
  to: [292, 224],
};

function stack(f, random, color) {
  const [x0, y0] = STACK.from;
  const [x1, y1] = STACK.to;
  const pad = f.h * 0.06;
  const room = [f.center ? f.w * 0.88 : Math.min(f.w - 2 * pad, f.h * 1.3), f.center ? f.h * 0.88 : f.h - 2 * pad];
  const scale = Math.min(room[0] / (x1 - x0), room[1] / (y1 - y0));
  const [left, top] = place(f, (x1 - x0) * scale, (y1 - y0) * scale);
  // Snapped to half pixels, so the 1px lines stay sharp at any scale.
  const X = (x) => Math.round(left + (x - x0) * scale) + 0.5;
  const Y = (y) => Math.round(top + (y - y0) * scale) + 0.5;
  const lines = layers();
  const [front, ...behind] = STACK.pages;
  lines.add(f.peak * 0.8, `M${X(front[0])} ${Y(front[1])}H${X(front[2])}V${Y(front[3])}H${X(front[0])}z`);
  for (const [px, py, qx, qy] of behind) lines.add(f.peak * 0.5, `M${X(px)} ${Y(py)}H${X(qx)}V${Y(qy)}`);
  for (const [a, y, b] of STACK.rules) lines.add(f.peak * 0.5, `M${X(a)} ${Y(y)}H${X(b)}`);
  for (const [a, y, b] of STACK.notes) lines.add(f.peak * 0.65, `M${X(a)} ${Y(y)}H${X(b)}`);
  const marks = layers();
  const side = Math.max(3, Math.round(4 * scale));
  for (const [x, y] of STACK.marks) marks.add(f.peak, square(X(x) - side / 2, Y(y) - side / 2, side));
  return lines.strokes(color) + marks.fills(color);
}

const DRAW = { contours, lattice, waveform, dashed, book, stack };

/**
 * Each style: whether it wants crisp pixel edges (squares and axis-aligned
 * lines) rather than smoothed curves; whether it is an upright figure that is
 * placed in a corner rather than a field that is mirrored into it; and a gain
 * that evens out how loud the styles read: thin single lines can take a
 * little more than a grid or a figure whose lines overlap.
 */
export const ORNAMENT_ART = {
  contours: { crisp: false, figure: false, gain: 1.3 },
  lattice: { crisp: true, figure: false, gain: 1 },
  waveform: { crisp: false, figure: false, gain: 1 },
  dashed: { crisp: true, figure: false, gain: 1.25 },
  book: { crisp: false, figure: true, gain: 1 },
  stack: { crisp: true, figure: true, gain: 0.8 },
};

/**
 * One art ornament as SVG shapes, origin at the top-left; flip it with a
 * transform for other corners (what paintOrnaments does). edge: true grows
 * from the middle of the top edge across `width`; center: true from the middle.
 * right and bottom put an upright figure (book, stack) in that corner instead.
 * The strength is the same dial the dust uses, so the art is no louder.
 */
export function ornamentArt({ style = "contours", size = 340, width = size, edge = false, center = false, right = false, bottom = false, color = "#fff", seed = 7, strength = 1 } = {}) {
  const known = Object.hasOwn(ORNAMENT_ART, style) ? style : "contours";
  return DRAW[known](frame({ size, width, edge, center, right, bottom, strength: strength * ORNAMENT_ART[known].gain }), seeded(seed), color);
}
