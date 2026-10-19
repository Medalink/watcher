/**
 * Value formatting for charts. Bandwidth values are in Mbps and climb the
 * Kbps → Mbps → Gbps → Tbps ladder; other units print the value as is.
 *
 *   formatValue(1500, "Mbps")   // "1.5 Gbps"
 *   formatValue(250000, "Mbps") // "250 Gbps"
 *   formatValue(0.5, "Mbps")    // "500 Kbps"
 *   formatValue(12.3, " ms")    // "12.3 ms"
 */
export function formatValue(value, unit = "") {
  if (value == null || Number.isNaN(value)) return "";
  const u = String(unit).trim();
  if (u === "Mbps") {
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} Tbps`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 100_000 ? 0 : 1)} Gbps`;
    if (abs >= 1 || abs === 0) return `${Math.round(value * 10) / 10} Mbps`;
    return `${(value * 1000).toFixed(0)} Kbps`;
  }
  const shown = typeof value === "number" ? Number(value.toFixed(4)) : value;
  return `${shown}${unit}`;
}

export const formatBandwidth = (mbps) => formatValue(mbps, "Mbps");
export const formatMs = (ms) => formatValue(ms, " ms");

/** Signed change for tooltips: " (+1.2 Gbps)" or " (−0.4 Mbps)". */
export function formatDelta(diff, unit) {
  if (!Number.isFinite(diff) || Math.abs(diff) < 1) return "";
  return ` (${diff > 0 ? "+" : "−"}${formatValue(Math.abs(diff), unit)})`;
}
