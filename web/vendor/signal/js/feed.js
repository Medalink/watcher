/** A scrollable feed of stable data-id rows. Mount explicitly, then bracket DOM updates. */
export function mountFeed(root, {
  itemSelector = ".sd-row[data-id][data-order]",
  activeId = null,
  returnTarget = () => null,
  canReturn = () => !root.querySelector('[aria-expanded="true"]'),
  idleMs = 2400,
  returnDistance = 260,
  align = 0.45,
} = {}) {
  let disposed = false;
  let suspended = false;
  let timer;
  let frame;
  let maintenanceFrame;
  let maintaining = false;
  let returnAt = 0;
  let snapshot;
  let lastState;
  const oldAnchor = root.style.overflowAnchor;
  const hadFeed = root.hasAttribute("data-sd-feed");
  root.setAttribute("data-sd-feed", "");
  root.style.overflowAnchor = "none";
  const rows = () => [...root.querySelectorAll(itemSelector)].filter((el) =>
    el.closest("[data-sd-feed]") === root && !el.closest("[hidden], [inert]") && el.getClientRects().length,
  );
  const find = (id) => rows().find((el) => el.dataset.id === id);
  const offset = (el) => el.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientTop;
  const destination = () => {
    const target = returnTarget();
    return typeof target === "string" ? find(target) : target;
  };
  const allowed = () => !disposed && !suspended && canReturn();

  function emit(returnPending = false) {
    if (disposed) return;
    const aboveCount = rows().filter((el) => offset(el) + el.getBoundingClientRect().height <= 0).length;
    const detail = { activeId, aboveCount, returnPending };
    const key = JSON.stringify(detail);
    if (key === lastState) return;
    lastState = key;
    root.dispatchEvent(new CustomEvent("sd:feed", { bubbles: true, detail }));
  }

  function clearReturn() {
    clearTimeout(timer);
    timer = undefined;
    returnAt = 0;
  }

  function cancelReturn() {
    clearReturn();
    emit();
  }

  function ignoreOwnScroll() {
    maintaining = true;
    cancelAnimationFrame(maintenanceFrame);
    maintenanceFrame = requestAnimationFrame(() => { maintaining = false; });
  }

  function center(el, behavior = "auto") {
    cancelAnimationFrame(frame);
    if (!el) return;
    const start = root.scrollTop;
    const end = Math.max(0, Math.min(root.scrollHeight - root.clientHeight, start + offset(el) - root.clientHeight * align));
    if (behavior !== "smooth" || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      ignoreOwnScroll();
      root.scrollTop = end;
      emit();
      return;
    }
    const began = performance.now();
    function step(now) {
      if (disposed || suspended) return;
      const t = Math.min(1, (now - began) / 180);
      ignoreOwnScroll();
      root.scrollTop = start + (end - start) * (1 - (1 - t) ** 3);
      emit();
      if (t < 1 && !disposed && !suspended) frame = requestAnimationFrame(step);
    }
    frame = requestAnimationFrame(step);
  }

  function scheduleReturn(at) {
    const target = destination();
    if (!allowed() || !target || Math.abs(offset(target) - root.clientHeight * align) <= returnDistance) {
      cancelReturn();
      return;
    }
    returnAt = at;
    timer = setTimeout(() => {
      timer = undefined;
      returnAt = 0;
      if (allowed()) {
        center(destination(), "smooth");
      }
      emit();
    }, Math.max(0, at - performance.now()));
    emit(true);
  }

  function onScroll() {
    if (maintaining) return;
    clearReturn();
    scheduleReturn(performance.now() + idleMs);
  }

  function onInput(event) {
    if (event.type === "keydown" && !["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) return;
    maintaining = false;
    cancelAnimationFrame(maintenanceFrame);
    cancelAnimationFrame(frame);
    cancelReturn();
  }

  function refresh() {
    if (disposed) return;
    const items = rows();
    if (!items.some((el) => el.dataset.id === activeId)) {
      activeId = items.find((el) => el.getAttribute("aria-current") === "true")?.dataset.id ?? items[0]?.dataset.id ?? null;
    }
    for (const el of items) {
      if (el.dataset.id === activeId) el.setAttribute("aria-current", "true");
      else el.removeAttribute("aria-current");
    }
    if (!allowed()) cancelReturn();
    else emit(Boolean(returnAt));
  }

  function select(id, { scroll = true, behavior = "auto" } = {}) {
    if (disposed) return;
    const el = find(id);
    if (!el) return;
    activeId = id;
    cancelReturn();
    refresh();
    if (scroll) center(el, behavior);
  }

  root.addEventListener("scroll", onScroll, { passive: true });
  const inputs = ["wheel", "touchstart", "pointerdown", "keydown"];
  for (const type of inputs) root.addEventListener(type, onInput, { passive: true });
  refresh();
  return {
    select,
    move(delta, options) {
      const items = rows();
      const at = items.findIndex((el) => el.dataset.id === activeId);
      const next = items[Math.max(0, Math.min(items.length - 1, at + delta))];
      if (next) select(next.dataset.id, options);
    },
    oldest(options) {
      const item = rows().sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order))[0];
      if (item) select(item.dataset.id, options);
    },
    newest(options) {
      const item = rows().sort((a, b) => Number(b.dataset.order) - Number(a.dataset.order))[0];
      if (item) select(item.dataset.id, options);
    },
    beforeUpdate() {
      if (disposed) return;
      maintaining = true;
      cancelAnimationFrame(maintenanceFrame);
      cancelAnimationFrame(frame);
      const due = returnAt;
      clearReturn();
      const items = rows();
      const visible = items.filter((el) => offset(el) + el.getBoundingClientRect().height > 0 && offset(el) < root.clientHeight);
      const active = visible.find((el) => el.dataset.id === activeId);
      const primary = active || items.filter((el) => offset(el) <= 0).at(-1) || visible[0] || items[0];
      const anchors = [...new Set([primary, ...visible, ...items])].filter(Boolean);
      snapshot = { scrollTop: root.scrollTop, returnAt: due, anchors: anchors.map((el) => ({ id: el.dataset.id, top: offset(el) })) };
    },
    afterUpdate() {
      if (disposed) return;
      const due = snapshot?.returnAt;
      if (snapshot) {
        const held = snapshot.anchors.find((anchor) => find(anchor.id));
        root.scrollTop = held ? root.scrollTop + offset(find(held.id)) - held.top : snapshot.scrollTop;
        if (!find(activeId)) activeId = held?.id ?? null;
        snapshot = undefined;
      }
      returnAt = due || 0;
      refresh();
      if (due) scheduleReturn(due);
      ignoreOwnScroll();
    },
    refresh,
    suspend(value = true) {
      if (disposed) return;
      suspended = value;
      cancelAnimationFrame(frame);
      cancelReturn();
    },
    dispose() {
      if (disposed) return;
      cancelReturn();
      disposed = true;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(maintenanceFrame);
      root.removeEventListener("scroll", onScroll);
      for (const type of inputs) root.removeEventListener(type, onInput);
      root.style.overflowAnchor = oldAnchor;
      if (!hadFeed) root.removeAttribute("data-sd-feed");
      snapshot = undefined;
    },
  };
}
