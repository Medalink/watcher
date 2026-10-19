/**
 * toast("Approved #21", { tone: "success" })
 * toast("Archived", { action: { label: "Undo", onClick: undo } })
 *
 * Returns a function that dismisses the toast. Messages are set as text,
 * never parsed as HTML; pass a Node to render markup you built yourself.
 */
let region;

function toaster() {
  if (region?.isConnected) return region;
  region = document.createElement("div");
  region.className = "sd-toaster";
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  document.body.append(region);
  return region;
}

export function toast(message, { tone, timeout = 2400, action } = {}) {
  const el = document.createElement("div");
  el.className = "sd-toast";
  if (tone) el.dataset.tone = tone;
  el.append(message instanceof Node ? message : document.createTextNode(String(message)));

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    if (el.dataset.leaving !== undefined) return;
    el.dataset.leaving = "";
    setTimeout(() => el.remove(), 160);
  };

  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sd-btn sd-btn-sm sd-btn-ghost";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      action.onClick?.();
      dismiss();
    });
    el.append(btn);
  }

  toaster().append(el);
  if (timeout > 0) {
    timer = setTimeout(dismiss, timeout);
    el.addEventListener("pointerenter", () => clearTimeout(timer));
    el.addEventListener("pointerleave", () => (timer = setTimeout(dismiss, timeout)));
  }
  return dismiss;
}

/** <button data-sd-toast="Saved" data-tone="success"> */
export function onToastClick(event) {
  const trigger = event.target.closest("[data-sd-toast]");
  if (trigger) toast(trigger.dataset.sdToast, { tone: trigger.dataset.sdToastTone });
}
