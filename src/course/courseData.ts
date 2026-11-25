import { clamp, fbm2D, lerp, ridgedFbm2D, smoothstep } from './noise';
import type { CoastalTreeDef, HoleDefinition, SeaRockDef } from './types';

function seededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967295;
  };
}

function generateTreesOutsideCorridor(
  count: number,
  seed: number,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  validator: (x: number, z: number) => boolean,
  windDirRad: number
): CoastalTreeDef[] {
  const rng = seededRand(seed);
  const trees: CoastalTreeDef[] = [];
  let attempts = 0;
  while (trees.length < count && attempts < count * 28) {
    attempts++;
    const x = lerp(bounds.minX + 18, bounds.maxX - 18, rng());
    const z = lerp(bounds.minZ + 20, bounds.maxZ - 16, rng());
    if (!validator(x, z)) continue;

    const scale = 0.66 + Math.pow(rng(), 0.92) * 0.80;
    const minDist = scale < 0.9 ? 8.8 : 11.2;
    const tooClose = trees.some((t) => Math.hypot(t.x - x, t.z - z) < minDist);
    if (tooClose) continue;

    trees.push({
      x,
      z,
      scale,
      windBendRad: windDirRad + (rng() - 0.5) * 0.34,
      seed: Math.floor(rng() * 100000),
      species: rng() > 0.36 ? 'cypress' : 'pine',
    });
  }
  return trees;
}

function generateCoastalRocks(
  coastFn: (x: number, z: number) => number,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  count: number,
  seed: number
): SeaRockDef[] {
  const rng = seededRand(seed);
  const rocks: SeaRockDef[] = [];
  let attempts = 0;
  while (rocks.length < count && attempts < count * 35) {
    attempts++;
    const x = lerp(bounds.minX + 12, bounds.maxX - 12, rng());
    const z = lerp(bounds.minZ + 12, bounds.maxZ - 12, rng());
    const d = coastFn(x, z);
    // Place jagged rocks right along the cliff base and just offshore in surf (-24m .. +1.5m)
    if (d < -26 || d > 1.5) continue;
    const tooClose = rocks.some((r) => Math.hypot(r.x - x, r.z - z) < r.radius + 4.5);
    if (tooClose) continue;
    rocks.push({
      x,
      z,
      radius: 2.2 + rng() * 5.2,
      height: d > -4 ? 2.8 + rng() * 5.5 : 1.4 + rng() * 3.8,
      seed: Math.floor(rng() * 100000),
    });
  }
  return rocks;
}

// ============================================================================
// HOLE 1: "CYPRESS BLUFF" (Par 4, 418 Yards) — Inspired by Pebble Beach #8
// ============================================================================
const hole1Coast = (x: number, z: number): number => {
  // Coastline runs along the RIGHT (+X) side of the hole, carving a dramatic chasm cove between z = -230 and -310!
  const coveInlet = 38 * Math.exp(-Math.pow((z + 266) / 36, 2));
  const headlandCurve = 0.14 * Math.max(0, -z - 160);
  const roughCoastX = 30 + headlandCurve - coveInlet + 8 * fbm2D(x * 0.02, z * 0.02, 3, 2.0, 0.5, 101);
  // Also cliff edges behind the green (z < -412) and behind tee (z > 42)
  const dRight = roughCoastX - x;
  const dBack = z - (-415 + 6 * Math.sin(x * 0.04));
  const dSouth = 48 - z;
  // Special green peninsula jutting out at (48, -365)
  const greenPeninsulaDist = 36 - Math.hypot(x - 44, z + 365);
  return Math.max(Math.min(dRight, dBack, dSouth), Math.min(greenPeninsulaDist, dBack));
};

const hole1BaseElev = (x: number, z: number): number => {
  // Climbs steadily from tee (19m) up to clifftop bluff (26m), dips slightly at chasm rim, then 23.5m green plateau
  const t = clamp(-z / 380, 0, 1);
  const climb = 19.0 + 7.5 * smoothstep(0.05, 0.55, t) - 2.4 * smoothstep(0.65, 0.95, t);
  const dunes = 1.6 * fbm2D(x * 0.022, z * 0.022, 3, 2.1, 0.5, 12);
  const inlandHill = smoothstep(-25, -95, x) * 9.5 * (0.6 + 0.4 * ridgedFbm2D(x * 0.015, z * 0.015, 3, 44));
  return climb + dunes + inlandHill;
};

