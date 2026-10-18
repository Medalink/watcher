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

export function hotkeys(map, { target = document } = {}) {
  const table = new Map(Object.entries(map).map(([combo, fn]) => [normalize(combo), fn]));
  const handler = (event) => {
    const combo = keyOf(event);
    if (typing(event.target) && !combo.startsWith("mod+") && combo !== "escape") return;
    // Enter and Space belong to whatever control has focus.
    if ((combo === "enter" || combo === "space") && event.target.closest?.(CONTROL)) return;
    const fn = table.get(combo);
    if (fn) {
      event.preventDefault();
      fn(event);
    }
  };
  target.addEventListener("keydown", handler);
  return () => target.removeEventListener("keydown", handler);
}

export function onKeyAttr(event) {
  if (event.defaultPrevented || event.repeat) return;
  const combo = keyOf(event);
  if (typing(event.target) && !combo.startsWith("mod+")) return;
  for (const el of document.querySelectorAll("[data-sd-key]")) {
    if (normalize(el.dataset.sdKey) !== combo) continue;
    if (el.disabled || el.closest("[hidden], [inert]") || !el.getClientRects().length) continue;
    event.preventDefault();
    el.click();
    return;
  }
}
