/** Presentation only. The consumer supplies authoritative remaining time on every set(). */
export function mountCountdown(root) {
  let disposed = false;
  let timer;
  let remaining = 0;
  let total = 0;
  let deadline = null;
  let state;
  const value = root.querySelector("[data-sd-countdown-value]");
  const progress = root.querySelector('[role="progressbar"]');
  const attribute = (element, name, value) => {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };

  function render() {
    clearTimeout(timer);
    if (disposed) return;
    if (deadline !== null) remaining = Math.max(0, deadline - performance.now());
    const next = remaining === 0 ? "complete" : deadline === null ? "paused" : "running";
    if (next === "complete") deadline = null;
    attribute(root, "data-state", next);
    const seconds = String(Math.ceil(remaining / 1000));
    if (value && value.textContent !== seconds) value.textContent = seconds;
    if (progress) {
      const percent = String(total === 0 ? 100 : Math.round((1 - remaining / total) * 100));
      attribute(progress, "aria-valuemin", "0");
      attribute(progress, "aria-valuemax", "100");
      attribute(progress, "aria-valuenow", percent);
      attribute(progress, "aria-valuetext", `${seconds} ${seconds === "1" ? "second" : "seconds"} remaining, ${next}`);
      if (progress.style.getPropertyValue("--value") !== percent) progress.style.setProperty("--value", percent);
    }
    if (deadline !== null) timer = setTimeout(render, Math.min(100, remaining));
    if (next !== state) {
      state = next;
      root.dispatchEvent(new CustomEvent("sd:countdown", {
        bubbles: true, detail: { state, remainingMs: remaining, running: state === "running" },
      }));
    }
  }

  return {
    set({ remainingMs, running }) {
      if (disposed) return;
      if (!Number.isFinite(remainingMs)) throw new TypeError("remainingMs must be finite");
      remaining = Math.max(0, remainingMs);
      total = state === "complete" ? remaining : Math.max(total, remaining);
      deadline = running && remaining > 0 ? performance.now() + remaining : null;
      render();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
