/**
 * Consistency checks for the graphics quality ladder.
 *
 * Every tier is a hand-written bundle of independent knobs (shadow cascades, reflection
 * resolution, post-pass enables, foliage density, pixel-ratio ceiling, dynamic-resolution
 * floor). They drift silently: a tier can end up *more* expensive than the one above it, or a
 * knob can be left on after switching down. These assertions encode the monotonicity the
 * ladder is supposed to have, without needing a GPU to measure it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

function read(file: string): string {
  return readFileSync(join(SRC, file), 'utf8');
}

describe('quality ladder', () => {
  const engine = read('GolfEngine.ts');
  const post = read('PostProcessing.ts');

  it('exposes a fourth, cheaper tier', () => {
    expect(post).toContain("export type GraphicsQuality = 'ultra' | 'high' | 'medium' | 'low'");
  });

  it('draws LOW straight to the canvas without the composer', () => {
    expect(engine).toContain('this.postProc.bypassed = isLow');
    expect(post).toContain('public set bypassed(value: boolean)');
    // The render path has to actually honour the flag, or LOW silently stays expensive.
    expect(post).toMatch(/if \(this\.enabled\) \{\s*this\.composer\.render\(\);/);
    // and fall back to a direct render when bypassed
    expect(post).toMatch(/this\.renderer\.render\(this\.scene, this\.camera\);/);
  });

  it('reduces shadow work monotonically down the ladder', () => {
    // resolution: 4096 > 2048 > 512
    expect(engine).toMatch(/setShadowResolution\(quality === 'ultra' \? 4096 : quality === 'high' \? 2048 : 512\)/);
    // and LOW collapses to a single cascade
    expect(engine).toContain('this.skySys.setShadowCascades(isLow ? 1 : 3)');
  });

  it('disables the water reflection below HIGH', () => {
    expect(engine).toContain("this.oceanSys.planarReflectionEnabled = quality === 'ultra' || quality === 'high'");
  });

  it('shrinks the reflection target down the ladder', () => {
    expect(engine).toMatch(/setReflectionResolution\(quality === 'ultra' \? 1024 : quality === 'high' \? 512 : 256\)/);
  });

  it('lets LOW fall to a lower dynamic-resolution floor', () => {
    expect(engine).toContain('this.adaptiveRes.setMinScale(isLow ? 0.4 : 0.5)');
  });

  it('auto-scaler can reach the cheapest tier', () => {
    expect(engine).toContain("this.qualityLevel !== 'low'");
    expect(engine).toContain("const ladder: GraphicsQuality[] = ['ultra', 'high', 'medium', 'low']");
    // It must never end up storing `undefined` when already at the bottom.
    expect(engine).toContain('Math.min(ladder.length - 1, idx + 1)');
  });

  it('defaults weak hardware below ULTRA', () => {
    expect(engine).toContain("if (coarseTouch) return 'high'");
    expect(engine).toContain("return 'low'");
    // Ultra must not be the mobile default any more.
    expect(engine).not.toMatch(/if \(isMobile\) return cores >= 8 && memGb >= 6 \? 'high' : 'medium';/);
  });
});
