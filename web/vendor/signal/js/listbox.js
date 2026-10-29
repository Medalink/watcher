/**
 * Filtered listboxes: a text input that narrows a list of options and picks
 * one with the keyboard. The command palette and the combobox both use it.
 *
 * Command palette
 *   <button data-sd-open="palette" data-sd-key="mod+k">Search</button>
 *   <dialog class="sd-command" id="palette" data-sd-palette>
 *     <input type="search" placeholder="Search">
 *     <div class="sd-menu" role="listbox">
 *       <div class="sd-menu-label" role="presentation">Pages</div>
 *       <a role="option" href="/settings">Settings <span class="sd-menu-hint">page</span></a>
 *     </div>
 *   </dialog>
 *   Typing filters options (and hides labels with nothing under them);
 *   arrows move; Enter activates the option (follows its link or clicks it)
 *   and closes the palette. Options can be set from code with setOptions().
 *
 * Combobox (a searchable select)
 *   <div class="sd-combobox" data-sd-combobox>
 *     <input role="combobox" aria-controls="tz-list" aria-expanded="false" placeholder="Time zone">
 *     <input type="hidden" name="tz">
 *     <div class="sd-menu sd-combobox-list" role="listbox" id="tz-list" hidden>
 *       <button type="button" role="option" data-value="UTC">UTC</button>…
 *   Picking sets the text, the hidden input's value and fires "change".
 */
import { getLabel } from "./labels.js";

function options(list) {
  return [...list.querySelectorAll('[role="option"]')];
}

function visibleOptions(list) {
  return options(list).filter((o) => !o.hidden && o.getAttribute("aria-disabled") !== "true");
}

function activate(list, option) {
  for (const o of options(list)) {
    o.removeAttribute("data-active");
    o.setAttribute("aria-selected", "false");
  }
  if (!option) return;
  option.dataset.active = "";
  option.setAttribute("aria-selected", "true");
  option.scrollIntoView({ block: "nearest" });
}

/** Show options whose text (or data-keywords) contains the query; returns how many show. */
export function filterList(list, query) {
  const q = query.trim().toLowerCase();
  let shown = 0;
  for (const o of options(list)) {
    const text = `${o.textContent} ${o.dataset.keywords ?? ""} ${o.dataset.value ?? ""}`.toLowerCase();
    o.hidden = Boolean(q) && !text.includes(q);
    if (!o.hidden) shown++;
  }
  // Hide group labels with no visible option before the next label.
  for (const label of list.querySelectorAll(".sd-menu-label")) {
    let next = label.nextElementSibling;
    let any = false;
    while (next && !next.matches(".sd-menu-label")) {
      if (next.matches('[role="option"]') && !next.hidden) any = true;
      next = next.nextElementSibling;
    }
    label.hidden = !any;
  }
  let empty = list.querySelector(".sd-listbox-empty");
  if (!shown) {
    if (!empty) {
      empty = document.createElement("p");
      empty.className = "sd-menu-label sd-listbox-empty";
      empty.textContent = list.dataset.sdEmpty || getLabel("list.empty");
      list.append(empty);
    }
    empty.hidden = false;
  } else if (empty) empty.hidden = true;
  activate(list, visibleOptions(list)[0]);
  return shown;
}

function move(list, delta) {
  const items = visibleOptions(list);
  if (!items.length) return;
  const i = items.findIndex((o) => "active" in o.dataset);
  activate(list, items[(i + delta + items.length) % items.length]);
}

const activeOption = (list) => list.querySelector('[role="option"][data-active]');

/* ---- Command palette ---------------------------------------------------- */

/** Replace a palette's options: [{ label, hint, group, href, keywords, run }]. */
export function setOptions(dialog, items) {
  const list = dialog.querySelector('[role="listbox"]');
  list.replaceChildren();
  let group;
  for (const item of items) {
    if (item.group && item.group !== group) {
      group = item.group;
      const label = document.createElement("div");
      label.className = "sd-menu-label";
      label.setAttribute("role", "presentation");
      label.textContent = group;
      list.append(label);
    }
    const el = document.createElement(item.href ? "a" : "button");
    el.setAttribute("role", "option");
    if (item.href) el.href = item.href;
    else el.type = "button";
    el.textContent = item.label;
    if (item.keywords) el.dataset.keywords = item.keywords;
    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "sd-menu-hint";
      hint.textContent = item.hint;
      el.append(hint);
    }
    if (item.run) el.addEventListener("click", (event) => item.run(event));
    list.append(el);
  }
  filterList(list, dialog.querySelector("input")?.value ?? "");
}

