/**
 * Behavioural tests for the dynamic-resolution controller.
 *
 * The controller is the safety net that keeps frame pacing stable on hardware that cannot
 * sustain the initial quality tier, so its failure modes are visible: too eager and the
 * image visibly pumps; too timid and the game keeps stuttering. These tests pin both ends,
 * plus the two traps the implementation has to avoid (reacting to a single GC pause, and
 * downgrading forever because a resize recompile looked like sustained slowness).
 */
import { describe, expect, it } from 'vitest';
import { AdaptiveResolution } from '../AdaptiveResolution';

/** Feeds `frames` frames of a constant frame time and returns the final scale. */
function run(ctrl: AdaptiveResolution, frames: number, frameMs: number): number {
  let scale = ctrl.currentScale;
  for (let i = 0; i < frames; i++) scale = ctrl.update(frameMs / 1000);
  return scale;
}

function makeController(): AdaptiveResolution {
  return new AdaptiveResolution({
    maxScale: 1,
    minScale: 0.5,
    maxFrameMs: 1000 / 52,
    comfortableFrameMs: 1000 / 59,
    windowSeconds: 1.4,
  });
}

describe('AdaptiveResolution', () => {
  it('stays at full scale when frames are comfortable', () => {
    const ctrl = makeController();
    expect(run(ctrl, 400, 16.6)).toBe(1);
  });

  it('drops resolution when frames are persistently slow', () => {
    const ctrl = makeController();
    const scale = run(ctrl, 400, 33);
    expect(scale).toBeLessThan(1);
    // It should have stepped down meaningfully but not collapsed to the floor outright.
    expect(scale).toBeGreaterThanOrEqual(0.5);
  });

  it('never goes below the configured floor', () => {
    const ctrl = makeController();
    const scale = run(ctrl, 4000, 120);
    expect(scale).toBeCloseTo(0.5, 5);
  });

  it('ignores an isolated stall (GC pause / shader compile)', () => {
    const ctrl = makeController();
    run(ctrl, 120, 16.6);
    // One 250ms hitch followed by healthy frames must not trigger a downgrade.
    ctrl.update(0.25);
    const scale = run(ctrl, 200, 16.6);
    expect(scale).toBe(1);
  });

  it('does not react during the settle period after a change', () => {
    const ctrl = makeController();
    run(ctrl, 400, 33);
    const afterDrop = ctrl.currentScale;
    // Immediately after a change the next frames are recompile-heavy; they must be ignored
    // rather than feeding a downgrade spiral.
    run(ctrl, 2, 90);
    expect(ctrl.currentScale).toBe(afterDrop);
  });

  it('recovers toward full scale once frames are fast again', () => {
    const ctrl = makeController();
    run(ctrl, 400, 33);
    expect(ctrl.currentScale).toBeLessThan(1);
    const recovered = run(ctrl, 1200, 15.5);
    expect(recovered).toBe(1);
  });

  it('steps down quickly but back up slowly', () => {
    const down = makeController();
    run(down, 200, 34);
    const downSteps = 1 - down.currentScale;

    const up = makeController();
    up.setScale(0.5);
    run(up, 200, 15.5); // same number of frames as the down case
    const upSteps = up.currentScale - 0.5;

    // Asymmetric on purpose: recovering too fast causes visible pumping.
    expect(downSteps).toBeGreaterThan(upSteps);
  });

  it('notifies the host when the scale actually changes', () => {
    const ctrl = makeController();
    const seen: number[] = [];
    ctrl.onScaleChange = (s) => seen.push(s);
    run(ctrl, 400, 33);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s < 1 && s >= 0.5)).toBe(true);
  });
});