const HOLE_1: HoleDefinition = {
  id: 'hole-1',
  holeNumber: 1,
  name: 'Cypress Bluff',
  subtitle: 'Par 4 · 418 Yards · Cliffside Dogleg & Cove Approach',
  par: 4,
  yardage: 418,
  bounds: { minX: -125, maxX: 145, minZ: -455, maxZ: 65 },
  defaultWindSpeedMph: 11,
  defaultWindDirRad: -Math.PI * 0.35, // Breezing inland from right ocean cove
  tee: {
    cx: 0,
    cz: 0,
    halfW: 5.5,
    halfL: 8.0,
    yawRad: 0.04,
    elevation: 19.4,
  },
  fairwaySplines: [
    [
      { x: 0, z: -38, halfWidth: 13.5, elevation: 19.2 },
      { x: -3, z: -105, halfWidth: 16.0, elevation: 21.6 },
      { x: -2, z: -175, halfWidth: 17.5, elevation: 24.4 },
      { x: 6, z: -225, halfWidth: 16.0, elevation: 25.6 },
    ],
    // Approach apron across the cove onto green peninsula
    [
      { x: 35, z: -326, halfWidth: 12.5, elevation: 23.2 },
      { x: 42, z: -348, halfWidth: 14.0, elevation: 23.5 },
    ],
  ],
  roughCorridorHalfWidthExtra: 11.5,
  bunkers: [
    // Left fairway bunker guarding aggressive driver line
    { cx: -21, cz: -206, rx: 6.2, rz: 10.5, rotRad: 0.15, depth: 1.15, lipHeight: 0.55, lipDirRad: 0.25, lobeSeed: 3 },
    // Right cliffside warning bunker short of the cove
    { cx: 19, cz: -218, rx: 5.2, rz: 7.5, rotRad: -0.2, depth: 1.05, lipHeight: 0.45, lipDirRad: 0.1, lobeSeed: 9 },
    // Front-left deep greenside bunker
    { cx: 24, cz: -355, rx: 5.8, rz: 8.0, rotRad: 0.35, depth: 1.35, lipHeight: 0.72, lipDirRad: 0.4, lobeSeed: 14 },
    // Front-right guarding chasm edge
    { cx: 56, cz: -348, rx: 5.2, rz: 6.4, rotRad: -0.3, depth: 1.25, lipHeight: 0.65, lipDirRad: -0.35, lobeSeed: 21 },
    // Rear bailout catcher bunker
    { cx: 38, cz: -391, rx: 7.5, rz: 4.5, rotRad: 0.12, depth: 1.15, lipHeight: 0.55, lipDirRad: Math.PI, lobeSeed: 29 },
  ],
  green: {
    cx: 41,
    cz: -370,
    rx: 13.5,
    rz: 16.5,
    rotRad: 0.22,
    lobeAmp: 0.11,
    lobeSeed: 5,
    baseElevation: 23.8,
    tiltX: -0.012,  // Gently falls left away from cliffs
    tiltZ: 0.015,   // Soft coastal back-to-front slope
    ridgeAmp: 0.14,
    ridgeFreq: 0.14,
    cupOffsetX: 2.0,
    cupOffsetZ: -1.8,
    stimpFeet: 9.2,
  },
  cartPath: [
    { x: -34, z: 10, halfWidth: 1.6 },
    { x: -42, z: -120, halfWidth: 1.6 },
    { x: -24, z: -245, halfWidth: 1.6 },
    { x: 8, z: -345, halfWidth: 1.6 },
    { x: 16, z: -395, halfWidth: 1.6 },
  ],
  coastlineSignedDist: hole1Coast,
  baseLandElevation: hole1BaseElev,
  trees: generateTreesOutsideCorridor(
    34,
    8001,
    { minX: -115, maxX: 60, minZ: -415, maxZ: 40 },
    (x, z) => {
      const coast = hole1Coast(x, z);
      if (coast < 12) return false;
      // Keep playable fairway/green/tee corridor wide open
      if (x > -28 && x < 72 && z < 20 && z > -405) return false;
      if (z < -230 && z > -355 && x > -15) return false;
      return true;
    },
    -Math.PI * 0.35
  ),
  seaRocks: generateCoastalRocks(hole1Coast, { minX: -60, maxX: 135, minZ: -445, maxZ: 45 }, 32, 9101),
  cameraPreviewTarget: { x: 24, y: 24, z: -260 },
};

// ============================================================================
// HOLE 2: "CARMEL POINT" (Par 3, 114 Yards) — Inspired by Pebble Beach #7
// ============================================================================
const hole2Coast = (x: number, z: number): number => {
  // Tee sits on high bluff around (0, 0); a narrow rocky neck leads out to an ocean-surrounded peninsula green at (4, -104)!
  const teeBluff = 44 - Math.hypot(x * 0.72, z - 6);
  const peninsulaNeck = 22 - Math.abs(x - 2) + 8 * smoothstep(-35, -70, z) * smoothstep(-115, -75, z);
  const greenPeninsula = 31 - Math.hypot((x - 4) * 0.92, z + 104);
  const wobble = 4.2 * fbm2D(x * 0.035, z * 0.035, 3, 2.0, 0.5, 202);
  const raw = Math.max(teeBluff, Math.min(peninsulaNeck, z < -18 && z > -132 ? 99 : -99), greenPeninsula);
  return raw + wobble;
};

const hole2BaseElev = (x: number, z: number): number => {
  // Drops ~11 meters (36 ft) from cliffside tee down to windswept ocean green!
  const drop = smoothstep(4, -84, z);
  const elev = lerp(26.2, 14.8, drop);
  const micro = 0.9 * fbm2D(x * 0.04, z * 0.04, 3, 2.0, 0.5, 77);
  return elev + micro;
};

const HOLE_2: HoleDefinition = {
  id: 'hole-2',
  holeNumber: 2,
  name: 'Carmel Point',
  subtitle: 'Par 3 · 114 Yards · Downhill Ocean Peninsula',
  par: 3,
  yardage: 114,
  bounds: { minX: -95, maxX: 105, minZ: -175, maxZ: 55 },
  defaultWindSpeedMph: 14,
  defaultWindDirRad: Math.PI * 0.68, // Swirling right-to-left & slightly into player off Pacific surf
  tee: {
    cx: 0,
    cz: 0,
    halfW: 5.5,
    halfL: 7.0,
    yawRad: 0.038,
    elevation: 26.2,
  },
  fairwaySplines: [
    // Short mowed neck leading onto the green apron
    [
      { x: 2, z: -64, halfWidth: 7.5, elevation: 16.0 },
      { x: 3.5, z: -84, halfWidth: 9.0, elevation: 15.0 },
    ],
  ],
  roughCorridorHalfWidthExtra: 9.0,
  bunkers: [
    // Iconic Pebble #7 horseshoe bunker ring!
    { cx: -11.5, cz: -95, rx: 4.4, rz: 6.2, rotRad: 0.3, depth: 1.15, lipHeight: 0.55, lipDirRad: 0.4, lobeSeed: 11 },
    { cx: 16.5, cz: -97, rx: 4.5, rz: 5.8, rotRad: -0.25, depth: 1.15, lipHeight: 0.55, lipDirRad: -0.4, lobeSeed: 17 },
    { cx: -12.0, cz: -112, rx: 4.8, rz: 5.4, rotRad: -0.35, depth: 1.25, lipHeight: 0.62, lipDirRad: 1.1, lobeSeed: 23 },
    { cx: 15.5, cz: -114, rx: 4.6, rz: 5.2, rotRad: 0.4, depth: 1.20, lipHeight: 0.60, lipDirRad: -1.1, lobeSeed: 31 },
    { cx: 4.0, cz: -123, rx: 6.5, rz: 3.8, rotRad: 0.05, depth: 1.20, lipHeight: 0.65, lipDirRad: Math.PI, lobeSeed: 37 },
  ],
  green: {
    cx: 4,
    cz: -104,
    rx: 10.5,
    rz: 13.0,
    rotRad: -0.08,
    lobeAmp: 0.14, // Distinctive hourglass waist
    lobeSeed: 19,
    baseElevation: 15.1,
    tiltX: 0.011,
    tiltZ: 0.014, // Subtle back-to-front pitch facing the tee
    ridgeAmp: 0.12,
    ridgeFreq: 0.16,
    cupOffsetX: -1.4,
    cupOffsetZ: -1.5,
    stimpFeet: 9.2,
  },
  coastlineSignedDist: hole2Coast,
  baseLandElevation: hole2BaseElev,
  trees: generateTreesOutsideCorridor(
    10,
    7007,
    { minX: -55, maxX: 55, minZ: -35, maxZ: 45 },
    (x, z) => {
      const coast = hole2Coast(x, z);
      if (coast < 10) return false;
      if (z < 12 && Math.abs(x) < 16) return false;
      return true;
    },
    Math.PI * 0.68
  ),
  seaRocks: generateCoastalRocks(hole2Coast, { minX: -90, maxX: 95, minZ: -165, maxZ: 40 }, 36, 7202),
  cameraPreviewTarget: { x: 3, y: 16, z: -96 },
};

