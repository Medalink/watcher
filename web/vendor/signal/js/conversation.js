/**
 * Behavior for conversation pieces. Everything is delegated, so rows added
 * later work without setup.
 *
 * Reactions   <button data-sd-reaction aria-pressed="false">👍 <b>2</b></button>
 *             toggles aria-pressed and the count; fires "sd:reaction".
 * Poll        <div class="sd-poll" data-sd-poll [data-multiple]> <button class="sd-poll-option">…
 *             marks the choice; fires "change" with detail.selected (indexes).
 * Autogrow    <textarea data-sd-autogrow> grows with its content.
 * Enter       <textarea data-sd-enter-submit> Enter submits the form, Shift+Enter adds a line.
 * Suggest     <textarea data-sd-suggest="mentions" data-sd-trigger="@">
 *             <div class="sd-suggest" id="mentions" hidden><div class="sd-menu" role="listbox">
 *               <button role="option" data-value="alex">Alex</button>…
 *             Typing the trigger shows options filtered by what follows it;
 *             arrows move, Enter or Tab inserts, Escape closes.
 * Context     <div data-sd-contextmenu="row-menu"> opens <div popover id="row-menu" class="sd-popover">
 *             at the pointer on right-click (or Shift+F10 / the menu key).
 */

/* ---- Reactions and polls ------------------------------------------------ */

export function onConversationClick(event) {
  const reaction = event.target.closest("[data-sd-reaction]");
  if (reaction) {
    const on = reaction.getAttribute("aria-pressed") !== "true";
    reaction.setAttribute("aria-pressed", String(on));
    const count = reaction.querySelector("b");
    if (count) count.textContent = String(Math.max(0, Number(count.textContent || 0) + (on ? 1 : -1)));
    reaction.dispatchEvent(new CustomEvent("sd:reaction", { bubbles: true, detail: { on } }));
    return;
  }

  const option = event.target.closest("[data-sd-poll] .sd-poll-option");
  if (option) {
    const poll = option.closest("[data-sd-poll]");
    const options = [...poll.querySelectorAll(".sd-poll-option")];
    const multiple = "multiple" in poll.dataset;
    const on = option.getAttribute("aria-pressed") !== "true";
    for (const o of options) {
      if (o === option) o.setAttribute("aria-pressed", String(on));
      else if (!multiple) o.setAttribute("aria-pressed", "false");
    }
    const selected = options.flatMap((o, i) => (o.getAttribute("aria-pressed") === "true" ? [i] : []));
    poll.dispatchEvent(new CustomEvent("change", { bubbles: true, detail: { selected } }));
  }
}

/* ---- Composer ----------------------------------------------------------- */

function grow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight + (textarea.offsetHeight - textarea.clientHeight)}px`;
}

function suggestState(textarea) {
  const list = document.getElementById(textarea.dataset.sdSuggest);
  if (!list) return null;
  const triggers = textarea.dataset.sdTrigger || "@";
  const before = textarea.value.slice(0, textarea.selectionStart);
  const match = before.match(new RegExp(`(^|\\s)([${triggers.replace(/[\]\\^-]/g, "\\$&")}])([^\\s]*)$`));
  return { list, match, options: [...list.querySelectorAll('[role="option"]')] };
}

function showSuggestions(textarea) {
  const state = suggestState(textarea);
  if (!state) return;
  const { list, match, options } = state;
  if (!match) {
    list.hidden = true;
    return;
  }
  const query = match[3].toLowerCase();
  let first = null;
  for (const o of options) {
    const text = `${o.dataset.value || ""} ${o.textContent}`.toLowerCase();
    o.hidden = !text.includes(query);
    delete o.dataset.active;
    if (!o.hidden && !first) first = o;
  }
  if (first) first.dataset.active = "";
  list.hidden = !first;
}

function insertSuggestion(textarea, option) {
  const state = suggestState(textarea);
  if (!state?.match) return;
  const { match } = state;
  const start = textarea.selectionStart - match[2].length - match[3].length;
  const value = `${match[2]}${option.dataset.value || option.textContent.trim()} `;
  textarea.setRangeText(value, start, textarea.selectionStart, "end");
  state.list.hidden = true;
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

export function onConversationInput(event) {
  const textarea = event.target;
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  if ("sdAutogrow" in textarea.dataset) grow(textarea);
  if (textarea.dataset.sdSuggest) showSuggestions(textarea);
}

export function onConversationKeydown(event) {
  const textarea = event.target;
  if (!(textarea instanceof HTMLTextAreaElement)) return;

  const list = textarea.dataset.sdSuggest && document.getElementById(textarea.dataset.sdSuggest);
  if (list && !list.hidden) {
    const visible = [...list.querySelectorAll('[role="option"]:not([hidden])')];
    const i = visible.findIndex((o) => "active" in o.dataset);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = visible[(i + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length];
      for (const o of visible) delete o.dataset.active;
      next.dataset.active = "";
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertSuggestion(textarea, visible[Math.max(0, i)]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      list.hidden = true;
      return;
    }
  }

  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && "sdEnterSubmit" in textarea.dataset) {
    event.preventDefault();
    textarea.form?.requestSubmit();
  }
}

export function onSuggestClick(event) {
  const option = event.target.closest('.sd-suggest [role="option"]');
  if (!option) return;
  const list = option.closest(".sd-suggest");
  const textarea = document.querySelector(`[data-sd-suggest="${list.id}"]`);
  if (textarea) insertSuggestion(textarea, option);
}

/* ---- Context menu ------------------------------------------------------- */

function openContextMenu(target, x, y) {
  const menu = document.getElementById(target.dataset.sdContextmenu);
  if (!menu) return;
  if (menu.matches(":popover-open")) menu.hidePopover();
  menu.showPopover();
  const r = menu.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  menu.style.left = `${Math.min(x, vw - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, vh - r.height - 8)}px`;
  menu.querySelector('[role^="menuitem"], [role="option"]')?.focus();
  menu.dispatchEvent(new CustomEvent("sd:contextmenu", { bubbles: true, detail: { target } }));
}

export function onContextMenu(event) {
  const target = event.target.closest?.("[data-sd-contextmenu]");
  if (!target) return;
  event.preventDefault();
  openContextMenu(target, event.clientX, event.clientY);
}

export function onContextMenuKey(event) {
  if (!(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return;
  const target = event.target.closest?.("[data-sd-contextmenu]");
  if (!target) return;
  event.preventDefault();
  const r = target.getBoundingClientRect();
  openContextMenu(target, r.left + 12, r.top + r.height / 2);
}

export function initConversation(root = document) {
  for (const t of root.querySelectorAll("textarea[data-sd-autogrow]")) grow(t);
}
