/**
 * Signal App Shell behavior. State is data attributes on .sd-shell; the CSS
 * does the rest.
 *
 *   <button data-sd-shell="sidebar">   pin or collapse the sidebar (remembered)
 *   <button data-sd-shell="aside">     open or close the right panel
 *   <button data-sd-shell="drawer">    open or close the phone drawer
 *   <button data-sd-shell="close">     close the drawer or a peeking sidebar
 *   <a class="sd-rail-item" data-sd-section="projects">
 *       shows <div class="sd-sidebar-panel" data-section="projects">; when the
 *       sidebar is collapsed it peeks over the page instead
 *
 * Fires "sd:shell" on the shell with detail { sidebar, aside, drawer, section }.
 */
const KEY = "sd-shell-sidebar";
const phone = () => matchMedia("(max-width: 48rem)").matches;

function emit(shell) {
  shell.dispatchEvent(
    new CustomEvent("sd:shell", {
      bubbles: true,
      detail: {
        sidebar: shell.dataset.sidebar || "pinned",
        aside: shell.dataset.aside || "closed",
        drawer: "drawer" in shell.dataset,
        section: shell.querySelector(".sd-sidebar-panel:not([hidden])")?.dataset.section,
      },
    }),
  );
}

function sync(shell) {
  const collapsed = shell.dataset.sidebar === "collapsed";
  for (const b of shell.querySelectorAll('[data-sd-shell="sidebar"]')) {
    b.setAttribute("aria-expanded", String(!collapsed));
    b.setAttribute("aria-label", collapsed ? "Pin sidebar open" : "Collapse sidebar");
  }
  for (const b of shell.querySelectorAll('[data-sd-shell="aside"]')) {
    b.setAttribute("aria-expanded", String(shell.dataset.aside === "open"));
  }
  for (const b of shell.querySelectorAll('[data-sd-shell="drawer"]')) {
    b.setAttribute("aria-expanded", String("drawer" in shell.dataset));
  }
  // While the drawer is open the page behind it can't be reached.
  const main = shell.querySelector(".sd-shell-main");
  if (main) main.inert = "drawer" in shell.dataset;
}

export function setSidebar(shell, state) {
  if (state === "collapsed") shell.dataset.sidebar = "collapsed";
  else delete shell.dataset.sidebar;
  delete shell.dataset.peek;
  try {
    localStorage.setItem(KEY, state);
  } catch {
    /* storage blocked */
  }
  sync(shell);
  emit(shell);
}

export function setAside(shell, open) {
  if (open) shell.dataset.aside = "open";
  else delete shell.dataset.aside;
  sync(shell);
  emit(shell);
}

export function setDrawer(shell, open) {
  if (open) shell.dataset.drawer = "";
  else delete shell.dataset.drawer;
  sync(shell);
  if (open) shell.querySelector('.sd-rail-item[aria-current]:not([aria-current="false"])')?.focus();
  emit(shell);
}

function closeOverlays(shell) {
  const had = "peek" in shell.dataset || "drawer" in shell.dataset;
  delete shell.dataset.peek;
  if ("drawer" in shell.dataset) setDrawer(shell, false);
  else if (had) emit(shell);
  return had;
}

export function selectSection(shell, name) {
  for (const item of shell.querySelectorAll(".sd-rail-item[data-sd-section]")) {
    if (item.dataset.sdSection === name) item.setAttribute("aria-current", "true");
    else item.removeAttribute("aria-current");
  }
  for (const panel of shell.querySelectorAll(".sd-sidebar-panel")) {
    panel.hidden = panel.dataset.section !== name;
  }
  if (shell.dataset.sidebar === "collapsed" && !phone()) shell.dataset.peek = "";
  emit(shell);
}

export function onShellClick(event) {
  const control = event.target.closest("[data-sd-shell]");
  const shell = (control || event.target).closest?.(".sd-shell");
  if (!shell) return;

  if (control) {
    const what = control.dataset.sdShell;
    if (what === "sidebar") {
      // On phones the sidebar lives in the drawer; its collapse button closes the drawer.
      if (phone()) setDrawer(shell, false);
      else setSidebar(shell, shell.dataset.sidebar === "collapsed" ? "pinned" : "collapsed");
    } else if (what === "aside") setAside(shell, shell.dataset.aside !== "open");
    else if (what === "drawer") setDrawer(shell, !("drawer" in shell.dataset));
    else if (what === "close") closeOverlays(shell);
    return;
  }

  const section = event.target.closest(".sd-rail-item[data-sd-section]");
  if (section) {
    if (section.tagName === "BUTTON" || section.getAttribute("href") === "#") event.preventDefault();
    selectSection(shell, section.dataset.sdSection);
    return;
  }

  // A link chosen in a peeking sidebar or the drawer closes it.
  if (event.target.closest(".sd-sidebar-link") && ("peek" in shell.dataset || "drawer" in shell.dataset)) {
    closeOverlays(shell);
  }
}

export function onShellKeydown(event) {
  if (event.key !== "Escape") return;
  for (const shell of document.querySelectorAll(".sd-shell[data-peek], .sd-shell[data-drawer]")) {
    if (closeOverlays(shell)) event.preventDefault();
  }
}

/** Restore the remembered sidebar state and set ARIA on every shell. */
export function initShell(root = document) {
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  for (const shell of root.querySelectorAll(".sd-shell")) {
    if (saved === "collapsed") shell.dataset.sidebar = "collapsed";
    else if (saved === "pinned") delete shell.dataset.sidebar;
    sync(shell);
  }
}