// ============================================================================
// HOLE 3: "OCEAN'S EDGE" (Par 5, 542 Yards) — Inspired by Pebble Beach #18
// ============================================================================
const hole3Coast = (x: number, z: number): number => {
  // Crashing Pacific surf runs along the ENTIRE LEFT (-X) side, curving left around the bay!
  const bayBendX = -24 - 68 * smoothstep(-100, -485, z);
  const wobble = 4.2 * fbm2D(x * 0.02, z * 0.02, 3, 2.0, 0.5, 303);
  const dLeft = x - (bayBendX + wobble);
  const dNorth = z - (-535 + 8 * Math.sin(x * 0.03));
  const dSouth = 48 - z;
  return Math.min(dLeft, dNorth, dSouth);
};

const hole3BaseElev = (x: number, z: number): number => {
  const t = clamp(-z / 500, 0, 1);
  // Coastal shelf rises slightly at the amphitheater finishing green (16.5m -> 19.8m)
  const gentleRise = 16.5 + 2.8 * smoothstep(0.55, 0.96, t);
  const dunes = 1.4 * fbm2D(x * 0.02, z * 0.02, 3, 2.0, 0.5, 55);
  const inlandSlope = smoothstep(26, 95, x) * 8.0;
  return gentleRise + dunes + inlandSlope;
};

const HOLE_3: HoleDefinition = {
  id: 'hole-3',
  holeNumber: 3,
  name: "Ocean's Edge",
  subtitle: 'Par 5 · 542 Yards · Iconic Sweeping Coastal Finisher',
  par: 5,
  yardage: 542,
  bounds: { minX: -145, maxX: 125, minZ: -565, maxZ: 60 },
  defaultWindSpeedMph: 12,
  defaultWindDirRad: Math.PI * 0.42, // Quartering off the Pacific surf left-to-right!
  tee: {
    cx: 4,
    cz: 0,
    halfW: 6.0,
    halfL: 8.5,
    yawRad: -0.05,
    elevation: 17.0,
  },
  fairwaySplines: [
    [
      { x: 2, z: -48, halfWidth: 14.5, elevation: 16.6 },
      { x: -4, z: -140, halfWidth: 17.5, elevation: 16.8 },
      { x: -16, z: -245, halfWidth: 19.0, elevation: 17.1 },
      { x: -32, z: -348, halfWidth: 17.5, elevation: 17.6 },
      { x: -49, z: -435, halfWidth: 15.5, elevation: 18.4 },
      { x: -57, z: -468, halfWidth: 13.5, elevation: 18.9 },
    ],
  ],
  roughCorridorHalfWidthExtra: 12.0,
  bunkers: [
    // Classic split-fairway landing bunkers on right & left
    { cx: -28, cz: -232, rx: 5.0, rz: 10.5, rotRad: -0.18, depth: 1.15, lipHeight: 0.45, lipDirRad: -0.15, lobeSeed: 41 },
    { cx: 11, cz: -265, rx: 6.0, rz: 11.5, rotRad: -0.22, depth: 1.25, lipHeight: 0.55, lipDirRad: -0.2, lobeSeed: 43 },
    // Layup-zone right bunker
    { cx: -14, cz: -380, rx: 5.5, rz: 9.0, rotRad: -0.25, depth: 1.20, lipHeight: 0.50, lipDirRad: -0.2, lobeSeed: 47 },
    // Famous long front-left greenside bunker beside seawall
    { cx: -75, cz: -465, rx: 5.2, rz: 12.5, rotRad: -0.32, depth: 1.35, lipHeight: 0.65, lipDirRad: -0.3, lobeSeed: 53 },
    // Right amphitheater bunker guarding pin right
    { cx: -43, cz: -486, rx: 5.2, rz: 7.4, rotRad: -0.15, depth: 1.20, lipHeight: 0.60, lipDirRad: -0.4, lobeSeed: 59 },
  ],
  green: {
    cx: -62,
    cz: -488,
    rx: 13.0,
    rz: 17.0,
    rotRad: -0.26,
    lobeAmp: 0.09,
    lobeSeed: 61,
    baseElevation: 19.3,
    tiltX: 0.011,  // Slopes subtly toward the ocean on the left (-X)
    tiltZ: 0.015,  // Gentle back-to-front slope
    ridgeAmp: 0.13,
    ridgeFreq: 0.14,
    cupOffsetX: -1.8,
    cupOffsetZ: 1.2,
    stimpFeet: 9.2,
  },
  cartPath: [
    { x: 28, z: 12, halfWidth: 1.6 },
    { x: 24, z: -150, halfWidth: 1.6 },
    { x: 20, z: -290, halfWidth: 1.6 },
    { x: -12, z: -430, halfWidth: 1.6 },
    { x: -34, z: -512, halfWidth: 1.6 },
  ],
  seawallSegments: [
    { x1: -50, z1: -360, x2: -62, z2: -415, topElevation: 18.2 },
    { x1: -62, z1: -415, x2: -80, z2: -475, topElevation: 19.0 },
    { x1: -80, z1: -475, x2: -86, z2: -512, topElevation: 19.5 },
  ],
  coastlineSignedDist: hole3Coast,
  baseLandElevation: hole3BaseElev,
  trees: [
    // Iconic Monterey Cypress tree guarding the inside corner / right rough like Pebble #18!
    { x: -10, z: -205, scale: 1.32, windBendRad: Math.PI * 0.42, seed: 1801, species: 'cypress' },
    { x: -46, z: -395, scale: 1.22, windBendRad: Math.PI * 0.42, seed: 1802, species: 'cypress' },
    ...generateTreesOutsideCorridor(
      36,
      1800,
      { minX: -90, maxX: 115, minZ: -535, maxZ: 45 },
      (x, z) => {
        const coast = hole3Coast(x, z);
        if (coast < 16) return false;
        // Keep main fairway corridor open
        const approxCenter = -0.13 * Math.max(0, -z - 40);
        if (Math.abs(x - approxCenter) < 32 && z < 20 && z > -515) return false;
        return true;
      },
      Math.PI * 0.42
    ),
  ],
  seaRocks: generateCoastalRocks(hole3Coast, { minX: -140, maxX: 40, minZ: -555, maxZ: 45 }, 38, 1899),
  cameraPreviewTarget: { x: -34, y: 20, z: -320 },
};

