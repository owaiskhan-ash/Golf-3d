/**
 * Real app-loading progress tracker.
 *
 * Three measured stages drive the splash screen so the loader reflects actual
 * loading time instead of a fake timer:
 *   1. Engine + course construction (synchronous, heavy terrain build) — 0.04 → 0.30
 *   2. golfer.glb download (~13 MB, real byte fraction from GLTFLoader) — 0.30 → 0.85
 *   3. First rendered WebGL frame — 0.85 → 1.00
 *
 * `done` only fires once ALL three settle (GLB load OR graceful fallback counts),
 * and progress is monotonic so the bar never jumps backwards.
 */
export interface LoadingState {
  progress: number; // 0..1
  label: string;
  done: boolean;
}

type Listener = (state: LoadingState) => void;

class LoadingTracker {
  private golferFraction = 0;
  private golferSettled = false;
  private engineBuilt = false;
  private firstFrame = false;
  private lastProgress = 0;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  private snapshot(): LoadingState {
    const done = this.engineBuilt && this.golferSettled && this.firstFrame;
    const progress =
      (this.engineBuilt ? 0.3 : 0.04) +
      (this.golferSettled ? 0.55 : this.golferFraction * 0.55) +
      (this.firstFrame ? 0.15 : 0);
    const label = done
      ? 'Welcome to the links'
      : !this.engineBuilt
        ? 'Shaping the fairways'
        : !this.golferSettled
          ? 'Downloading the golfer'
          : 'Teeing up';
    return { progress: done ? 1 : Math.min(0.99, progress), label, done };
  }

  private emit(): void {
    const s = this.snapshot();
    s.progress = Math.max(s.progress, this.lastProgress);
    this.lastProgress = s.progress;
    this.listeners.forEach((fn) => fn(s));
  }

  /** Engine constructor finished (course terrain, textures, systems all built). */
  markEngineBuilt(): void {
    this.engineBuilt = true;
    this.emit();
  }

  /** Real GLB download fraction (0..1) from the loader's progress events. */
  setGolferProgress(fraction: number): void {
    this.golferFraction = Math.max(this.golferFraction, Math.min(1, Math.max(0, fraction)));
    this.emit();
  }

  /** GLB finished loading OR failed into the procedural fallback — either way we proceed. */
  markGolferSettled(): void {
    this.golferSettled = true;
    this.emit();
  }

  /** First real WebGL frame hit the canvas. */
  markFirstFrame(): void {
    this.firstFrame = true;
    this.emit();
  }
}

export const loadingTracker = new LoadingTracker();
