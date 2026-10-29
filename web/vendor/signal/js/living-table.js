import { getLabel } from "./labels.js";

const mounts = new WeakSet();

/**
 * @typedef {{ headers: HTMLTableCellElement[], folds: number[], groups: Map<string,
 * { body: HTMLTableSectionElement, button: HTMLButtonElement, rows: HTMLTableRowElement[], count: Element|null }> }} LivingTableDOM
 * @typedef {{ pointerId: number, x: number, width: number, requested: number|null, direction: number }} ResizeGesture
 */

/** Mount a grouped native table. Duplicate live mounts throw; dispose before remounting. */
export function mountLivingTable(root) {
  if (mounts.has(root)) throw new Error("Living table is already mounted");
  const wrap = root.querySelector(":scope > .sd-table-wrap");
  const table = wrap?.querySelector(":scope > table.sd-table");
  const grip = root.querySelector(":scope > [data-sd-living-resize]");
  if (!root.matches(".sd-living-table[data-sd-living-table]") || !root.parentElement || !table || !grip || !wrap.id) {
    throw new Error("Living table needs a table wrapper with an id and a resize separator");
  }
  const initialHeaders = [...(table.tHead?.rows[0]?.cells ?? [])];
  const folds = initialHeaders.map((cell) => Number(cell.dataset.fold || 0));
  if (!initialHeaders.length || table.tHead.rows.length !== 1 || folds[0] !== 0 || initialHeaders.some((cell, i) =>
    !cell.matches('th[scope="col"]') || cell.colSpan !== 1 || cell.rowSpan !== 1 || ![0, 1, 2].includes(folds[i]),
  )) throw new Error("Living table needs one header row with unspanned columns and data-fold 1 or 2");

  function readGroups() {
    const groups = new Map();
    for (const body of table.tBodies) {
      const [heading, ...rows] = body.rows;
      const cell = heading?.cells[0];
      const button = cell?.querySelector("button[aria-expanded]");
      if (!body.dataset.id || groups.has(body.dataset.id) || !heading?.matches(".sd-living-table-group") ||
        heading.cells.length !== 1 || !cell.matches('th[scope="rowgroup"]') || cell.colSpan !== folds.length ||
        !button || !["true", "false"].includes(button.getAttribute("aria-expanded")) || rows.some((row) =>
          row.cells.length !== folds.length || !row.cells[0].matches('th[scope="row"]') ||
          [...row.cells].some((item) => item.colSpan !== 1 || item.rowSpan !== 1),
        )) throw new Error("Living table groups need unique data-id values, a disclosure, and complete rows");
      groups.set(body.dataset.id, { body, button, rows, count: button.querySelector(".sd-living-table-count") });
    }
    return groups;
  }

  /** @type {LivingTableDOM} */
  const dom = { headers: initialHeaders, folds, groups: readGroups() };
  /** @type {ResizeGesture|null} */
  let gesture = null;
  let disposed = false;
  let requested = null;
  let lastState;
  const owned = new Map();
  const generatedLabels = new WeakMap();

  function record(el) {
    if (!owned.has(el)) owned.set(el, { attrs: new Map(), styles: new Map(), hadStyle: el.hasAttribute("style") });
    return owned.get(el);
  }
  function attr(el, name, value) {
    const saved = record(el).attrs;
    if (!saved.has(name)) saved.set(name, el.getAttribute(name));
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, String(value));
  }
  function style(el, name, value) {
    const saved = record(el).styles;
    if (!saved.has(name)) saved.set(name, [el.style.getPropertyValue(name), el.style.getPropertyPriority(name)]);
    el.style.setProperty(name, value);
  }
  function restore(el) {
    const saved = owned.get(el);
    for (const [name, value] of saved.attrs) {
      if (value === null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    }
    for (const [name, [value, priority]] of saved.styles) {
      if (value) el.style.setProperty(name, value, priority);
      else el.style.removeProperty(name);
    }
    if (!saved.hadStyle && !el.style.length) el.removeAttribute("style");
    if ("text" in saved) el.textContent = saved.text;
    generatedLabels.delete(el);
    owned.delete(el);
  }

  function tier(folded) {
    const main = folds.map((fold, index) => index).filter((index) => !folded(folds[index]));
    const below = folds.map((fold, index) => index).filter((index) => folded(folds[index]));
    const columns = Math.max(main.length, Math.min(2, below.length));
    return {
      tracks: Array.from({ length: columns }, (_, i) => `minmax(0, ${i === 0 && main.length > 1 ? 2.5 : 1}fr)`).join(" "),
      positions: folds.map((fold, index) => {
        const at = below.indexOf(index);
        return at < 0 ? `1 / ${main.indexOf(index) + 1}${main.length === 1 ? " / auto / -1" : ""}` :
          `${2 + Math.floor(at / columns)} / ${at % columns + 1}`;
      }),
    };
  }
  const tiers = { wide: tier(() => false), medium: tier((fold) => fold === 1), compact: tier((fold) => fold > 0) };

  function decorateCell(cell, index, role) {
    attr(cell, "role", role);
    attr(cell, "data-fold", folds[index] || null);
    const label = cell.getAttribute("data-label");
    if (folds[index] && (label === null || label === generatedLabels.get(cell))) {
      const next = dom.headers[index].textContent.trim();
      attr(cell, "data-label", next);
      generatedLabels.set(cell, next);
    } else generatedLabels.delete(cell);
    for (const [name, plan] of Object.entries(tiers)) style(cell, `--sd-living-${name}-area`, plan.positions[index]);
  }

  function applyGroup(group) {
    const open = group.button.getAttribute("aria-expanded") === "true";
    for (const row of group.rows) attr(row, "hidden", open ? null : "");
  }

  function refresh() {
    if (disposed) return;
    const currentHeaders = [...(table.tHead?.rows[0]?.cells ?? [])];
    if (table.tHead?.rows.length !== 1 || currentHeaders.length !== folds.length || currentHeaders.some((cell, i) =>
      !cell.matches('th[scope="col"]') || cell.colSpan !== 1 || cell.rowSpan !== 1 || Number(cell.dataset.fold || 0) !== folds[i],
    )) {
      throw new Error("Remount the living table after changing its column schema");
    }
    const groups = readGroups();
    dom.headers = currentHeaders;
    const live = new Set([root, wrap, table, grip, table.tHead, ...table.tHead.rows, ...dom.headers]);
    for (const group of groups.values()) {
      for (const el of [group.body, ...group.body.rows, ...group.body.querySelectorAll("th, td"), group.button, group.count]) if (el) live.add(el);
    }
    for (const el of owned.keys()) if (!live.has(el)) restore(el);
    dom.groups = groups;
    attr(table, "role", "table");
    attr(table.tHead, "role", "rowgroup");
    attr(table.tHead.rows[0], "role", "row");
    dom.headers.forEach((cell, i) => decorateCell(cell, i, "columnheader"));
    for (const group of groups.values()) {
      attr(group.body, "role", "rowgroup");
      attr(group.body.rows[0], "role", "row");
      attr(group.body.rows[0].cells[0], "role", "rowheader");
      attr(group.button, "disabled", null);
      attr(group.button, "aria-expanded", group.button.getAttribute("aria-expanded"));
      if (group.count) {
        const saved = record(group.count);
        if (!("text" in saved)) saved.text = group.count.textContent;
        group.count.textContent = group.rows.length;
      }
      for (const row of group.rows) {
        attr(row, "role", "row");
        [...row.cells].forEach((cell, i) => decorateCell(cell, i, i ? "cell" : "rowheader"));
      }
      if (group.button.getAttribute("aria-expanded") === "false" && group.rows.some((row) => row.contains(document.activeElement))) group.button.focus();
      applyGroup(group);
    }
    measure();
  }

  function bounds() {
    const parent = root.parentElement;
    if (!parent) return { min: 0, max: 0 };
    const css = getComputedStyle(parent);
    const max = Math.max(0, parent.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight));
    return { min: Math.min(320, max), max };
  }
  function emit() {
    if (disposed || gesture || !root.isConnected) return;
    const detail = { width: root.getBoundingClientRect().width, collapsed: [...dom.groups].filter(([, group]) => group.button.getAttribute("aria-expanded") === "false").map(([id]) => id) };
    const state = JSON.stringify(detail);
    if (lastState === undefined) { lastState = state; return; }
    if (state === lastState) return;
    lastState = state;
    root.dispatchEvent(new CustomEvent("sd:living-table", { bubbles: true, detail }));
  }
  function measure() {
    if (disposed) return;
    if (!root.isConnected) { scheduleMeasure(); return; }
    const parent = root.parentElement;
    if (parent !== observedParent) {
      if (observedParent) observer.unobserve(observedParent);
      observedParent = parent;
      if (observedParent) observer.observe(observedParent);
    }
    const { min, max } = bounds();
    const width = requested === null ? "100%" : `${Math.min(max, Math.max(min, requested))}px`;
    if (root.style.width !== width) style(root, "width", width);
    attr(grip, "aria-valuemin", min);
    attr(grip, "aria-valuemax", max);
    const actualWidth = root.getBoundingClientRect().width;
    attr(grip, "aria-valuenow", actualWidth);
    attr(grip, "aria-valuetext", getLabel("table.width", { value: Math.round(actualWidth) }));
    emit();
  }
  function resize({ width }) {
    if (disposed) return;
    if (width !== null && (typeof width !== "number" || !Number.isFinite(width))) throw new TypeError("Living table width must be a finite number or null");
    finishGesture(true);
    requested = width;
    measure();
  }
  function toggle(id, open) {
    if (disposed) return;
    const group = dom.groups.get(id);
    if (!group) return;
    open ??= group.button.getAttribute("aria-expanded") !== "true";
    if (!open && group.rows.some((row) => row.contains(document.activeElement))) group.button.focus();
    attr(group.button, "aria-expanded", Boolean(open));
    applyGroup(group);
    measure();
  }
  function click(event) {
    for (const [id, group] of dom.groups) if (group.button.contains(event.target)) { toggle(id); break; }
  }
  function finishGesture(cancel = false) {
    if (!gesture) return;
    const previous = gesture;
    if (cancel) requested = previous.requested;
    gesture = null;
    attr(root, "data-resizing", null);
    if (grip.hasPointerCapture(previous.pointerId)) grip.releasePointerCapture(previous.pointerId);
    measure();
  }
  function pointerdown(event) {
    if (event.button !== 0 || !event.isPrimary || gesture) return;
    event.preventDefault();
    grip.focus();
    gesture = { pointerId: event.pointerId, x: event.clientX, width: root.getBoundingClientRect().width, requested, direction: getComputedStyle(root).direction === "rtl" ? -1 : 1 };
    grip.setPointerCapture(event.pointerId);
    attr(root, "data-resizing", "");
  }
  function pointermove(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    requested = gesture.width + (event.clientX - gesture.x) * gesture.direction;
    measure();
  }
  function pointerend(event) {
    if (gesture && event.pointerId === gesture.pointerId) finishGesture(event.type !== "pointerup");
  }
  function keydown(event) {
    if (event.key === "Escape" && gesture) { event.preventDefault(); finishGesture(true); return; }
    const { min, max } = bounds();
    const direction = getComputedStyle(root).direction === "rtl" ? -1 : 1;
    const step = (event.shiftKey ? 64 : 16) * direction;
    const width = root.getBoundingClientRect().width;
    const next = { ArrowLeft: width - step, ArrowRight: width + step, Home: min, End: max }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    resize({ width: Math.min(max, Math.max(min, next)) });
  }

  let frame;
  let observedParent = null;
  function scheduleMeasure() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (root.isConnected) measure();
    });
  }
  const observer = new ResizeObserver(scheduleMeasure);
  observer.observe(root);
  mounts.add(root);
  attr(root, "data-mounted", "");
  for (const [name, plan] of Object.entries(tiers)) style(table, `--sd-living-${name}-tracks`, plan.tracks);
  attr(grip, "hidden", null);
  attr(grip, "role", "separator");
  attr(grip, "tabindex", "0");
  attr(grip, "aria-orientation", "vertical");
  attr(grip, "aria-controls", wrap.id);
  if (!grip.hasAttribute("aria-label")) attr(grip, "aria-label", getLabel("table.resize"));
  refresh();
  root.addEventListener("click", click);
  const handlers = { pointerdown, pointermove, pointerup: pointerend, pointercancel: pointerend, lostpointercapture: pointerend, keydown };
  for (const [type, handler] of Object.entries(handlers)) grip.addEventListener(type, handler);
  return {
    toggle, resize, refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      finishGesture(true);
      observer.disconnect();
      cancelAnimationFrame(frame);
      root.removeEventListener("click", click);
      for (const [type, handler] of Object.entries(handlers)) grip.removeEventListener(type, handler);
      for (const el of owned.keys()) restore(el);
      dom.groups.clear();
      mounts.delete(root);
    },
  };
}
