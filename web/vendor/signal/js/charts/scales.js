/**
 * Symmetric log scale ("sdSymlog"): linear near zero, logarithmic beyond a
 * threshold of 1% of the range, so small and huge traffic share one axis.
 * Ticks are 0 and the powers of ten; labels that would touch are dropped,
 * keeping 0 and the largest decades first.
 */
const forward = (v, t) => Math.sign(v) * Math.log10(1 + Math.abs(v) / t);
const inverse = (v, t) => Math.sign(v) * t * (10 ** Math.abs(v) - 1);

export function createSymlogScale(Scale) {
  class SymlogScale extends Scale {
    determineDataLimits() {
      const { min, max } = this.getMinMax(false);
      this.min = Number.isFinite(this.options.min) ? this.options.min : Number.isFinite(min) ? min : -1;
      this.max = Number.isFinite(this.options.max) ? this.options.max : Number.isFinite(max) ? max : 1;
      if (this.min === this.max) this.max = this.min + 1;
    }

    threshold() {
      return Math.max(Math.abs(this.min), Math.abs(this.max)) / 100 || 1;
    }

    buildTicks() {
      const maxAbs = Math.max(Math.abs(this.min), Math.abs(this.max));
      const top = Math.ceil(Math.log10(maxAbs));
      const bottom = Math.floor(Math.log10(this.threshold()));
      const ticks = this.min <= 0 && this.max >= 0 ? [{ value: 0 }] : [];
      for (let exp = top; exp >= bottom; exp--) {
        const value = 10 ** exp;
        if (value >= this.min && value <= this.max) ticks.push({ value });
        if (-value >= this.min && -value <= this.max) ticks.push({ value: -value });
      }
      ticks.sort((a, b) => a.value - b.value);
      this.allTicks = ticks;
      return ticks;
    }

    configure() {
      super.configure?.();
      const all = this.allTicks;
      const size = Number(this.options?.ticks?.font?.size);
      if (!all?.length || !Number.isFinite(size)) return;
      const gap = size * 1.2 + 2;
      const kept = [];
      const byPriority = [...all].sort((a, b) => (a.value === 0 ? -1 : b.value === 0 ? 1 : Math.abs(b.value) - Math.abs(a.value)));
      for (const tick of byPriority) {
        const pixel = this.getPixelForValue(tick.value);
        if (kept.every((k) => Math.abs(k.pixel - pixel) >= gap)) kept.push({ tick, pixel });
      }
      if (kept.length === all.length && this.ticks?.length === all.length) return;
      this.ticks = kept.map((k) => k.tick).sort((a, b) => a.value - b.value);
      this._labelSizes = null;
      this._labelItems = null;
      this._gridLineItems = null;
    }

    getPixelForValue(value) {
      const t = this.threshold();
      const lo = forward(this.min, t);
      const hi = forward(this.max, t);
      return this.getPixelForDecimal((forward(Number(value) || 0, t) - lo) / (hi - lo || 1));
    }

    getValueForPixel(pixel) {
      const t = this.threshold();
      const lo = forward(this.min, t);
      const hi = forward(this.max, t);
      return inverse(lo + this.getDecimalForPixel(pixel) * (hi - lo), t);
    }
  }
  SymlogScale.id = "sdSymlog";
  SymlogScale.defaults = {};
  return SymlogScale;
}

export { forward as symlogForward, inverse as symlogInverse };