// ============================================================================
// HOLE 4: "SPANISH BAY SANDS" (Par 4, 386 Yards) — Split-Dune Coastal Link
// ============================================================================
const hole4Coast = (x: number, z: number): number => {
  const bayCurve = 36 + 18 * Math.sin(z * 0.015) + 6 * fbm2D(x * 0.02, z * 0.02, 3, 2.0, 0.5, 411);
  const dRight = bayCurve - x;
  const dNorth = z - (-395 + 6 * Math.sin(x * 0.04));
  const dSouth = 45 - z;
  return Math.min(dRight, dNorth, dSouth);
};

const hole4BaseElev = (x: number, z: number): number => {
  const t = clamp(-z / 355, 0, 1);
  const dunes = 2.2 * ridgedFbm2D(x * 0.025, z * 0.025, 3, 414);
  const rise = 14.5 + 3.8 * smoothstep(0.35, 0.9, t);
  const inlandDune = smoothstep(-28, -90, x) * 7.5;
  return rise + dunes + inlandDune;
};

const HOLE_4: HoleDefinition = {
  id: 'hole-4',
  holeNumber: 4,
  name: 'Spanish Bay Sands',
  subtitle: 'Par 4 · 386 Yards · Sand-Dune Fairway & Punchbowl Green',
  par: 4,
  yardage: 386,
  bounds: { minX: -115, maxX: 115, minZ: -425, maxZ: 60 },
  defaultWindSpeedMph: 10,
  defaultWindDirRad: -Math.PI * 0.55,
  tee: { cx: -4, cz: 0, halfW: 5.5, halfL: 8.0, yawRad: 0.03, elevation: 15.0 },
  fairwaySplines: [
    [
      { x: -2, z: -45, halfWidth: 14.0, elevation: 14.8 },
      { x: 4, z: -135, halfWidth: 17.5, elevation: 15.2 },
      { x: 10, z: -225, halfWidth: 16.5, elevation: 16.2 },
      { x: 6, z: -315, halfWidth: 14.0, elevation: 17.6 },
    ],
  ],
  roughCorridorHalfWidthExtra: 12.0,
  bunkers: [
    { cx: -16, cz: -178, rx: 6.5, rz: 13.0, rotRad: 0.12, depth: 1.25, lipHeight: 0.55, lipDirRad: 0.2, lobeSeed: 101 },
    { cx: 23, cz: -210, rx: 5.5, rz: 11.0, rotRad: -0.18, depth: 1.15, lipHeight: 0.50, lipDirRad: 0.1, lobeSeed: 103 },
    { cx: -11, cz: -332, rx: 5.2, rz: 7.5, rotRad: 0.28, depth: 1.25, lipHeight: 0.60, lipDirRad: 0.35, lobeSeed: 107 },
    { cx: 20, cz: -346, rx: 5.0, rz: 6.8, rotRad: -0.25, depth: 1.20, lipHeight: 0.58, lipDirRad: -0.25, lobeSeed: 109 },
  ],
  green: {
    cx: 5,
    cz: -350,
    rx: 13.0,
    rz: 14.5,
    rotRad: 0.1,
    lobeAmp: 0.08,
    lobeSeed: 113,
    baseElevation: 18.2,
    tiltX: -0.008,
    tiltZ: 0.013,
    ridgeAmp: 0.14,
    ridgeFreq: 0.15,
    cupOffsetX: 1.6,
    cupOffsetZ: -1.4,
    sundayCupOffsetX: -4.2,
    sundayCupOffsetZ: -4.8,
    stimpFeet: 9.2,
  },
  coastlineSignedDist: hole4Coast,
  baseLandElevation: hole4BaseElev,
  trees: generateTreesOutsideCorridor(
    24,
    4100,
    { minX: -105, maxX: 48, minZ: -385, maxZ: 40 },
    (x, z) => {
      if (hole4Coast(x, z) < 13) return false;
      if (x > -24 && x < 34 && z < 16 && z > -380) return false;
      return true;
    },
    -Math.PI * 0.55
  ),
  seaRocks: generateCoastalRocks(hole4Coast, { minX: -40, maxX: 105, minZ: -415, maxZ: 40 }, 28, 4200),
  cameraPreviewTarget: { x: 6, y: 17, z: -245 },
};

// ============================================================================
// HOLE 5: "STILLWATER COVE" (Par 3, 178 Yards) — Ocean Inlet Mid-Iron
// ============================================================================
const hole5Coast = (x: number, z: number): number => {
  const teeCap = 40 - Math.hypot(x * 0.78, z - 4);
  const greenIsland = 36 - Math.hypot((x - 10) * 0.88, z + 162);
  const leftBridge = 22 - Math.abs(x + 28) + 8 * smoothstep(-40, -135, z);
  const wobble = 3.8 * fbm2D(x * 0.03, z * 0.03, 3, 2.0, 0.5, 512);
  return Math.max(teeCap, greenIsland, Math.min(leftBridge, z < 10 && z > -185 ? 99 : -99)) + wobble;
};

