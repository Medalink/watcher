/**
 * Small behaviors that need a line or two of JS.
 *
 * Expand:     <button data-sd-toggle="detail-21" aria-expanded="false">
 *             <div class="sd-expand" id="detail-21"><div>…</div></div>
 * Segmented:  <div class="sd-seg" data-sd-seg> <button aria-pressed="true">a</button> …
 *             fires "change" on the group with detail.value
 * Copy:       <button data-sd-copy="#snippet"> or data-sd-copy="literal text"
 * Dropzone:   <label class="sd-dropzone"><input type="file"> Drop files</label>
 */
import { toast } from "./toast.js";
import { getLabel } from "./labels.js";

export function setExpanded(target, open) {
  const panel = typeof target === "string" ? document.getElementById(target) : target;
  if (!panel) return;
  const next = open ?? !("open" in panel.dataset);
  if (next) panel.dataset.open = "";
  else delete panel.dataset.open;
  for (const t of document.querySelectorAll(`[data-sd-toggle="${panel.id}"]`)) {
    t.setAttribute("aria-expanded", String(next));
  }
}

export function onControlsClick(event) {
  const toggle = event.target.closest("[data-sd-toggle]");
  if (toggle) {
    setExpanded(toggle.dataset.sdToggle);
    return;
  }

  const seg = event.target.closest("[data-sd-seg] > button");
  if (seg) {
    const group = seg.parentElement;
    for (const b of group.children) b.setAttribute("aria-pressed", String(b === seg));
    const value = seg.value || seg.textContent.trim();
    group.dispatchEvent(new CustomEvent("change", { bubbles: true, detail: { value } }));
    return;
  }

  const copy = event.target.closest("[data-sd-copy]");
  if (copy) {
    const spec = copy.dataset.sdCopy;
    const source = /^[#.[]/.test(spec) ? document.querySelector(spec) : null;
    const text = source ? source.textContent : spec;
    const unavailable = () => toast(getLabel("copy.failed"), { tone: "danger" });
    if (!navigator.clipboard?.writeText) {
      unavailable();
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => toast(getLabel("copy.done"), { tone: "success", timeout: 1400 }),
      unavailable,
    );
  }
}

function zoneOf(event) {
  return event.target.closest?.(".sd-dropzone");
}

export function onDrag(event) {
  const zone = zoneOf(event);
  if (!zone) return;
  event.preventDefault();
  if (event.type === "dragover") zone.dataset.dragging = "";
  else if (event.type === "dragleave" && !zone.contains(event.relatedTarget)) delete zone.dataset.dragging;
  else if (event.type === "drop") {
    delete zone.dataset.dragging;
    const input = zone.querySelector('input[type="file"]');
    if (input && event.dataTransfer?.files.length) {
      input.files = event.dataTransfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
}
