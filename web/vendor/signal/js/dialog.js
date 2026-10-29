/**
 * Dialogs and sheets on the native <dialog> element.
 *
 *   <button data-sd-open="confirm">Delete</button>
 *   <dialog id="confirm" class="sd-dialog"> … <button data-sd-close>Cancel</button></dialog>
 *
 * Escape and a click on the backdrop close it unless the dialog has data-sd-static.
 * data-sd-static="" (or any value but the two below) turns both off;
 * data-sd-static="escape" turns off Escape only, "backdrop" the backdrop only.
 * data-sd-close="value" closes with dialog.returnValue = value.
 */
function resolve(target) {
  return typeof target === "string" ? document.getElementById(target) : target;
}

/** Whether Escape, or the backdrop, closes this dialog: data-sd-static names what is switched off. */
const closes = (dialog, path) => {
  const off = dialog.dataset.sdStatic;
  return off === undefined || (path === "escape" ? off === "backdrop" : off === "escape");
};

export function openDialog(target) {
  const dialog = resolve(target);
  if (dialog && !dialog.open) {
    // WebKit does not always hand focus back when a modal closes; do it here.
    const opener = document.activeElement;
    dialog.addEventListener(
      "close",
      () => {
        const lost = !document.activeElement || document.activeElement === document.body || dialog.contains(document.activeElement);
        if (lost && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
        else if (lost) document.activeElement?.blur?.();
      },
      { once: true },
    );
    dialog.showModal();
  }
  return dialog;
}

export function closeDialog(target, value) {
  const dialog = resolve(target);
  if (dialog?.open) dialog.close(value);
  return dialog;
}

/** Escape closes the dialog it was pressed in. WebKit's search fields swallow it otherwise. */
export function onDialogKeydown(event) {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const dialog = event.target.closest?.("dialog[open]");
  if (dialog && closes(dialog, "escape")) {
    event.preventDefault();
    dialog.close("");
    // Leave the closed dialog now; the close event hands focus back to the opener after.
    if (dialog.contains(document.activeElement)) document.activeElement.blur();
  }
}

export function onDialogClick(event) {
  const opener = event.target.closest("[data-sd-open]");
  if (opener) {
    event.preventDefault();
    openDialog(opener.dataset.sdOpen);
    return;
  }
  const closer = event.target.closest("[data-sd-close]");
  if (closer) {
    const dialog = closer.closest("dialog");
    if (dialog) {
      event.preventDefault();
      closeDialog(dialog, closer.dataset.sdClose || "");
    }
    return;
  }
  // A click whose target is the dialog itself landed on the backdrop.
  const dialog = event.target;
  if (dialog instanceof HTMLDialogElement && dialog.open && closes(dialog, "backdrop")) {
    const r = dialog.getBoundingClientRect();
    const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    if (!inside) dialog.close("");
  }
}