const hole5BaseElev = (x: number, z: number): number => {
  const t = clamp(-z / 165, 0, 1);
  return 21.0 - 4.2 * smoothstep(0.1, 0.85, t) + 1.1 * fbm2D(x * 0.028, z * 0.028, 3, 2.0, 0.5, 515);
};

const HOLE_5: HoleDefinition = {
  id: 'hole-5',
  holeNumber: 5,
  name: 'Stillwater Cove',
  subtitle: 'Par 3 · 178 Yards · Forced Carry Across Turquoise Inlet',
  par: 3,
  yardage: 178,
  bounds: { minX: -95, maxX: 105, minZ: -225, maxZ: 55 },
  defaultWindSpeedMph: 11,
  defaultWindDirRad: -Math.PI * 0.25,
  tee: { cx: 0, cz: 0, halfW: 6.0, halfL: 7.5, yawRad: 0.06, elevation: 21.0 },
  fairwaySplines: [
    [
      { x: -12, z: -130, halfWidth: 10.5, elevation: 16.8 },
      { x: 4, z: -145, halfWidth: 11.5, elevation: 16.8 },
    ],
  ],
  roughCorridorHalfWidthExtra: 9.0,
  bunkers: [
    { cx: -7, cz: -158, rx: 5.0, rz: 7.8, rotRad: 0.25, depth: 1.25, lipHeight: 0.62, lipDirRad: 0.3, lobeSeed: 501 },
    { cx: 25, cz: -164, rx: 4.8, rz: 6.5, rotRad: -0.2, depth: 1.18, lipHeight: 0.55, lipDirRad: -0.2, lobeSeed: 503 },
    { cx: 11, cz: -183, rx: 7.0, rz: 4.2, rotRad: 0.08, depth: 1.20, lipHeight: 0.58, lipDirRad: Math.PI, lobeSeed: 509 },
  ],
  green: {
    cx: 10,
    cz: -162,
    rx: 13.5,
    rz: 12.5,
    rotRad: 0.12,
    lobeAmp: 0.1,
    lobeSeed: 521,
    baseElevation: 17.0,
    tiltX: -0.011,
    tiltZ: 0.014,
    ridgeAmp: 0.12,
    ridgeFreq: 0.16,
    cupOffsetX: 1.5,
    cupOffsetZ: -1.0,
    sundayCupOffsetX: -4.8,
    sundayCupOffsetZ: 3.4,
    stimpFeet: 9.2,
  },
  coastlineSignedDist: hole5Coast,
  baseLandElevation: hole5BaseElev,
  trees: generateTreesOutsideCorridor(
    14,
    5100,
    { minX: -75, maxX: 55, minZ: -195, maxZ: 40 },
    (x, z) => {
      if (hole5Coast(x, z) < 11) return false;
      if (x > -18 && x < 28 && z < 12 && z > -188) return false;
      return true;
    },
    -Math.PI * 0.25
  ),
  seaRocks: generateCoastalRocks(hole5Coast, { minX: -85, maxX: 95, minZ: -215, maxZ: 40 }, 34, 5200),
  cameraPreviewTarget: { x: 8, y: 18, z: -145 },
};

// ============================================================================
// HOLE 6: "MONTEREY RIDGE" (Par 5, 568 Yards) — Double-Dogleg Headland Climb
// ============================================================================
const hole6Coast = (x: number, z: number): number => {
  const cliffX = -32 + 24 * smoothstep(-120, -340, z) - 34 * smoothstep(-340, -520, z);
  const wobble = 5.5 * fbm2D(x * 0.02, z * 0.02, 3, 2.0, 0.5, 611);
  const dLeft = x - (cliffX + wobble);
  const dNorth = z - (-565 + 7 * Math.sin(x * 0.03));
  const dSouth = 48 - z;
  return Math.min(dLeft, dNorth, dSouth);
};

const hole6BaseElev = (x: number, z: number): number => {
  const t = clamp(-z / 520, 0, 1);
  const climb = 16.0 + 13.5 * smoothstep(0.15, 0.88, t);
  const ridge = 1.6 * fbm2D(x * 0.02, z * 0.02, 3, 2.0, 0.5, 616);
  const inland = smoothstep(32, 95, x) * 9.0;
  return climb + ridge + inland;
};

const HOLE_6: HoleDefinition = {
  id: 'hole-6',
  holeNumber: 6,
  name: 'Monterey Ridge',
  subtitle: 'Par 5 · 568 Yards · Sweeping Uphill Ridge & Perched Green',
  par: 5,
  yardage: 568,
  bounds: { minX: -145, maxX: 135, minZ: -595, maxZ: 60 },
  defaultWindSpeedMph: 10,
  defaultWindDirRad: Math.PI * 0.22,
  tee: { cx: 0, cz: 0, halfW: 6.0, halfL: 8.5, yawRad: 0.04, elevation: 16.4 },
  fairwaySplines: [
    [
      { x: 4, z: -50, halfWidth: 14.5, elevation: 16.5 },
      { x: 16, z: -155, halfWidth: 17.5, elevation: 18.8 },
      { x: 22, z: -265, halfWidth: 18.0, elevation: 22.4 },
      { x: 8, z: -380, halfWidth: 16.5, elevation: 26.2 },
      { x: -16, z: -480, halfWidth: 14.5, elevation: 28.8 },
    ],
  ],
  roughCorridorHalfWidthExtra: 12.5,
  bunkers: [
    { cx: -6, cz: -235, rx: 5.5, rz: 10.5, rotRad: 0.2, depth: 1.2, lipHeight: 0.55, lipDirRad: 0.1, lobeSeed: 601 },
    { cx: 36, cz: -280, rx: 6.0, rz: 11.0, rotRad: -0.25, depth: 1.2, lipHeight: 0.55, lipDirRad: -0.2, lobeSeed: 607 },
    { cx: -32, cz: -492, rx: 5.6, rz: 8.8, rotRad: -0.28, depth: 1.35, lipHeight: 0.7, lipDirRad: -0.3, lobeSeed: 613 },
    { cx: 1, cz: -512, rx: 5.5, rz: 7.0, rotRad: 0.22, depth: 1.25, lipHeight: 0.62, lipDirRad: 0.25, lobeSeed: 619 },
  ],
  green: {
    cx: -20,
    cz: -515,
    rx: 13.5,
    rz: 16.0,
    rotRad: -0.22,
    lobeAmp: 0.09,
    lobeSeed: 631,
    baseElevation: 29.4,
    tiltX: 0.01,
    tiltZ: 0.015,
    ridgeAmp: 0.15,
    ridgeFreq: 0.14,
    cupOffsetX: 1.2,
    cupOffsetZ: -1.6,
    sundayCupOffsetX: -4.6,
    sundayCupOffsetZ: 4.0,
    stimpFeet: 9.2,
  },
  coastlineSignedDist: hole6Coast,
  baseLandElevation: hole6BaseElev,
  trees: generateTreesOutsideCorridor(
    36,
    6100,
    { minX: -95, maxX: 120, minZ: -560, maxZ: 45 },
    (x, z) => {
      if (hole6Coast(x, z) < 15) return false;
      const centerApprox = z > -265 ? 16 : 22 - 0.15 * (-z - 265);
      if (Math.abs(x - centerApprox) < 30 && z < 16 && z > -540) return false;
      return true;
    },
    Math.PI * 0.22
  ),
  seaRocks: generateCoastalRocks(hole6Coast, { minX: -135, maxX: 40, minZ: -585, maxZ: 40 }, 36, 6200),
  cameraPreviewTarget: { x: 4, y: 24, z: -340 },
};

