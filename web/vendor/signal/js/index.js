/**
 * Signal JS. Optional: every component works as static HTML, and this adds
 * behavior to the ones that need it. All listeners are delegated on the
 * document, so markup added later works without calling init again.
 *
 *   import { init, toast, hotkeys } from "signal-design/js";
 *   init();
 */
import { onDialogClick, onDialogKeydown } from "./dialog.js";
import { onPopoverClick, onPopoverBeforeToggle, onPopoverToggle, onMenuKeydown, repositionOpen } from "./popover.js";
import { onTabClick, onTabKeydown, initTabs } from "./tabs.js";
import { onToastClick } from "./toast.js";
import { onTipOver, onTipOut, onTipKeydown, hideTooltip } from "./tooltip.js";
import { onKeyAttr, isKey } from "./hotkeys.js";
import { onControlsClick, onDrag } from "./controls.js";
import { onThemeClick, restoreTheme, cycleTheme } from "./theme.js";
import { onFontClick, restoreFont } from "./font.js";
import { onShellClick, onShellKeydown, onShellPointerdown, initShell } from "./shell.js";
import { onRainClick, initRain } from "./rain.js";
import { initFps } from "./fps.js";
import { initOrnaments } from "./ornaments.js";
import { initScrollbars } from "./scrollbars.js";
import { initScrollTabs } from "./scrolltabs.js";
import { onWindowClick, onWindowDblClick, initWindow } from "./window.js";
import { onListboxInput, onListboxKeydown, onListboxClick, initPalettes } from "./listbox.js";
import { onInputsKeydown, onInputsClick, onInputsInput, onShortcutsKey, initInputs } from "./inputs.js";
import { onConversationClick, onConversationInput, onConversationKeydown, onSuggestClick, onContextMenu, onContextMenuKey, initConversation } from "./conversation.js";

export { openDialog, closeDialog } from "./dialog.js";
export { selectTab } from "./tabs.js";
export { toast } from "./toast.js";
export { setLabels, getLabel, DEFAULT_LABELS } from "./labels.js";
export { hotkeys, keyOf } from "./hotkeys.js";
export { mountCountdown } from "./countdown.js";
export { mountStream, ALERT_KINDS } from "./broadcast.js";

export { mountFeed } from "./feed.js";
export { mountLivingTable } from "./living-table.js";
export { setExpanded } from "./controls.js";
export { setTheme, getTheme, restoreTheme, cycleTheme, THEMES } from "./theme.js";
export { setFont, getFont, restoreFont, FONTS } from "./font.js";
export { place } from "./position.js";
export { setSidebar, setSidebarWidth, setAside, setDrawer, selectSection } from "./shell.js";
export { rain, mountRain } from "./rain.js";
export { fps } from "./fps.js";
export { paintOrnaments, ornamentShapes, ORNAMENT_STYLES } from "./ornaments.js";
export { ornamentArt, ORNAMENT_ART } from "./ornament-art.js";
export { setScrollbars, initScrollbars } from "./scrollbars.js";
export { setOptions, filterList } from "./listbox.js";
export { drawSpark } from "./inputs.js";
export { windowAction } from "./window.js";

let started = false;

/**
 * @param {{ theme?: boolean, font?: boolean, scrollbars?: "auto" | "always" }} [opts]
 *   theme: restore the saved theme (default true)
 *   font: restore the saved text font (default true)
 *   scrollbars: "auto" hides them 2s after scrolling stops (default)
 */
export function init({ theme = true, font = true, scrollbars = "auto", themeKey = "shift+t" } = {}) {
  if (theme) restoreTheme(document.documentElement.dataset.theme || "ink");
  if (font) restoreFont(document.documentElement.dataset.font);
  initScrollbars(scrollbars);
  initTabs();
  initShell();
  initRain();
  initFps();
  initOrnaments();
  initConversation();
  initPalettes();
  initInputs();
  initWindow();
  initScrollTabs();
  if (started) return;
  started = true;

  document.addEventListener("click", (event) => {
    onThemeClick(event);
    onFontClick(event);
    onDialogClick(event);
    onPopoverClick(event);
    onTabClick(event);
    onToastClick(event);
    onControlsClick(event);
    onShellClick(event);
    onRainClick(event);
    onConversationClick(event);
    onListboxClick(event);
    onWindowClick(event);
    onInputsClick(event);
    onSuggestClick(event);
  });
  document.addEventListener("keydown", (event) => {
    onListboxKeydown(event);
    onInputsKeydown(event);
    onShortcutsKey(event);
    onConversationKeydown(event);
    onContextMenuKey(event);
    onDialogKeydown(event);
    onShellKeydown(event);
    onTabKeydown(event);
    onMenuKeydown(event);
    onTipKeydown(event);
    onKeyAttr(event);
    // Shift+T steps the theme on every page, unless a [data-sd-key] took it.
    if (themeKey && isKey(event, themeKey)) {
      event.preventDefault();
      cycleTheme();
    }
  });
  // toggle does not bubble; capture catches every popover.
  document.addEventListener("beforetoggle", onPopoverBeforeToggle, true);
  document.addEventListener("toggle", onPopoverToggle, true);
  document.addEventListener("pointerover", onTipOver);
  document.addEventListener("pointerout", onTipOut);
  document.addEventListener("focusin", onTipOver);
  document.addEventListener("focusout", onTipOut);
  for (const type of ["dragover", "dragleave", "drop"]) document.addEventListener(type, onDrag);
  addEventListener("scroll", () => (repositionOpen(), hideTooltip()), { passive: true, capture: true });
  addEventListener("resize", repositionOpen, { passive: true });
  document.addEventListener("input", (event) => {
    onConversationInput(event);
    onListboxInput(event);
    onInputsInput(event);
  });
  document.addEventListener("pointerdown", onShellPointerdown);
  document.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("dblclick", onWindowDblClick);
}
