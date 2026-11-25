/**
 * Fuzz/property tests: hammer the physics with extreme and random inputs and assert
 * every position/velocity stays finite and sane. Surfaces numeric bugs that
 * hand-picked test cases miss.
 */
import { describe, expect, it } from 'vitest';
import { COURSE_HOLES, getHoleById } from '../../course/courseData';
import { HoleTerrainSampler } from '../../course/terrainSampler';
import { CLUB_BAG, getClubById } from '../clubs';
import { stepFlightRK4, v3Len, type Vec3 } from '../aerodynamics';
import { resolveCompliantTurfBounce, stepRollingOnTurf } from '../bounceAndRoll';
import { computeClubImpactLaunch } from '../launchModel';
import { BALL_RADIUS_M, COASTAL_STANDARD_ATMOSPHERE } from '../constants';
import { simulateFullShot } from '../simulation';
import { getSurfaceProperties, type SurfaceType } from '../surfaces';

const SURFACE_TYPES: SurfaceType[] = [
  'tee',
  'fairway',
  'fringe',
  'green',
  'rough',
  'heavy_rough',
  'bunker',
  'cliff_rock',
  'cart_path',
  'water',
];

function expectFiniteVec3(v: Vec3, label: string): void {
  expect(Number.isFinite(v.x), `${label}.x`).toBe(true);
  expect(Number.isFinite(v.y), `${label}.y`).toBe(true);
  expect(Number.isFinite(v.z), `${label}.z`).toBe(true);
}