// ============================================================================
// HOLE 7: "TIDEPOOL CROSSING" (Par 4, 344 Yards) — Risk-Reward Drivable Coastal 4
// ============================================================================
const hole7Coast = (x: number, z: number): number => {
  const coveCut = 34 * Math.exp(-Math.pow((z + 210) / 40, 2));
  const rightCoast = 28 - coveCut + 5 * fbm2D(x * 0.025, z * 0.025, 3, 2.0, 0.5, 701);
  const greenLobe = 32 - Math.hypot(x - 26, z + 306);
  const dNorth = z - (-355 + 5 * Math.sin(x * 0.04));
  const dSouth = 44 - z;
  return Math.max(Math.min(rightCoast - x, dNorth, dSouth), Math.min(greenLobe, dNorth));
};

const hole7BaseElev = (x: number, z: number): number => {
  const t = clamp(-z / 315, 0, 1);
  return 18.2 + 2.4 * Math.sin(t * Math.PI) + 1.2 * fbm2D(x * 0.024, z * 0.024, 3, 2.0, 0.5, 707);
};

const HOLE_7: HoleDefinition = {
  id: 'hole-7',
  holeNumber: 7,
  name: 'Tidepool Crossing',
  subtitle: 'Par 4 · 344 Yards · Drivable Peninsula Gamble Over Tidepools',
  par: 4,
  yardage: 344,
  bounds: { minX: -105, maxX: 115, minZ: -385, maxZ: 55 },
  defaultWindSpeedMph: 9,
  defaultWindDirRad: -Math.PI * 0.65,
  tee: { cx: -6, cz: 0, halfW: 5.5, halfL: 7.5, yawRad: 0.08, elevation: 18.4 },
  fairwaySplines: [
    [
      { x: -10, z: -55, halfWidth: 13.5, elevation: 18.6 },
      { x: -16, z: -155, halfWidth: 16.5, elevation: 19.4 },
      { x: -6, z: -240, halfWidth: 14.5, elevation: 19.2 },
      { x: 18, z: -285, halfWidth: 12.5, elevation: 18.6 },
    ],
  ],
  roughCorridorHalfWidthExtra: 11.0,
  bunkers: [
    { cx: 10, cz: -292, rx: 4.8, rz: 6.5, rotRad: 0.35, depth: 1.25, lipHeight: 0.65, lipDirRad: 0.4, lobeSeed: 709 },
    { cx: 40, cz: -302, rx: 4.8, rz: 6.0, rotRad: -0.3, depth: 1.20, lipHeight: 0.60, lipDirRad: -0.3, lobeSeed: 719 },
    { cx: 24, cz: -328, rx: 7.2, rz: 4.0, rotRad: 0.1, depth: 1.18, lipHeight: 0.55, lipDirRad: Math.PI, lobeSeed: 727 },
  ],
  green: {
    cx: 26,
    cz: -308,
    rx: 12.0,
    rz: 14.0,
    rotRad: 0.24,
    lobeAmp: 0.1,
    lobeSeed: 733,
    baseElevation: 18.5,
    tiltX: -0.01,
    tiltZ: 0.014,
    ridgeAmp: 0.12,
    ridgeFreq: 0.15,
    cupOffsetX: -1.4,
    cupOffsetZ: 1.2,
    sundayCupOffsetX: 4.0,
    sundayCupOffsetZ: -4.2,
    stimpFeet: 9.2,
  },
  coastlineSignedDist: hole7Coast,
  baseLandElevation: hole7BaseElev,
  trees: generateTreesOutsideCorridor(
    22,
    7100,
    { minX: -95, maxX: 55, minZ: -345, maxZ: 40 },
    (x, z) => {
      if (hole7Coast(x, z) < 12) return false;
      if (x > -34 && x < 42 && z < 16 && z > -332) return false;
      return true;
    },
    -Math.PI * 0.65
  ),
  seaRocks: generateCoastalRocks(hole7Coast, { minX: -40, maxX: 105, minZ: -375, maxZ: 40 }, 30, 7200),
  cameraPreviewTarget: { x: 8, y: 19, z: -220 },
};

// ============================================================================
// HOLE 8: "LIGHTHOUSE BLUFF" (Par 3, 212 Yards) — Long-Iron Headland Test
// ============================================================================
const hole8Coast = (x: number, z: number): number => {
  const bluff = 42 - Math.abs(x + 2 * Math.sin(z * 0.02)) + 5 * fbm2D(x * 0.025, z * 0.025, 3, 2.0, 0.5, 801);
  const head = 34 - Math.hypot((x - 4) * 0.9, z + 194);
  const dSouth = 44 - z;
  const dNorth = z + 235;
  return Math.max(Math.min(bluff, dSouth, dNorth), Math.min(head, dNorth));
};