function choose(option, dialog) {
  if (!option) return;
  dialog?.close?.("");
  option.click();
}

export function onListboxInput(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const palette = input.closest("[data-sd-palette]");
  if (palette) {
    filterList(palette.querySelector('[role="listbox"]'), input.value);
    return;
  }
  const combo = input.closest("[data-sd-combobox]");
  if (combo && input.getAttribute("role") === "combobox") {
    const list = document.getElementById(input.getAttribute("aria-controls"));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    filterList(list, input.value);
  }
}

export function onListboxKeydown(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;

  const palette = input.closest("[data-sd-palette]");
  if (palette) {
    const list = palette.querySelector('[role="listbox"]');
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(list, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(activeOption(list), palette);
    }
    return;
  }

  const combo = input.closest("[data-sd-combobox]");
  if (!combo || input.getAttribute("role") !== "combobox") return;
  const list = document.getElementById(input.getAttribute("aria-controls"));
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (list.hidden) {
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      filterList(list, "");
    } else move(list, event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter" && !list.hidden) {
    event.preventDefault();
    pickCombo(combo, activeOption(list));
  } else if (event.key === "Escape" && !list.hidden) {
    event.preventDefault();
    closeCombo(combo);
  }
}

function closeCombo(combo) {
  const input = combo.querySelector('[role="combobox"]');
  const list = document.getElementById(input.getAttribute("aria-controls"));
  list.hidden = true;
  input.setAttribute("aria-expanded", "false");
}

function pickCombo(combo, option) {
  if (!option) return;
  const input = combo.querySelector('[role="combobox"]');
  const hidden = combo.querySelector('input[type="hidden"]');
  const value = option.dataset.value ?? option.textContent.trim();
  input.value = option.textContent.trim();
  if (hidden) hidden.value = value;
  for (const o of options(document.getElementById(input.getAttribute("aria-controls")))) {
    o.toggleAttribute("data-chosen", o === option);
  }
  closeCombo(combo);
  combo.dispatchEvent(new CustomEvent("change", { bubbles: true, detail: { value } }));
}

export function onListboxClick(event) {
  const option = event.target.closest('[role="option"]');
  const combo = event.target.closest("[data-sd-combobox]");
  if (combo && option) {
    pickCombo(combo, option);
    return;
  }
  if (combo && event.target.matches('[role="combobox"]')) {
    const list = document.getElementById(event.target.getAttribute("aria-controls"));
    if (list.hidden) {
      list.hidden = false;
      event.target.setAttribute("aria-expanded", "true");
      filterList(list, "");
    }
    return;
  }
  // A click outside closes any open combobox.
  for (const open of document.querySelectorAll('[data-sd-combobox] [role="combobox"][aria-expanded="true"]')) {
    if (!open.closest("[data-sd-combobox]").contains(event.target)) closeCombo(open.closest("[data-sd-combobox]"));
  }
  // Palette options close the palette when chosen with the mouse.
  const palette = option?.closest("[data-sd-palette]");
  if (palette && event.isTrusted) palette.close("");
}

/** Reset and focus a palette's input whenever it opens. */
export function initPalettes(root = document) {
  for (const dialog of root.querySelectorAll("dialog[data-sd-palette]")) {
    if (dialog.dataset.sdPaletteReady !== undefined) continue;
    dialog.dataset.sdPaletteReady = "";
    new MutationObserver(() => {
      if (!dialog.open) return;
      const input = dialog.querySelector("input");
      input.value = "";
      filterList(dialog.querySelector('[role="listbox"]'), "");
      input.focus();
    }).observe(dialog, { attributes: true, attributeFilter: ["open"] });
  }
}