// deterministic PRNG
function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('physics fuzz (finite & sane under extreme inputs)', () => {
  it('bounce solver survives extreme velocities/spins on every surface', () => {
    const rnd = mulberry(1234);
    for (let i = 0; i < 4000; i++) {
      const surf = SURFACE_TYPES[i % SURFACE_TYPES.length];
      const speed = rnd() * 95;
      const elev = (rnd() - 0.85) * Math.PI; // mostly downward
      const azim = rnd() * Math.PI * 2;
      const vel: Vec3 = {
        x: Math.cos(elev) * Math.cos(azim) * speed,
        y: Math.sin(elev) * speed,
        z: Math.cos(elev) * Math.sin(azim) * speed,
      };
      const omega: Vec3 = {
        x: (rnd() - 0.5) * 2200,
        y: (rnd() - 0.5) * 2200,
        z: (rnd() - 0.5) * 2200,
      };
      const tiltX = (rnd() - 0.5) * 0.5;
      const tiltZ = (rnd() - 0.5) * 0.5;
      const n: Vec3 = { x: tiltX, y: 1, z: tiltZ };
      const out = resolveCompliantTurfBounce(vel, omega, n, surf, 8 + rnd() * 6);
      expectFiniteVec3(out.vel, `bounce.vel[${i}]`);
      expectFiniteVec3(out.omega, `bounce.omega[${i}]`);
      // Energy sanity: the only legitimate speed gain is spin->linear conversion
      // (measured max 0.32 x spin surface speed; Penner zip/check). Never exceed it,
      // and with negligible spin there must be NO gain at all.
      const spinLinear = v3Len(omega) * BALL_RADIUS_M;
      const gain = v3Len(out.vel) - speed;
      expect(gain, `bounce energy[${i}]`).toBeLessThanOrEqual(0.35 * spinLinear + 0.05);
      if (spinLinear < 0.05) {
        expect(gain, `bounce no-spin gain[${i}]`).toBeLessThanOrEqual(0.01);
      }
    }
  });

  it('roll solver stays finite on random slopes and speeds', () => {
    const rnd = mulberry(777);
    for (let i = 0; i < 3000; i++) {
      const tiltX = (rnd() - 0.5) * 0.35;
      const tiltZ = (rnd() - 0.5) * 0.35;
      const h = (_x: number, _z: number) => 10;
      const n = () => {
        const l = Math.hypot(tiltX, 1, tiltZ);
        return { x: tiltX / l, y: 1 / l, z: tiltZ / l };
      };
      const surf = SURFACE_TYPES[i % SURFACE_TYPES.length];
      const sp = rnd() * 22;
      const az = rnd() * Math.PI * 2;
      const pos: Vec3 = { x: rnd() * 100, y: 10 + BALL_RADIUS_M, z: rnd() * 100 };
      const vel: Vec3 = { x: Math.cos(az) * sp, y: 0, z: Math.sin(az) * sp };
      const out = stepRollingOnTurf(pos, vel, h, n, () => surf, null, false, 1 / 240, 11);
      expectFiniteVec3(out.pos, `roll.pos[${i}]`);
      expectFiniteVec3(out.vel, `roll.vel[${i}]`);
      expectFiniteVec3(out.omega, `roll.omega[${i}]`);
      expect(Number.isFinite(v3Len(out.vel))).toBe(true);
    }
  });

  it('RK4 flight stays finite under extreme spin and wind', () => {
    const rnd = mulberry(4242);
    for (let i = 0; i < 800; i++) {
      const vel: Vec3 = { x: (rnd() - 0.5) * 90, y: rnd() * 55, z: (rnd() - 0.5) * 90 };
      const omega: Vec3 = { x: (rnd() - 0.5) * 2000, y: (rnd() - 0.5) * 2000, z: (rnd() - 0.5) * 2000 };
      const wind = { speedMps: rnd() * 25, directionRad: rnd() * Math.PI * 2, gustiness: rnd() };
      const out = stepFlightRK4(
        { pos: { x: 0, y: 30, z: 0 }, vel, omega, timeS: rnd() * 5 },
        1 / 240,
        wind,
        0,
        COASTAL_STANDARD_ATMOSPHERE
      );
      expectFiniteVec3(out.next.pos, `rk4.pos[${i}]`);
      expectFiniteVec3(out.next.vel, `rk4.vel[${i}]`);
      expectFiniteVec3(out.next.omega, `rk4.omega[${i}]`);
    }
  });

  it('launch model is finite for every club across the power range', () => {
    for (const club of CLUB_BAG) {
      for (let p = 0; p <= 10; p++) {
        const out = computeClubImpactLaunch({
          club,
          aimYawRad: p * 0.13,
          powerRatio: p / 10,
          clubPathDeg: (p - 5) * 2.4,
          faceAngleDeg: (5 - p) * 1.7,
          attackAngleDeg: club.tourAttackAngleDeg + (p - 5),
          dynamicLoftDeltaDeg: (p - 5) * 0.8,
          strikeOffsetXMm: (p - 5) * 2.2,
          strikeOffsetYMm: (5 - p) * 1.9,
          surface: 'fairway',
          terrainNormal: { x: 0.03, y: 1, z: -0.02 },
        });
        expectFiniteVec3(out.initialVelocity, `launch.vel[${club.id}@${p}]`);
        expectFiniteVec3(out.initialOmega, `launch.omega[${club.id}@${p}]`);
        expect(Number.isFinite(out.totalSpinRpm)).toBe(true);
      }
    }
  });

  it('full-hole simulations on real holes never produce NaN/Infinity', () => {
    const rnd = mulberry(99);
    for (const holeMeta of COURSE_HOLES) {
      const hole = getHoleById(holeMeta.id);
      const sampler = new HoleTerrainSampler(hole, 'pro');
      for (let s = 0; s < 3; s++) {
        const club = getClubById(CLUB_BAG[Math.floor(rnd() * CLUB_BAG.length)].id);
        const start = sampler.getTeeBallPosition();
        const aimYawRad =
          Math.atan2(sampler.cupPosition.x - start.x, -(sampler.cupPosition.z - start.z)) +
          (rnd() - 0.5) * 0.24;
        const res = simulateFullShot(
          start,
          {
            club,
            aimYawRad,
            powerRatio: 0.72 + rnd() * 0.28,
            clubPathDeg: (rnd() - 0.5) * 6,
            faceAngleDeg: (rnd() - 0.5) * 5,
            attackAngleDeg: club.tourAttackAngleDeg + (rnd() - 0.5) * 3,
            dynamicLoftDeltaDeg: (rnd() - 0.5) * 2,
            strikeOffsetXMm: (rnd() - 0.5) * 8,
            strikeOffsetYMm: (rnd() - 0.5) * 6,
            surface: 'tee',
            terrainNormal: sampler.getNormal(start.x, start.z),
          },
          {
            speedMps: hole.defaultWindSpeedMph * 0.44704,
            directionRad: hole.defaultWindDirRad,
            gustiness: 0.4,
          },
          sampler,
          COASTAL_STANDARD_ATMOSPHERE
        );
        expectFiniteVec3(res.finalPosition, `final[${hole.id}#${s}]`);
        expectFiniteVec3(res.landingPosition, `landing[${hole.id}#${s}]`);
        expect(Number.isFinite(res.totalDistanceYds), `totalYds[${hole.id}#${s}]`).toBe(true);
        expect(Number.isFinite(res.carryDistanceYds), `carryYds[${hole.id}#${s}]`).toBe(true);
        expect(res.flightTimeS).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('surface properties are defined for every surface type', () => {
    for (const s of SURFACE_TYPES) {
      const p = getSurfaceProperties(s, 11);
      expect(Number.isFinite(p.baseCor)).toBe(true);
      expect(Number.isFinite(p.kineticFriction)).toBe(true);
      expect(Number.isFinite(p.rollingResistanceRho)).toBe(true);
    }
  });
});
