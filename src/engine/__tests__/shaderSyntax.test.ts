/**
 * Static GLSL validation for every `onBeforeCompile` shader patch in the engine.
 *
 * These patches inject large GLSL blocks into three.js' built-in materials by string
 * replacement, which WebGL only reports at compile time — a typo therefore shows up as a
 * blank screen or a console error at runtime, never at `tsc`/build time. This test parses
 * every injected block, so syntax errors (unbalanced braces, missing semicolons, bad
 * literals, malformed preprocessor use) fail CI instead of the game.
 *
 * It cannot catch type errors or undefined identifiers — that needs a full GLSL compiler —
 * but it covers the failure mode these patches actually have.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parser } from '@shaderfrog/glsl-parser';

const SRC = join(__dirname, '..');

type Patch = { target: string; glsl: string };

function read(file: string): string {
  return readFileSync(join(SRC, file), 'utf8');
}

/**
 * Extracts every `.replace('<chunk hook>', <replacement>)` pair where the replacement is a
 * template literal or a single-quoted string. The engine uses both shapes: older patches
 * inline GLSL into a quoted string, newer ones use a template literal.
 */
function extractPatches(source: string): Patch[] {
  const patches: Patch[] = [];
  const re =
    /\.replace\(\s*'(#[^']*)'\s*,\s*(?:\/\* glsl \*\/\s*)?(?:`((?:[^`\\]|\\[\s\S])*)`|'((?:[^'\\\n]|\\.)*)')/g;
  for (const m of source.matchAll(re)) {
    const raw = m[2] ?? m[3] ?? '';
    // TS template interpolations (${expr}) are resolved at runtime; stand in a literal so
    // the block is parseable and what we validate matches what compiles.
    const isGlobal = m[1] === '#include <common>';
    const glsl = raw
      .replace(/\\n/g, '\n')
      .replace(/\\'/g, "'")
      // Global-scope interpolations are whole GLSL fragments (shared env uniforms); empty
      // them out. Statement-level ones are numeric literals (tints, strengths).
      .replace(/\$\{[^}]*\}/g, isGlobal ? '' : '1.0');
    patches.push({ target: m[1], glsl });
  }
  return patches;
}

/** Hooks whose payload is a top-level (global) block rather than statements in main(). */
const GLOBAL_TARGETS = new Set(['#include <common>']);

/**
 * three.js built-ins and varyings the injected blocks legitimately reference. Declaring them
 * keeps the parser honest without silencing a real syntax error.
 */
const MAIN_PREAMBLE = `
  precision highp float;
  uniform float uTime;
  uniform float uWindSpeed;
  uniform float uCloudCoverage;
  uniform vec3 uSunDir;
  uniform vec3 uMistColor;
  uniform float uMistDensity;
  uniform vec2 uCloudOffset;
  uniform vec2 uWindDir;
  uniform vec3 uBallPos;
  uniform sampler2D map;
  uniform mat4 viewMatrix;
  uniform mat4 modelMatrix;
  uniform mat4 instanceMatrix;
  uniform vec3 cameraPosition;
  attribute vec3 position;
  attribute vec3 normal;
  attribute vec2 uv;
  attribute float aSwayAmp;
  attribute vec3 color;
  varying vec3 vBladeWorld;
  varying vec3 vBladeNormal;
  varying float vBladeTip;
  varying vec3 vCanopyWorld;
  varying vec3 vCanopyNormal;
  varying vec2 vLeafUv;
  varying vec2 vUv;
  varying vec2 vHeadUv;
  varying vec3 vHeadLocalPos;
  varying float vShoeBindY;
  varying vec2 vShoeUv;
  varying float vGloveMask;
  varying vec3 vTerrainWorldPos;
  varying vec3 vTerrainWorldNormal;
  varying float vTerrainAO;
  bool USE_NORMALMAP_TANGENTSPACE = true;
  bool USE_CLEARCOAT = true;
  mat3 tbn = mat3(1.0);
  vec3 normal = vec3(0.0, 0.0, 1.0);
  vec3 transformed = vec3(0.0);
  vec3 objectNormal = vec3(0.0, 0.0, 1.0);
  vec4 worldPosition = vec4(0.0);
  vec4 mvPosition = vec4(0.0);
  vec3 geometryNormal = normal;
  vec3 geometryViewDir = vec3(0.0, 0.0, 1.0);
  vec4 diffuseColor = vec4(1.0);
  float roughnessFactor = 0.5;
  uniform sampler2D uDermalNorm;
  uniform sampler2D uLeatherNorm;
  vec3 reflectedLightDirectDiffuse = vec3(0.0);
  vec3 reflectedLightDirectSpecular = vec3(0.0);
  vec3 reflectedLightIndirectDiffuse = vec3(0.0);
  vec3 reflectedLightIndirectSpecular = vec3(0.0);
  float clearcoatOut = 0.0;
  float clearcoatRoughnessOut = 0.0;
`;

function parsePatch(label: string, target: string, glsl: string): void {
  // Strip the host-shader placeholders the block carries through verbatim.
  const body = glsl.replace(/^[ \t]*#include +<[^>]+>[ \t]*$/gm, '');
  if (!body.trim()) return;
  const source = GLOBAL_TARGETS.has(target)
    ? `precision highp float;\n${body}\n`
    : `${MAIN_PREAMBLE}\nvoid main() {\n${body}\n}\n`;
  try {
    parser.parse(source);
  } catch (err) {
    throw new Error(
      `GLSL parse failed for ${label} (${target}):\n${(err as Error).message}\n` +
        `--- block ---\n${body}`
    );
  }
}

function validateFile(file: string, label: string, minPatches: number): Patch[] {
  const patches = extractPatches(read(file));
  expect(patches.length).toBeGreaterThanOrEqual(minPatches);
  for (const p of patches) parsePatch(label, p.target, p.glsl);
  return patches;
}

describe('injected GLSL patches', () => {
  it('terrain shader (TerrainMesh) parses', () => {
    const patches = validateFile('TerrainMesh.ts', 'terrain', 7);
    const targets = patches.map((p) => p.target);
    for (const required of [
      '#include <worldpos_vertex>',
      '#include <map_fragment>',
      '#include <roughnessmap_fragment>',
      '#include <normal_fragment_maps>',
      '#include <lights_fragment_end>',
      '#include <fog_fragment>',
    ]) {
      expect(targets).toContain(required);
    }
    // The atlas helpers are cheap to get wrong (textureLod needs GLSL 3.00 semantics, and
    // the mip clamp is what keeps quadrants from bleeding) — keep them pinned.
    const all = patches.map((p) => p.glsl).join('\n');
    expect(all).toContain('tPhotoAlbedoOctave');
    expect(all).toContain('min(lod, 4.0)');
    expect(all).toContain('vTerrainWorldPos');
  });

  it('expensive detail fetches are behind real branches, not mix() operands', () => {
    // mix()/step() evaluate both operands, so a distance LOD expressed as a mix still issues
    // the texture fetch it was meant to skip. This caught a real regression where the far
    // photographic normal octave was "disabled" at distance but still sampled every pixel.
    const source = read('TerrainMesh.ts');
    const mixWithFetch = /mix\(\s*\n?\s*tPhoto(Sample|AlbedoOctave)\([\s\S]{0,240}?,[\s\S]{0,60}?,\s*[a-zA-Z]*(LOD|Far|far)/g;
    expect(source.match(mixWithFetch)).toBeNull();

    // And the per-vertex/per-pixel LOD factors must actually exist and gate work.
    expect(source).toContain('if (nearMicro > 0.01)');
    expect(source).toContain('if (nNear > 0.01)');
    expect(source).toContain('if (nDetailLOD < 0.995)');
    expect(source).toContain('detailLOD < 0.98');
    expect(source).toContain('rCamDist < 150.0');
  });

  it('foliage canopy + bark shaders (FoliageSystem) parses', () => {
    const patches = validateFile('FoliageSystem.ts', 'foliage', 8);
    const all = patches.map((p) => p.glsl).join('\n');
    expect(all).toContain('aSwayAmp');
    // Canopy relief derivation (lTexel/lC/lX/lY) is the block most likely to drift
    expect(all).toContain('lTexel');
  });

  it('golfer rig shader patches (SkinnedGolferRig) parses', () => {
    const patches = validateFile('SkinnedGolferRig.ts', 'golfer rig', 8);
    const all = patches.map((p) => p.glsl).join('\n');
    expect(all).toContain('uDermalNorm');
    expect(all).toContain('poreAmp');
  });
});
