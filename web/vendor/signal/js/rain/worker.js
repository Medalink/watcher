/** Renders the rain off the main thread when OffscreenCanvas is available. */
import { createRainRenderer } from "./renderer.js";

let renderer;

self.onmessage = ({ data }) => {
  if (data.type === "init") {
    renderer = createRainRenderer(data.canvas, data.options);
    self.postMessage({ type: "started" });
    return;
  }
  if (data.type === "update") renderer?.update(data.options);
};

self.postMessage({
  type: "ready",
  supported: typeof OffscreenCanvas === "function" && typeof self.requestAnimationFrame === "function",
});