const hole8BaseElev = (x: number, z: number): number => {
  const t = clamp(-z / 200, 0, 1);
  return 24.5 - 1.8 * smoothstep(0.15, 0.85, t) + 1.0 * fbm2D(x * 0.03, z * 0.03, 3, 2.0, 0.5, 809);
};

const HOLE_8: HoleDefinition = {
  id: 'hole-8',
  holeNumber: 8,
  name: 'Lighthouse Bluff',
  subtitle: 'Par 3 · 212 Yards · Championship Long-Iron Into Onshore Breeze',
  par: 3,
  yardage: 212,
  bounds: { minX: -95, maxX: 95, minZ: -255, maxZ: 55 },
  defaultWindSpeedMph: 13,
  defaultWindDirRad: Math.PI * 0.82,
  tee: { cx: 0, cz: 0, halfW: 6.0, halfL: 8.0, yawRad: 0.02, elevation: 24.6 },
  fairwaySplines: [
    [
      { x: 2, z: -145, halfWidth: 11.5, elevation: 22.8 },
      { x: 4, z: -175, halfWidth: 12.5, elevation: 22.7 },
    ],
  ],
  roughCorridorHalfWidthExtra: 10.0,
  bunkers: [
    { cx: -14, cz: -186, rx: 5.2, rz: 8.5, rotRad: 0.18, depth: 1.3, lipHeight: 0.65, lipDirRad: 0.25, lobeSeed: 811 },
    { cx: 21, cz: -190, rx: 5.0, rz: 7.5, rotRad: -0.22, depth: 1.25, lipHeight: 0.60, lipDirRad: -0.2, lobeSeed: 821 },
  ],
  green: {
    cx: 4,
    cz: -194,
    rx: 13.0,
    rz: 15.0,
    rotRad: 0.06,
    lobeAmp: 0.08,
    lobeSeed: 827,
    baseElevation: 22.8,
    tiltX: 0.009,
    tiltZ: 0.014,
    ridgeAmp: 0.14,
    ridgeFreq: 0.15,
    cupOffsetX: 1.5,
    cupOffsetZ: -1.5,
    sundayCupOffsetX: -4.4,
    sundayCupOffsetZ: -4.6,
    stimpFeet: 9.2,
  },
  coastlineSignedDist: hole8Coast,
  baseLandElevation: hole8BaseElev,
  trees: generateTreesOutsideCorridor(
    18,
    8100,
    { minX: -65, maxX: 65, minZ: -215, maxZ: 40 },
    (x, z) => {
      if (hole8Coast(x, z) < 11) return false;
      if (Math.abs(x) < 22 && z < 15 && z > -212) return false;
      return true;
    },
    Math.PI * 0.82
  ),
  seaRocks: generateCoastalRocks(hole8Coast, { minX: -85, maxX: 85, minZ: -245, maxZ: 40 }, 30, 8200),
  cameraPreviewTarget: { x: 4, y: 23, z: -175 },
};

// ============================================================================
// HOLE 9: "PACIFIC FINALE" (Par 4, 456 Yards) — Seawall Championship Closer
// ============================================================================
const hole9Coast = (x: number, z: number): number => {
  const leftShore = -26 - 38 * smoothstep(-140, -430, z) + 4.5 * fbm2D(x * 0.02, z * 0.02, 3, 2.0, 0.5, 907);
  const dLeft = x - leftShore;
  const dNorth = z - (-465 + 7 * Math.sin(x * 0.03));
  const dSouth = 48 - z;
  return Math.min(dLeft, dNorth, dSouth);
};

const hole9BaseElev = (x: number, z: number): number => {
  const t = clamp(-z / 430, 0, 1);
  return 18.0 + 3.2 * smoothstep(0.45, 0.95, t) + 1.3 * fbm2D(x * 0.022, z * 0.022, 3, 2.0, 0.5, 911) + smoothstep(26, 90, x) * 7.5;
};

const HOLE_9: HoleDefinition = {
  id: 'hole-9',
  holeNumber: 9,
  name: 'Pacific Finale',
  subtitle: 'Par 4 · 456 Yards · Seawall Drive & Amphitheater Home Green',
  par: 4,
  yardage: 456,
  bounds: { minX: -125, maxX: 115, minZ: -495, maxZ: 60 },
  defaultWindSpeedMph: 12,
  defaultWindDirRad: Math.PI * 0.36,
  tee: { cx: 2, cz: 0, halfW: 6.0, halfL: 8.5, yawRad: -0.04, elevation: 18.2 },
  fairwaySplines: [
    [
      { x: 0, z: -48, halfWidth: 14.5, elevation: 18.1 },
      { x: -8, z: -150, halfWidth: 17.5, elevation: 18.3 },
      { x: -18, z: -260, halfWidth: 17.0, elevation: 19.0 },
      { x: -28, z: -375, halfWidth: 14.5, elevation: 20.5 },
    ],
  ],
  roughCorridorHalfWidthExtra: 11.5,
  bunkers: [
    { cx: -28, cz: -245, rx: 5.0, rz: 10.0, rotRad: -0.2, depth: 1.25, lipHeight: 0.55, lipDirRad: -0.15, lobeSeed: 901 },
    { cx: 7, cz: -272, rx: 5.8, rz: 10.5, rotRad: -0.18, depth: 1.20, lipHeight: 0.52, lipDirRad: -0.2, lobeSeed: 909 },
    { cx: -48, cz: -400, rx: 5.4, rz: 9.2, rotRad: -0.28, depth: 1.35, lipHeight: 0.68, lipDirRad: -0.25, lobeSeed: 919 },
    { cx: -14, cz: -414, rx: 5.2, rz: 7.4, rotRad: 0.2, depth: 1.25, lipHeight: 0.62, lipDirRad: 0.3, lobeSeed: 929 },
  ],
  green: {
    cx: -32,
    cz: -414,
    rx: 13.5,
    rz: 16.5,
    rotRad: -0.2,
    lobeAmp: 0.09,
    lobeSeed: 937,
    baseElevation: 21.1,
    tiltX: 0.012,
    tiltZ: 0.015,
    ridgeAmp: 0.14,
    ridgeFreq: 0.14,
    cupOffsetX: -1.6,
    cupOffsetZ: -1.4,
    sundayCupOffsetX: -4.8,
    sundayCupOffsetZ: -4.5,
    stimpFeet: 9.2,
  },
  seawallSegments: [
    { x1: -44, z1: -320, x2: -54, z2: -380, topElevation: 20.2 },
    { x1: -54, z1: -380, x2: -58, z2: -435, topElevation: 20.9 },
  ],
  coastlineSignedDist: hole9Coast,
  baseLandElevation: hole9BaseElev,
  trees: generateTreesOutsideCorridor(
    30,
    9100,
    { minX: -75, maxX: 105, minZ: -460, maxZ: 45 },
    (x, z) => {
      if (hole9Coast(x, z) < 15) return false;
      const centerApprox = -0.08 * Math.max(0, -z - 40);
      if (Math.abs(x - centerApprox) < 30 && z < 16 && z > -435) return false;
      return true;
    },
    Math.PI * 0.36
  ),
  seaRocks: generateCoastalRocks(hole9Coast, { minX: -115, maxX: 30, minZ: -485, maxZ: 40 }, 34, 9200),
  cameraPreviewTarget: { x: -20, y: 21, z: -290 },
};

