/**
 * Text fonts: system (default), leon-sans, source-code-pro. Code stays in
 * Source Code Pro whichever one is picked.
 *
 *   setFont("leon-sans")               sets <html data-font> and remembers it
 *   <button data-sd-font="leon-sans">  sets a font on click
 */
export const FONTS = ["system", "leon-sans", "source-code-pro"];
const KEY = "sd-font";
// Families to fetch before switching, so text changes face once instead of
// flashing through the fallback.
const FACES = { "leon-sans": "Leon Sans", "source-code-pro": "Source Code Pro Text" };
// Past this, switch anyway; font-display: swap fills in when the file lands.
const LOAD_WAIT_MS = 400;
let request = 0;

export function getFont() {
  const name = document.documentElement.dataset.font;
  return FONTS.includes(name) ? name : "system";
}

function apply(name, persist) {
  document.documentElement.dataset.font = name;
  if (persist) {
    try {
      localStorage.setItem(KEY, name);
    } catch {
      /* storage blocked: the font still applies for this page */
    }
  }
  for (const el of document.querySelectorAll("[data-sd-font]")) {
    el.setAttribute("aria-pressed", String(el.dataset.sdFont === name));
  }
  document.dispatchEvent(new CustomEvent("sd:font", { detail: { font: name } }));
}

function whenLoaded(name) {
  const family = FACES[name];
  if (!family || !document.fonts?.load) return Promise.resolve();
  const loads = ["400", "500"].map((weight) => document.fonts.load(`${weight} 1em "${family}"`));
  const wait = new Promise((resolve) => setTimeout(resolve, LOAD_WAIT_MS));
  return Promise.race([Promise.all(loads), wait]).catch(() => {});
}

/**
 * Switch the text font. Resolves once it applies: after the face loads, or
 * after a short wait. When calls overlap, the last one wins.
 */
export function setFont(name, { persist = true } = {}) {
  if (!FONTS.includes(name)) throw new Error(`Unknown font "${name}". Use one of: ${FONTS.join(", ")}`);
  const mine = ++request;
  return whenLoaded(name).then(() => {
    if (mine === request) apply(name, persist);
  });
}

/** Apply the remembered font right away. Call early to avoid a flash. */
export function restoreFont(fallback = "system") {
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  request++;
  apply(FONTS.includes(saved) ? saved : FONTS.includes(fallback) ? fallback : "system", false);
}

export function onFontClick(event) {
  const set = event.target.closest("[data-sd-font]");
  if (set && FONTS.includes(set.dataset.sdFont)) setFont(set.dataset.sdFont);
}
