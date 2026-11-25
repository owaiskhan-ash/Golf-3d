// Deterministic 2D/3D Gradient Noise, FBM, and Spline Geometry Utilities

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function hash2(ix: number, iz: number, seed = 1337): number {
  let n = ix * 374761393 + iz * 668265263 + seed * 1442695041;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}

export function valueNoise2D(x: number, z: number, seed = 1337): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);

  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);

  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz) * 2 - 1;
}

export function fbm2D(
  x: number,
  z: number,
  octaves = 4,
  lacunarity = 2.03,
  gain = 0.5,
  seed = 1337
): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2D(x * freq, z * freq, seed + i * 97);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function ridgedFbm2D(
  x: number,
  z: number,
  octaves = 4,
  seed = 4242
): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2D(x * freq, z * freq, seed + i * 131));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

export interface Point2D {
  x: number;
  z: number;
}

export interface SplineSample {
  dist: number;
  t: number; // 0..1 along entire spline
  closestX: number;
  closestZ: number;
  widthAtT: number;
}

/**
 * Computes minimum distance from point (x, z) to a polyline with per-vertex half-widths.
 */
export function distanceToPolyline(
  x: number,
  z: number,
  points: Array<{ x: number; z: number; halfWidth: number }>
): SplineSample {
  let bestDistSq = Infinity;
  let bestT = 0;
  let bestX = points[0].x;
  let bestZ = points[0].z;
  let bestWidth = points[0].halfWidth;

  const segCount = points.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz || 1e-6;
    const localT = clamp(((x - a.x) * dx + (z - a.z) * dz) / lenSq, 0, 1);
    const px = a.x + dx * localT;
    const pz = a.z + dz * localT;
    const dSq = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestT = (i + localT) / segCount;
      bestX = px;
      bestZ = pz;
      bestWidth = lerp(a.halfWidth, b.halfWidth, localT);
    }
  }

  return {
    dist: Math.sqrt(bestDistSq),
    t: bestT,
    closestX: bestX,
    closestZ: bestZ,
    widthAtT: bestWidth,
  };
}

/**
 * Distance to a rotated ellipse/organic shape (positive outside, negative inside).
 */
export function signedDistOrganicEllipse(
  x: number,
  z: number,
  cx: number,
  cz: number,
  rx: number,
  rz: number,
  rotRad: number,
  lobeAmp = 0.08,
  lobeSeed = 7
): number {
  const dx = x - cx;
  const dz = z - cz;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const lx = dx * cosR + dz * sinR;
  const lz = -dx * sinR + dz * cosR;

  const angle = Math.atan2(lz, lx);
  const wobble =
    1 +
    lobeAmp * Math.sin(angle * 2 + lobeSeed) +
    lobeAmp * 0.65 * Math.cos(angle * 3 - lobeSeed * 1.7);

  const nx = lx / (rx * wobble);
  const nz = lz / (rz * wobble);
  const rNorm = Math.hypot(nx, nz);
  return (rNorm - 1) * Math.min(rx, rz);
}