// ============================================================================
// PRACTICE LAB: "PACIFIC DRIVING RANGE" — Target Greens & Dispersion Telemetry
// ============================================================================
const rangeCoast = (x: number, z: number): number => {
  // Wide cliffside practice meadow overlooking the Pacific beyond 330m and on both flanks
  const dRight = 85 + 0.1 * Math.max(0, -z) - x;
  const dLeft = x - (-85 - 0.1 * Math.max(0, -z));
  const dFar = z - (-340 + 8 * Math.sin(x * 0.03));
  const dNear = 42 - z;
  const wobble = 4 * fbm2D(x * 0.025, z * 0.025, 3, 2.0, 0.5, 404);
  return Math.min(dRight, dLeft, dFar, dNear) + wobble;
};

const rangeBaseElev = (x: number, z: number): number => {
  const drop = smoothstep(0, -280, z);
  return 24.0 - 4.5 * drop + 0.85 * fbm2D(x * 0.025, z * 0.025, 3, 2.0, 0.5, 88);
};

const DRIVING_RANGE: HoleDefinition = {
  id: 'driving-range',
  holeNumber: 0,
  name: 'Pacific Practice Lab',
  subtitle: 'Driving Range · Target Greens (75–275 yds) · TrackMan Mode',
  par: 4,
  yardage: 275,
  isDrivingRange: true,
  bounds: { minX: -135, maxX: 135, minZ: -380, maxZ: 55 },
  defaultWindSpeedMph: 6,
  defaultWindDirRad: Math.PI * 0.25,
  tee: {
    cx: 0,
    cz: 0,
    halfW: 12.0,
    halfL: 7.0,
    yawRad: 0,
    elevation: 24.2,
  },
  fairwaySplines: [
    [
      { x: 0, z: -30, halfWidth: 28, elevation: 23.6 },
      { x: 0, z: -150, halfWidth: 40, elevation: 21.6 },
      { x: 0, z: -295, halfWidth: 46, elevation: 19.6 },
    ],
  ],
  roughCorridorHalfWidthExtra: 18,
  bunkers: [
    { cx: -32, cz: -145, rx: 6.5, rz: 8.0, rotRad: 0.2, depth: 1.0, lipHeight: 0.45, lipDirRad: 0, lobeSeed: 71 },
    { cx: 34, cz: -195, rx: 7.0, rz: 8.5, rotRad: -0.2, depth: 1.0, lipHeight: 0.45, lipDirRad: 0, lobeSeed: 73 },
    { cx: -22, cz: -255, rx: 6.8, rz: 7.5, rotRad: 0.1, depth: 1.0, lipHeight: 0.45, lipDirRad: 0, lobeSeed: 79 },
  ],
  green: {
    cx: 0,
    cz: -251.5, // 275 yards target green!
    rx: 14.5,
    rz: 14.5,
    rotRad: 0,
    lobeAmp: 0.05,
    lobeSeed: 83,
    baseElevation: 20.0,
    tiltX: 0,
    tiltZ: 0.012,
    ridgeAmp: 0.10,
    ridgeFreq: 0.14,
    cupOffsetX: 0,
    cupOffsetZ: 0,
    stimpFeet: 9.0,
  },
  extraTargets: [
    { x: -16, z: -68.6, label: '75 yds', yardage: 75 },
    { x: 18, z: -114.3, label: '125 yds', yardage: 125 },
    { x: -14, z: -160.0, label: '175 yds', yardage: 175 },
    { x: 16, z: -205.7, label: '225 yds', yardage: 225 },
    { x: 0, z: -251.5, label: '275 yds', yardage: 275 },
  ],
  coastlineSignedDist: rangeCoast,
  baseLandElevation: rangeBaseElev,
  trees: generateTreesOutsideCorridor(
    22,
    4400,
    { minX: -105, maxX: 105, minZ: -310, maxZ: 35 },
    (x, z) => {
      const coast = rangeCoast(x, z);
      if (coast < 10) return false;
      if (Math.abs(x) < 55 && z < 15) return false;
      return true;
    },
    Math.PI * 0.25
  ),
  seaRocks: generateCoastalRocks(rangeCoast, { minX: -125, maxX: 125, minZ: -370, maxZ: 30 }, 24, 4499),
  cameraPreviewTarget: { x: 0, y: 22, z: -165 },
};

export const COURSE_HOLES: HoleDefinition[] = [
  HOLE_1,
  HOLE_2,
  HOLE_3,
  HOLE_4,
  HOLE_5,
  HOLE_6,
  HOLE_7,
  HOLE_8,
  HOLE_9,
  DRIVING_RANGE,
];

export function getHoleById(id: string): HoleDefinition {
  return COURSE_HOLES.find((h) => h.id === id) ?? HOLE_1;
}
