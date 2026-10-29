/**
 * Tags, number steppers, sparklines and the shortcuts sheet.
 *
 * Tags        <div class="sd-tags" data-sd-tags data-name="labels"><input></div>
 *             Enter or comma adds a chip (with a hidden input named data-name),
 *             Backspace on an empty input removes the last; fires "change".
 * Number      <div class="sd-number" data-sd-number><button data-step="-1">−</button><input type="number"><button data-step="1">+</button></div>
 *             Steps by the input's step, within min and max; fires "change".
 * Sparkline   <span class="sd-spark" data-values="3 5 4 8 6 9"></span>
 * Shortcuts   <dialog id="shortcuts" data-sd-shortcuts> opens on "?" (outside text fields).
 */
import { openDialog } from "./dialog.js";
import { getLabel } from "./labels.js";

/* ---- Tags --------------------------------------------------------------- */

function addTag(field, text) {
  const value = text.trim();
  if (!value) return;
  const exists = [...field.querySelectorAll(".sd-chip")].some((c) => c.dataset.value === value);
  if (exists) return;
  const chip = document.createElement("span");
  chip.className = "sd-chip";
  chip.dataset.value = value;
  chip.append(value, " ");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.setAttribute("aria-label", getLabel("tags.remove", { value }));
  remove.textContent = "×";
  chip.append(remove);
  if (field.dataset.name) {
    const hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.name = field.dataset.name;
    hidden.value = value;
    chip.append(hidden);
  }
  field.insertBefore(chip, field.querySelector("input:not([type=hidden])"));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

export function onInputsKeydown(event) {
  const input = event.target;
  const field = input.closest?.("[data-sd-tags]");
  if (!field || input.type === "hidden") return;
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    addTag(field, input.value);
    input.value = "";
  } else if (event.key === "Backspace" && !input.value) {
    const chips = field.querySelectorAll(".sd-chip");
    if (chips.length) {
      chips[chips.length - 1].remove();
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
}

/* ---- Number stepper and tag removal ----------------------------------- */

function syncNumber(group) {
  const input = group.querySelector('input[type="number"]');
  const v = Number(input.value);
  for (const b of group.querySelectorAll("[data-step]")) {
    const dir = Number(b.dataset.step);
    b.disabled = (dir < 0 && input.min !== "" && v <= Number(input.min)) || (dir > 0 && input.max !== "" && v >= Number(input.max));
  }
}

export function onInputsClick(event) {
  const remove = event.target.closest("[data-sd-tags] .sd-chip > button");
  if (remove) {
    const field = remove.closest("[data-sd-tags]");
    remove.closest(".sd-chip").remove();
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.querySelector("input:not([type=hidden])")?.focus();
    return;
  }
  const field = event.target.closest("[data-sd-tags]");
  if (field && event.target === field) field.querySelector("input:not([type=hidden])")?.focus();

  const step = event.target.closest("[data-sd-number] [data-step]");
  if (step) {
    const group = step.closest("[data-sd-number]");
    const input = group.querySelector('input[type="number"]');
    Number(step.dataset.step) > 0 ? input.stepUp() : input.stepDown();
    syncNumber(group);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

export function onInputsInput(event) {
  const group = event.target.closest?.("[data-sd-number]");
  if (group) syncNumber(group);
}

/* ---- Sparklines --------------------------------------------------------- */

export function drawSpark(el) {
  const values = (el.dataset.values || "").trim().split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n));
  if (values.length < 2) return;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const w = 100;
  const h = 32;
  const y = (v) => (max === min ? h / 2 : h - 2 - ((v - min) / (max - min)) * (h - 4));
  const points = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const [lx, ly] = points.split(" ").at(-1).split(",");
  el.innerHTML =
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
    `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.25" vector-effect="non-scaling-stroke"/>` +
    `<rect x="${Number(lx) - 1.5}" y="${Number(ly) - 1.5}" width="3" height="3" fill="currentColor"/></svg>`;
  if (!el.hasAttribute("aria-label")) el.setAttribute("role", "img"), el.setAttribute("aria-label", getLabel("spark.trend", { values: values.join(", ") }));
}

/* ---- Shortcuts sheet ---------------------------------------------------- */

export function onShortcutsKey(event) {
  if (event.key !== "?" || event.defaultPrevented) return;
  const t = event.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const sheet = document.querySelector("dialog[data-sd-shortcuts]");
  if (!sheet) return;
  event.preventDefault();
  openDialog(sheet);
}

export function initInputs(root = document) {
  for (const el of root.querySelectorAll(".sd-spark[data-values]")) drawSpark(el);
  for (const g of root.querySelectorAll("[data-sd-number]")) syncNumber(g);
}
