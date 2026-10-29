/**
 * The words Signal's JS writes into the page: toasts, aria-labels and the
 * like. English is the default; an app translates them once at startup.
 *
 *   import { setLabels } from "signal-design/js";
 *   setLabels({ "copy.done": "Kopiert", "tags.remove": "{value} entfernen" });
 *
 * A value is a string with `{name}` placeholders, or a function that gets the
 * values and returns the string (for plurals). Setting a key to `undefined`
 * brings back its English default. A `data-sd-*` or `aria-label` attribute on
 * the element still wins over this table. The charts have their own text; see
 * `setChartDefaults` in `signal-design/charts`.
 */
export const DEFAULT_LABELS = Object.freeze({
  "copy.done": "Copied",
  "copy.failed": "Copy unavailable. Select the line instead.",
  "list.empty": "No matches",
  "tags.remove": "Remove {value}",
  "spark.trend": "Trend: {values}",
  "fps.value": "{value} frames per second",
  "table.resize": "Resize table width",
  "table.width": "{value} pixels wide",
  "shell.pin": "Pin sidebar open",
  "shell.collapse": "Collapse sidebar",
  "window.maximize": "Maximize",
  "window.restore": "Restore",
  "countdown.remaining": ({ count, state }) => `${count} ${Number(count) === 1 ? "second" : "seconds"} remaining, ${state}`,
  "countdown.running": "running",
  "countdown.paused": "paused",
  "countdown.complete": "complete",
  "stream.follow.label": "New follower",
  "stream.follow.detail": "Welcome to the stream",
  "stream.sub.label": "New sub",
  "stream.sub.detail": "Thanks for the sub",
  "stream.raid.label": "Raid",
  "stream.raid.detail": "Incoming raid",
  "stream.bits.label": "Bits",
  "stream.bits.detail": "Thanks for the bits",
});

const custom = new Map();

/** Replace some labels. Unknown keys throw, so a typo shows up at startup. */
export function setLabels(partial) {
  for (const key of Object.keys(partial)) {
    if (!(key in DEFAULT_LABELS)) throw new RangeError(`Unknown label "${key}"`);
  }
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) custom.delete(key);
    else custom.set(key, value);
  }
}

function fill(value, vars) {
  if (typeof value === "function") return value(vars);
  return value.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

/** The label for `key`, with `{name}` placeholders filled from `vars`. */
export function getLabel(key, vars = {}) {
  return fill(custom.get(key) ?? DEFAULT_LABELS[key], vars);
}

/** What the app set for `key`, or `undefined`: lets a caller keep its own default when nothing was set. */
export function customLabel(key, vars = {}) {
  return custom.has(key) ? fill(custom.get(key), vars) : undefined;
}
