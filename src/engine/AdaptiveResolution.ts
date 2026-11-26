/**
 * Adaptive render-resolution controller.
 *
 * The scene is fragment-bound: a terrain shader that samples two terrains' worth of detail
 * maps, a GTAO pass, bloom, light shafts and a full extra scene render for the ocean
 * reflection, all shaded at devicePixelRatio × viewport. Fill rate is therefore the single
 * biggest lever on frame time, and it is also the one axis where a small reduction is nearly
 * invisible compared to dropping quality tiers (which removes whole effects).
 *
 * Strategy:
 *  - Track the median frame interval over a short window (median, not mean, so a single GC
 *    pause or shader compile cannot trigger a downgrade).
 *  - Ignore the first second after a resize/quality change: those frames include shader
 *    recompiles and reallocations and would otherwise cause a downgrade spiral.
 *  - Step down fast (rate-limited to once per window) when we sit above the target, step back
 *    up slowly and conservatively so the resolution never visibly pumps.
 */
export interface AdaptiveResolutionOptions {
  /** Minimum pixel ratio we will scale down to, relative to the device's own DPR. */
  minScale?: number;
  /** Target frame interval in milliseconds (e.g. 16.7 for 60 fps). */
  targetFrameMs?: number;
  /** Frames above this are considered "struggling" and trigger a step down. */
  maxFrameMs?: number;
  /** Frames below this are comfortable enough to earn a step back up. */
  comfortableFrameMs?: number;
  /** Seconds of frame history to consider per decision window. */
  windowSeconds?: number;
}

export class AdaptiveResolution {
  private readonly samples: number[] = [];
  private settleS = 0;
  private sampleAccumS = 0;
  private stepUpStreak = 0;
  private scale: number;

  public minScale: number;
  public readonly maxScale: number;
  public readonly targetFrameMs: number;
  public readonly maxFrameMs: number;
  public readonly comfortableFrameMs: number;
  public readonly windowSeconds: number;

  /** Fired when the controller wants a new scale factor (1.0 = full device pixel ratio). */
  public onScaleChange: (scale: number) => void = () => {};

  constructor(options: AdaptiveResolutionOptions & { maxScale: number }) {
    this.maxScale = options.maxScale;
    this.minScale = options.minScale ?? 0.55;
    this.targetFrameMs = options.targetFrameMs ?? 1000 / 60;
    this.maxFrameMs = options.maxFrameMs ?? 1000 / 45;
    this.comfortableFrameMs = options.comfortableFrameMs ?? 1000 / 58;
    this.windowSeconds = options.windowSeconds ?? 1.6;
    this.scale = this.maxScale;
  }

  /** Lets a quality tier decide how far resolution may fall (LOW goes deeper). */
  public setMinScale(next: number): void {
    this.minScale = Math.max(0.25, Math.min(this.maxScale, next));
    if (this.scale < this.minScale) this.applyScale(this.minScale, 0.1);
  }

  public get currentScale(): number {
    return this.scale;
  }

  /** Clears history, e.g. after a resize or a quality change invalidated timings. */
  public reset(): void {
    this.samples.length = 0;
    this.sampleAccumS = 0;
    this.settleS = 0;
    this.stepUpStreak = 0;
  }

  /** Hard-sets the scale without feedback (used when a preset picks a new ceiling). */
  public setScale(scale: number): void {
    const clamped = Math.min(this.maxScale, Math.max(this.minScale, scale));
    if (Math.abs(clamped - this.scale) < 1e-3) return;
    this.scale = clamped;
    this.onScaleChange(clamped);
    this.reset();
  }

  /**
   * Feeds one frame's raw delta time (seconds) and may request a scale change.
   * Returns the scale that should be used for the *next* frame.
   */
  public update(rawDt: number): number {
    // ~1s of settling after any change: shader recompiles and buffer reallocation make the
    // first frames unrepresentatively slow.
    if (this.settleS > 0) {
      this.settleS = Math.max(0, this.settleS - rawDt);
      return this.scale;
    }

    // Guard against absurd values (tab was backgrounded, debugger paused, etc.)
    if (rawDt <= 0 || rawDt > 0.25) return this.scale;

    this.samples.push(rawDt * 1000);
    this.sampleAccumS += rawDt;
    const maxSamples = 240;
    if (this.samples.length > maxSamples) this.samples.shift();
    if (this.sampleAccumS < this.windowSeconds) return this.scale;

    this.sampleAccumS = 0;
    const median = medianOf(this.samples);

    if (median > this.maxFrameMs && this.scale > this.minScale + 1e-3) {
      // Struggling: drop ~12% of device pixels per step. Rate-limited by the window so this
      // cannot free-fall to the floor in a few frames.
      this.stepUpStreak = 0;
      const next = this.scale * 0.88;
      this.applyScale(next < this.minScale * 1.02 ? this.minScale : next);
      return this.scale;
    }

    if (median < this.comfortableFrameMs && this.scale < this.maxScale - 1e-3) {
      // Comfortable: creep back up, but only after two consecutive comfortable windows so a
      // borderline machine does not oscillate between scales.
      this.stepUpStreak++;
      if (this.stepUpStreak >= 2) {
        this.stepUpStreak = 0;
        // Snap to the ceiling if the next step would land within 2% of it; otherwise the
        // scale converges asymptotically and never actually reaches full resolution.
        const next = this.scale * 1.15;
        this.applyScale(next > this.maxScale * 0.98 ? this.maxScale : next, 0.45);
      }
    } else {
      this.stepUpStreak = 0;
    }

    return this.scale;
  }

  private applyScale(next: number, settleS = 0.9): void {
    const clamped = Math.min(this.maxScale, Math.max(this.minScale, next));
    if (Math.abs(clamped - this.scale) < 1e-3) return;
    this.scale = clamped;
    // Recovery moves a small distance, so it can resume sampling quickly and would otherwise
    // crawl back up. Downgrades move further and force shader/RT churn, so they settle longer.
    this.settleS = settleS;
    this.samples.length = 0;
    this.onScaleChange(clamped);
  }
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
