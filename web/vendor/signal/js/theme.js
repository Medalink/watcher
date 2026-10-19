/**
 * Themes: ink (default), graphite, light, auto.
 *
 *   setTheme("light")           sets <html data-theme> and remembers it
 *   <button data-sd-theme="light">   sets a theme on click
 *   <button data-sd-theme-cycle>     steps through the themes
 *   Shift+T                          steps through them too (init() binds it)
 */
export const THEMES = ["ink", "graphite", "light", "auto"];
const KEY = "sd-theme";

export function getTheme() {
  return document.documentElement.dataset.theme || "ink";
}

export function setTheme(name, { persist = true } = {}) {
  if (!THEMES.includes(name)) throw new Error(`Unknown theme "${name}". Use one of: ${THEMES.join(", ")}`);
  document.documentElement.dataset.theme = name;
  if (persist) {
    try {
      localStorage.setItem(KEY, name);
    } catch {
      /* storage blocked: the theme still applies for this page */
    }
  }
  for (const el of document.querySelectorAll("[data-sd-theme]")) {
    el.setAttribute("aria-pressed", String(el.dataset.sdTheme === name));
  }
  document.dispatchEvent(new CustomEvent("sd:theme", { detail: { theme: name } }));
}

/** Apply the remembered theme. Call early to avoid a flash. */
export function restoreTheme(fallback = "ink") {
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  setTheme(THEMES.includes(saved) ? saved : fallback, { persist: false });
}

/** Step to the next theme (ink → graphite → light → auto → ink). */
export function cycleTheme() {
  setTheme(THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length]);
}

export function onThemeClick(event) {
  const set = event.target.closest("[data-sd-theme]");
  if (set) return setTheme(set.dataset.sdTheme);
  if (event.target.closest("[data-sd-theme-cycle]")) cycleTheme();
}
