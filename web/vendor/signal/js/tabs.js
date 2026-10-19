/**
 * Tabs with roving focus.
 *
 *   <div class="sd-tabs" role="tablist">
 *     <button role="tab" aria-selected="true" aria-controls="p1">Overview</button>
 *     <button role="tab" aria-controls="p2">Checks</button>
 *   </div>
 *   <div class="sd-tabpanel" role="tabpanel" id="p1">…</div>
 *   <div class="sd-tabpanel" role="tabpanel" id="p2" hidden>…</div>
 */
function tabsOf(tab) {
  return [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
}

export function selectTab(tab) {
  for (const t of tabsOf(tab)) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(t.getAttribute("aria-controls"));
    if (panel) panel.hidden = !on;
  }
  tab.dispatchEvent(new CustomEvent("sd:tab", { bubbles: true, detail: { tab } }));
}

export function onTabClick(event) {
  const tab = event.target.closest('[role="tab"]');
  if (tab) selectTab(tab);
}

export function onTabKeydown(event) {
  const tab = event.target.closest('[role="tab"]');
  if (!tab) return;
  const list = tabsOf(tab);
  const i = list.indexOf(tab);
  const moves = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 };
  if (!(event.key in moves)) return;
  event.preventDefault();
  const next = list[(moves[event.key] + list.length) % list.length];
  next.focus();
  selectTab(next);
}

/** Give unselected tabs tabindex=-1 so Tab lands on the selected one. */
export function initTabs(root = document) {
  for (const list of root.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const selected = tabs.find((t) => t.getAttribute("aria-selected") === "true") || tabs[0];
    if (selected) selectTab(selected);
  }
}
