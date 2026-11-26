/**
 * Tiling guarantees for the procedurally baked bark relief.
 *
 * The bark map is sampled with RepeatWrapping on every trunk, so a field that does not wrap
 * cleanly shows a hard seam line running up the trunk. That regression existed in the
 * previous bake: it scaled v by fractional amounts (`v * 0.28`, `v * 0.45`) and offset u by a
 * non-integer warp before feeding the periodic noise helpers, so neither axis wrapped.
 */
import { describe, expect, it } from 'vitest';
import { barkHeightAt } from '../ProceduralTextures';

/** Mean absolute discontinuity across the u/v wrap, in relief units. */
function wrapError(axis: 'u' | 'v'): number {
  const N = 128;
  let err = 0;
  let n = 0;
  for (let i = 0; i < N; i += 2) {
    for (let eps = 1; eps <= 3; eps++) {
      const past = eps / N;
      const a = axis === 'u' ? barkHeightAt(1 + past, i / N) : barkHeightAt(i / N, 1 + past);
      const b = axis === 'u' ? barkHeightAt(past, i / N) : barkHeightAt(i / N, past);
      err += Math.abs(a - b);
      n++;
    }
  }
  return err / n;
}

describe('bark relief tiling', () => {
  it('wraps seamlessly along u (horizontal)', () => {
    expect(wrapError('u')).toBeLessThan(1e-9);
  });

  it('wraps seamlessly along v (vertical)', () => {
    expect(wrapError('v')).toBeLessThan(1e-9);
  });

  it('produces relief across the full useful range', () => {
    let min = 1;
    let max = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const h = barkHeightAt(x / 64, y / 64);
        min = Math.min(min, h);
        max = Math.max(max, h);
      }
    }
    // Deep crevices must approach 0 and ridges must reach well above mid-grey, otherwise the
    // height-derived normal map flattens out and the bark reads as smooth plastic.
    expect(min).toBeLessThan(0.25);
    expect(max).toBeGreaterThan(0.6);
  });
});
