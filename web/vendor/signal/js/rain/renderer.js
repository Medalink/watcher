/**
 * Digital rain renderer, shared by the worker and the main-thread fallback.
 * Glyph streams only (no words), colors from the theme, and no glow:
 * Signal draws flat.
 *
 * The DOM side (rain.js) owns controls; this owns pixels, streams and the
 * frame loop. Paused, it draws one still frame.
 */

// Square shapes for the "squares" style. Each stands in for one glyph in the
// sprite sheet, so streams mix them the way the text style mixes characters.
export const SQUARES = [
  "filled-l", "filled", "small", "tiny", "dot",
  "outline-l", "outline", "dotted", "dashed",
  "nested", "brackets", "half", "quad",
];

// Glyphs only, no words: Greek and Cyrillic capitals, digits and a few marks,
// all inside Source Code Pro so nothing falls back to a system font.
export const GLYPHS = "ΓΔΘΛΞΠΣΦΨΩБГДЖЗИЙЛПФЦЧШЩЪЫЭЮЯ0123456789:.=*+<>|";

// Trail falloff: about 50 glyphs stay clearly visible behind each head.
const TRAIL_OPACITIES = [
  0.95, 0.93, 0.9, 0.87, 0.84, 0.81, 0.78, 0.76, 0.74, 0.72, 0.7, 0.68, 0.66, 0.64, 0.62, 0.6, 0.58, 0.56, 0.54,
  0.52, 0.5, 0.48, 0.46, 0.44, 0.42, 0.4, 0.38, 0.36, 0.34, 0.33, 0.32, 0.31, 0.3, 0.29, 0.28, 0.27, 0.26, 0.25,
  0.24, 0.23, 0.22, 0.21, 0.2, 0.19, 0.18, 0.17, 0.16, 0.15, 0.14, 0.13, 0.12, 0.11, 0.1, 0.09, 0.08, 0.07, 0.06,
  0.05, 0.045, 0.04, 0.035, 0.03, 0.027, 0.024, 0.022, 0.02,
];

// Glyphs nearest the head flicker through random glyphs before settling.
const LIVE_CHARS = 6;
// A gap in a stream every so often, so columns read as falling code, not bars.
const GAP_CHANCE = 0.08;

const FONT = '"Source Code Pro", ui-monospace, "MS Gothic", monospace';

function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function parseColor(value) {
  const hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  }
  const n = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  return { r: n[0], g: n[1], b: n[2] };
}

const css = ({ r, g, b }) => `rgb(${r},${g},${b})`;
const mix = (a, b, t) => ({ r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) });

/**
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {{width:number,height:number,color:string,head:string,background:string,playing:boolean,visible:boolean,mobile:boolean,style?:"glyphs"|"squares"}} options
 */
