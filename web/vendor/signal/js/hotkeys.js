/**
 * Keyboard shortcuts.
 *
 *   const off = hotkeys({ j: next, k: prev, "shift+n": newest, "mod+k": search });
 *   off(); // remove them
 *
 * Declarative: <button data-sd-key="a">Approve</button> clicks the button
 * when "a" is pressed. Keys are ignored while the user types in a field,
 * except Escape and combos with mod (Ctrl, or Cmd on macOS).
 */
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const CONTROL = 'button, a[href], summary, [role="button"], [role="menuitem"], [role="option"], [role="tab"]';

function typing(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/** Turn a KeyboardEvent into "mod+shift+k" form. */
export function keyOf(event) {
  const parts = [];
  if (isMac ? event.metaKey : event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  // Shift is already in the character for symbols like "?"; only name it for letters and named keys.
  const key = event.key.toLowerCase();
  if (event.shiftKey && (/^[a-z]$/.test(key) || event.key.length > 1)) parts.push("shift");
  parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

function normalize(combo) {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop();
  const order = ["mod", "alt", "shift"];
  return [...order.filter((m) => parts.includes(m)), key].join("+");
}

function modalOf(target) {
  const doc = target.ownerDocument || document;
  return target.closest?.("dialog:modal") || doc.querySelector("dialog:modal");
}

export function hotkeys(map, { target = document, sequenceTimeout = 900, enabled = true, repeat = true } = {}) {
  const table = new Map(Object.entries(map).map(([combo, fn]) => [combo.trim().split(/\s+/).map(normalize).join(" "), fn]));
  let pending = "";
  let timer;
  let context;
  const reset = () => { pending = ""; clearTimeout(timer); };
  const handler = (event) => {
    const modal = modalOf(event.target);
    if (event.defaultPrevented || event.isComposing || !(typeof enabled === "function" ? enabled(event) : enabled) ||
      (modal && !(target instanceof Node && modal.contains(target)))) {
      reset();
      return;
    }
    if (context !== modal) reset();
    context = modal;
    if (["Shift", "Control", "Alt", "Meta", "AltGraph"].includes(event.key)) return;
    const combo = keyOf(event);
    if (event.repeat && (!repeat || pending || !table.has(combo))) { reset(); return; }
    if (typing(event.target) && !combo.startsWith("mod+") && combo !== "escape") { reset(); return; }
    // Enter and Space belong to whatever control has focus.
    if ((combo === "enter" || combo === "space") && event.target.closest?.(CONTROL)) { reset(); return; }
    let sequence = pending ? `${pending} ${combo}` : combo;
    if (!table.has(sequence) && ![...table.keys()].some((key) => key.startsWith(`${sequence} `))) sequence = combo;
    const fn = table.get(sequence);
    reset();
    if (fn) {
      event.preventDefault();
      fn(event);
    } else if ([...table.keys()].some((key) => key.startsWith(`${sequence} `))) {
      event.preventDefault();
      pending = sequence;
      timer = setTimeout(reset, sequenceTimeout);
    }
  };
  target.addEventListener("keydown", handler);
  const doc = target.ownerDocument || document;
  for (const type of ["focusin", "pointerdown", "visibilitychange"]) doc.addEventListener(type, reset, true);
  window.addEventListener("blur", reset);
  return () => {
    reset();
    target.removeEventListener("keydown", handler);
    for (const type of ["focusin", "pointerdown", "visibilitychange"]) doc.removeEventListener(type, reset, true);
    window.removeEventListener("blur", reset);
  };
}

export function onKeyAttr(event) {
  if (event.defaultPrevented || event.repeat) return;
  const combo = keyOf(event);
  if (typing(event.target) && !combo.startsWith("mod+")) return;
  for (const el of document.querySelectorAll("[data-sd-key]")) {
    if (normalize(el.dataset.sdKey) !== combo) continue;
    if (el.disabled || el.closest("[hidden], [inert]") || !el.getClientRects().length) continue;
    const modal = modalOf(event.target);
    if (modal && !modal.contains(el)) continue;
    if ((combo === "enter" || combo === "space") && event.target.closest?.(CONTROL)) return;
    event.preventDefault();
    el.click();
    return;
  }
}

/** True when the event is this combo, unhandled, and not typed into a field. */
export function isKey(event, combo) {
  if (event.defaultPrevented || event.repeat) return false;
  const pressed = keyOf(event);
  if (typing(event.target) && !pressed.startsWith("mod+")) return false;
  return pressed === normalize(combo);
}