export function createRainRenderer(
  canvas,
  options,
  {
    createCanvas = () => (typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1) : document.createElement("canvas")),
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrameRequest = (id) => cancelAnimationFrame(id),
    now = () => Date.now(),
    random = () => Math.random(),
  } = {},
) {
  const ctx = canvas.getContext("2d", { alpha: true });
  let width = options.width;
  let height = options.height;
  let visible = options.visible;
  let isPaused = !options.playing;
  let animationId = null;
  let lastFrameTime = null;
  let destroyed = false;

  // Palette: brightness steps of the base color, plus a "near head" mix
  // toward the head color. Signal passes the theme text color for both.
  let accent = parseColor(options.color);
  let head = parseColor(options.head);
  let background = options.background;
  function generatePalette() {
    const base = accent;
    const lighten = (t) => mix(base, { r: 255, g: 255, b: 255 }, t);
    const darken = (t) => mix(base, { r: 0, g: 0, b: 0 }, t);
    return [base, lighten(0.15), lighten(0.3), darken(0.15), darken(0.3), base].map((rgb) => ({ rgb, tinted: mix(rgb, head, 0.55) }));
  }
  let colorPalette = generatePalette();

  const isMobile = options.mobile;
  const fontSize = isMobile ? 18 : 16;
  const columnSpacing = isMobile ? 2 : 1;
  const streamsPerColumn = 2;
  const depthLayers = [
    { fontSize: fontSize - 2, opacity: 0.62, speed: 0.82 },
    { fontSize, opacity: 0.82, speed: 1 },
    { fontSize: fontSize + 2, opacity: 1, speed: 1.12 },
  ];
  // Row 0 = head color, then per palette entry: tinted row + base row.
  const paletteRows = 1 + colorPalette.length * 2;

  // Sprite sheet: every glyph pre-rendered, so frames use drawImage, not fillText.
  let spriteCanvas = null;
  const squares = options.style === "squares";
  const uniqueChars = squares ? SQUARES : [...GLYPHS];
  let spriteWidth = 0;
  let spriteHeight = 0;
  let spriteBaseline = 0;
  let spriteHalfW = 0;
  const trailCache = new Map();

  function buildSpriteSheet() {
    trailCache.clear();
    const maximumFontSize = depthLayers[depthLayers.length - 1].fontSize;
    ctx.font = `${maximumFontSize}px ${FONT}`;
    let maxW = maximumFontSize * 0.8;
    if (!squares) for (const c of uniqueChars) maxW = Math.max(maxW, ctx.measureText(c).width);
    spriteWidth = Math.ceil(maxW) + 2;
    spriteHeight = maximumFontSize + 6;
    spriteBaseline = maximumFontSize + 1;
    spriteHalfW = spriteWidth / 2;

    if (!spriteCanvas) spriteCanvas = createCanvas();
    spriteCanvas.width = spriteWidth * uniqueChars.length;
    spriteCanvas.height = spriteHeight * paletteRows * depthLayers.length;
    const sCtx = spriteCanvas.getContext("2d");
    sCtx.textAlign = "center";
    sCtx.textBaseline = "alphabetic";

    // A square sized to the depth's font, sitting where a glyph would.
    const drawSquare = (kind, cx, baseline, fontPx) => {
      const unit = fontPx * 0.55;
      const scale = { "filled-l": 1.35, "outline-l": 1.35, small: 0.65, tiny: 0.4 }[kind] ?? 1;
      const size = Math.max(3, Math.round(unit * scale));
      const x = Math.round(cx - size / 2);
      const y = Math.round(baseline - fontPx * 0.45 - size / 2);
      const stroke = (dash) => {
        sCtx.setLineDash(dash);
        sCtx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
        sCtx.setLineDash([]);
      };
      switch (kind) {
        case "filled-l":
        case "filled":
        case "small":
        case "tiny":
          sCtx.fillRect(x, y, size, size);
          break;
        case "dot":
          sCtx.fillRect(Math.round(cx - 1.5), Math.round(y + size / 2 - 1.5), 3, 3);
          break;
        case "outline-l":
        case "outline":
          stroke([]);
          break;
        case "dotted":
          stroke([1, 2]);
          break;
        case "dashed":
          stroke([3, 2]);
          break;
        case "nested": {
          stroke([]);
          const inner = Math.max(2, Math.round(size / 3));
          sCtx.fillRect(Math.round(cx - inner / 2), Math.round(y + size / 2 - inner / 2), inner, inner);
          break;
        }
        case "brackets": {
          const arm = Math.max(2, Math.round(size / 3));
          for (const [bx, by, dx, dy] of [[x, y, 1, 1], [x + size - 1, y, -1, 1], [x, y + size - 1, 1, -1], [x + size - 1, y + size - 1, -1, -1]]) {
            sCtx.fillRect(dx > 0 ? bx : bx - arm + 1, by, arm, 1);
            sCtx.fillRect(bx, dy > 0 ? by : by - arm + 1, 1, arm);
          }
          break;
        }
        case "half":
          stroke([]);
          sCtx.fillRect(x, y, Math.round(size / 2), size);
          break;
        case "quad": {
          const q = Math.max(2, Math.round(size / 2) - 1);
          sCtx.fillRect(x, y, q, q);
          sCtx.fillRect(x + size - q, y, q, q);
          sCtx.fillRect(x, y + size - q, q, q);
          sCtx.fillRect(x + size - q, y + size - q, q, q);
          break;
        }
      }
    };
    let fontPx = 0;
    const renderRow = (row, fillStyle) => {
      sCtx.fillStyle = fillStyle;
      sCtx.strokeStyle = fillStyle;
      sCtx.lineWidth = 1;
      const y = row * spriteHeight + spriteBaseline;
      for (let i = 0; i < uniqueChars.length; i++) {
        if (squares) drawSquare(uniqueChars[i], i * spriteWidth + spriteHalfW, y, fontPx);
        else sCtx.fillText(uniqueChars[i], i * spriteWidth + spriteHalfW, y);
      }
    };
    for (let depth = 0; depth < depthLayers.length; depth++) {
      fontPx = depthLayers[depth].fontSize;
      sCtx.font = `${fontPx}px ${FONT}`;
      const firstRow = depth * paletteRows;
      renderRow(firstRow, css(head));
      for (let p = 0; p < colorPalette.length; p++) {
        renderRow(firstRow + 1 + p * 2, css(colorPalette[p].tinted));
        renderRow(firstRow + 2 + p * 2, css(colorPalette[p].rgb));
      }
    }
  }

  // The live glyphs behind the head are drawn each frame; the rest of the
  // trail is composited once into a strip and reused.
  function getTrail(stream) {
    const totalChars = stream.chars.length;
    const firstChar = Math.max(0, totalChars - TRAIL_OPACITIES.length);
    const trailLength = totalChars - firstChar - LIVE_CHARS;
    const key = `${stream.column}:${stream.colorIndex}:${stream.depth}:${trailLength}`;
    if (trailCache.has(key)) return trailCache.get(key);

    const strip = createCanvas();
    strip.width = spriteWidth;
    strip.height = Math.max(1, (trailLength - 1) * fontSize + spriteHeight);
    const stripContext = strip.getContext("2d");
    const baseRow = stream.depth * paletteRows + 2 + stream.colorIndex * 2;
    for (let offset = 0; offset < trailLength; offset++) {
      const charData = stream.chars[firstChar + offset];
      if (charData.spriteIdx === -1) continue;
      stripContext.globalAlpha = TRAIL_OPACITIES[totalChars - 1 - firstChar - offset];
      stripContext.drawImage(
        spriteCanvas,
        charData.spriteIdx * spriteWidth, baseRow * spriteHeight, spriteWidth, spriteHeight,
        0, offset * fontSize, spriteWidth, spriteHeight,
      );
    }
    trailCache.set(key, strip);
    return strip;
  }

  // A fixed epoch keeps positions consistent across reloads and pages.
  const epoch = 1704067200000;
  let flickerAccumulator = 0;
  // Squares read as flashing when they swap shape, so they settle slower,
  // swap less often, skip the start-up burst and draw dimmer overall.
  const FLICKER_INTERVAL = squares ? 0.3 : 0.1;
  const SWAP_CHANCE = squares ? 0.35 : 1;
  const DIM = squares ? 0.65 : 1;
  let boostStartTime = null;
  const initialBoostDuration = 3000;

  let columns = 0;
  let streams = [];

  // Holes: rectangles [x, y, w, h] covered by opaque elements. Nothing is
  // drawn there, and a stream skips glyphs that fall wholly inside one.
  let holes = options.holes ?? [];

  function openSpans(x) {
    let spans = [[0, canvas.height]];
    for (const [hx, hy, hw, hh] of holes) {
      if (x + spriteHalfW <= hx || x - spriteHalfW >= hx + hw) continue;
      spans = spans.flatMap(([a, b]) => {
        if (hy + hh <= a || hy >= b) return [[a, b]];
        const out = [];
        if (hy > a) out.push([a, hy]);
        if (hy + hh < b) out.push([hy + hh, b]);
        return out;
      });
    }
    return spans;
  }

  const shows = (spans, top, bottom) => spans.some(([a, b]) => top < b && bottom > a);

  function clipToOpen() {
    ctx.save();
    if (!holes.length) return;
    // Holes are never drawn into, so clear them: pixels from before a theme
    // change or a layout shift would otherwise stay behind (a black box on
    // a light page).
    for (const [hx, hy, hw, hh] of holes) ctx.clearRect(hx, hy, hw, hh);
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    for (const [hx, hy, hw, hh] of holes) ctx.rect(hx, hy, hw, hh);
    ctx.clip("evenodd");
  }

  function resize() {
    if (destroyed) return;
    if (streams.length && canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    const totalColumns = Math.ceil(canvas.width / fontSize) + 1;
    columns = isMobile ? Math.ceil(totalColumns / columnSpacing) : totalColumns;
    trailCache.clear();
    streams = [];
    for (let i = 0; i < columns * streamsPerColumn; i++) streams.push(createStream(i));
    if (isPaused) drawStatic();
  }

  function createStream(streamIndex) {
    const column = Math.floor(streamIndex / streamsPerColumn);
    const baseSeed = column * 1000;
    const colorIndex = Math.floor(seededRandom(baseSeed + 2) * colorPalette.length);
    const depth = Math.floor(seededRandom(baseSeed + 5) * depthLayers.length);
    const speed = (seededRandom(baseSeed + 3) * 0.63 + 0.27) * depthLayers[depth].speed;

    // A deterministic glyph sequence per column, long enough to fill the screen.
    const length = Math.ceil(canvas.height / fontSize) + 12;
    const chars = Array.from({ length }, (_, k) => {
      const r = seededRandom(baseSeed + 11 + k * 7.13);
      const idx = r < GAP_CHANCE ? -1 : Math.floor(seededRandom(baseSeed + 97 + k * 3.7) * uniqueChars.length);
      return { spriteIdx: idx, displayIdx: idx };
    });

    const streamHeight = chars.length * fontSize;
    const pixelsPerSecond = speed * 60;
    const cycleTime = (canvas.height + streamHeight) / pixelsPerSecond;
    const elapsedSecs = (now() - epoch) / 1000;
    const phaseOffset = seededRandom(baseSeed + 4) * cycleTime + ((streamIndex % streamsPerColumn) * cycleTime) / streamsPerColumn;
    const cyclePosition = ((elapsedSecs + phaseOffset) % cycleTime) / cycleTime;
    const startY = -streamHeight;
    const endY = canvas.height + 50;

    const stream = {
      x: (column * fontSize * columnSpacing + fontSize / 2) | 0,
      y: startY + cyclePosition * (endY - startY),
      speed,
      chars,
      column,
      colorIndex,
      depth,
    };
    stream.open = openSpans(stream.x);
    stream.trail = getTrail(stream);
    return stream;
  }

  function updateColors(next) {
    if (next.color) accent = parseColor(next.color);
    if (next.head) head = parseColor(next.head);
    if (next.background) background = next.background;
    colorPalette = generatePalette();
    buildSpriteSheet();
    for (const stream of streams) stream.trail = getTrail(stream);
    if (isPaused) drawStatic();
  }

  // Paused: only the few glyphs at each head, faint, so the backdrop has
  // texture without competing with the page.
  function drawStatic() {
    clipToOpen();
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const canvasH = canvas.height;
    for (const stream of streams) {
      if (!stream.open.length) continue;
      const totalChars = stream.chars.length;
      const baseRow = stream.depth * paletteRows + 2 + stream.colorIndex * 2;
      for (let j = Math.max(0, totalChars - 5); j < totalChars; j++) {
        const charData = stream.chars[j];
        if (charData.spriteIdx === -1) continue;
        const charY = stream.y + j * fontSize;
        if (charY < -fontSize || charY > canvasH + fontSize) continue;
        if (!shows(stream.open, charY - spriteBaseline, charY - spriteBaseline + spriteHeight)) continue;
        const distanceFromHead = totalChars - 1 - j;
        ctx.globalAlpha = (0.12 - distanceFromHead * 0.02) * depthLayers[stream.depth].opacity * DIM;
        ctx.drawImage(
          spriteCanvas,
          charData.spriteIdx * spriteWidth, baseRow * spriteHeight, spriteWidth, spriteHeight,
          stream.x - spriteHalfW, charY - spriteBaseline, spriteWidth, spriteHeight,
        );
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  const baseSpeed = 60; // speed 1.0 = 60 px/s

  function draw(deltaTime) {
    clipToOpen();
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let boostFactor = 1;
    if (boostStartTime !== null) {
      const sinceBoost = now() - boostStartTime;
      if (!squares && sinceBoost < initialBoostDuration) boostFactor = 1 + 3 * (1 - sinceBoost / initialBoostDuration);
    }
    flickerAccumulator += deltaTime;
    const shouldFlicker = boostFactor > 1 || flickerAccumulator >= FLICKER_INTERVAL;
    if (shouldFlicker && flickerAccumulator >= FLICKER_INTERVAL) flickerAccumulator -= FLICKER_INTERVAL;

    const canvasH = canvas.height;
    const charCount = uniqueChars.length;

    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i];
      const totalChars = stream.chars.length;
      // A stream wholly under opaque content only moves; nothing is drawn.
      if (!stream.open.length) {
        stream.y += stream.speed * baseSpeed * deltaTime;
        if (stream.y > canvasH + 50) streams[i] = createStream(i);
        continue;
      }
      const firstRow = stream.depth * paletteRows;
      const tintedRow = firstRow + 1 + stream.colorIndex * 2;
      const opacity = depthLayers[stream.depth].opacity * DIM;

      const trailY = stream.y + Math.max(0, totalChars - TRAIL_OPACITIES.length) * fontSize - spriteBaseline;
      ctx.globalAlpha = opacity;
      if (trailY < canvasH && trailY + stream.trail.height > 0 && shows(stream.open, trailY, trailY + stream.trail.height)) {
        ctx.drawImage(stream.trail, stream.x - spriteHalfW, trailY);
      }

      const firstVisibleIdx = Math.max(0, totalChars - LIVE_CHARS, Math.floor((-stream.y - fontSize) / fontSize));
      const lastVisibleIdx = Math.min(totalChars - 1, Math.ceil((canvasH - stream.y + fontSize) / fontSize));

      for (let j = firstVisibleIdx; j <= lastVisibleIdx; j++) {
        const charData = stream.chars[j];
        if (charData.spriteIdx === -1) continue;
        const distanceFromHead = totalChars - 1 - j;
        const charY = stream.y + j * fontSize;
        if (!shows(stream.open, charY - spriteBaseline, charY - spriteBaseline + spriteHeight)) continue;

        let displayIdx = charData.spriteIdx;
        if (distanceFromHead >= 1) {
          if (shouldFlicker) {
            const swap = random() > distanceFromHead / LIVE_CHARS && random() < SWAP_CHANCE;
            charData.displayIdx = swap ? Math.floor(random() * charCount) : charData.spriteIdx;
          }
          displayIdx = charData.displayIdx;
        }

        let spriteRow = tintedRow;
        ctx.globalAlpha = 0.85 * opacity;
        if (distanceFromHead === 0) {
          // Text heads light up in the head color; square heads stay tinted.
          if (!squares) spriteRow = firstRow;
          ctx.globalAlpha = 0.95 * opacity;
        }
        ctx.drawImage(
          spriteCanvas,
          displayIdx * spriteWidth, spriteRow * spriteHeight, spriteWidth, spriteHeight,
          stream.x - spriteHalfW, charY - spriteBaseline, spriteWidth, spriteHeight,
        );
      }

      stream.y += stream.speed * baseSpeed * deltaTime;
      if (stream.y > canvasH + 50) streams[i] = createStream(i);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function animate(currentTime) {
    animationId = null;
    if (destroyed || isPaused || !visible) return;
    const elapsed = lastFrameTime === null ? 0 : currentTime - lastFrameTime;
    lastFrameTime = currentTime;
    draw(Math.min(elapsed / 1000, 0.1));
    scheduleFrame();
  }

  function scheduleFrame() {
    if (destroyed || isPaused || !visible || animationId !== null) return;
    animationId = requestFrame(animate);
  }

  function cancelFrame() {
    if (animationId !== null) cancelFrameRequest(animationId);
    animationId = null;
    lastFrameTime = null;
  }

  function resync() {
    for (let i = 0; i < columns * streamsPerColumn; i++) streams[i] = createStream(i);
  }

  function doPlay() {
    if (destroyed || !isPaused) return;
    isPaused = false;
    boostStartTime = now();
    resync();
    scheduleFrame();
  }

  function doPause() {
    if (destroyed) return;
    isPaused = true;
    cancelFrame();
    drawStatic();
  }

  buildSpriteSheet();
  resize();
  if (!isPaused) {
    boostStartTime = now();
    scheduleFrame();
  }

  return {
    update(next) {
      if (destroyed) return;
      if (next.width !== undefined && next.height !== undefined) {
        width = next.width;
        height = next.height;
        resize();
      }
      if (next.holes !== undefined) {
        holes = next.holes;
        for (const stream of streams) stream.open = openSpans(stream.x);
        if (isPaused) drawStatic();
      }
      if (next.color !== undefined || next.head !== undefined || next.background !== undefined) updateColors(next);
      if (next.visible !== undefined && next.visible !== visible) {
        visible = next.visible;
        cancelFrame();
        if (visible && !isPaused) {
          resync();
          scheduleFrame();
        }
      }
      if (next.playing !== undefined && next.playing === isPaused) {
        if (next.playing) doPlay();
        else doPause();
      }
    },
    destroy() {
      destroyed = true;
      cancelFrame();
      trailCache.clear();
      streams = [];
      spriteCanvas = null;
    },
  };
}
