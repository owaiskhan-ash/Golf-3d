/**
 * Regression tests for ball-flight visual smoothness.
 *
 * These replicate GolfEngine's live loop (fixed 1/120 s physics steps with 2 substeps
 * + render interpolation) using the real physics modules and assert that:
 *  1. Rendered ball positions always lie on the true simulated trajectory, even under
 *     heavily jittered frame times (so no spatial jitter can appear).
 *  2. Per-frame heading changes during flight stay tiny for every frame-rate pattern.
 *  3. A shot bound for the ocean splashes at the visible water plane (y=0) rather than
 *     sinking to the seabed and snapping.
 */
import { describe, expect, it } from 'vitest';
import { COURSE_HOLES, getHoleById } from '../../course/courseData';
import { HoleTerrainSampler } from '../../course/terrainSampler';
import { getClubById } from '../clubs';
import { stepFlightRK4, v3Dot, v3Len, type Vec3 } from '../aerodynamics';
import { resolveCompliantTurfBounce, stepRollingOnTurf } from '../bounceAndRoll';
import { computeClubImpactLaunch } from '../launchModel';
import { BALL_RADIUS_M, COASTAL_STANDARD_ATMOSPHERE } from '../constants';
import { simulateFullShot } from '../simulation';

const FIXED = 1 / 120;

interface LiveRun {
  frames: Array<{ t: number; renderT: number; pos: Vec3; mode: string }>;
  trueStates: Array<{ t: number; pos: Vec3 }>;
  minRenderY: number;
}

/** Mirrors GolfEngine.stepPhysicsSimulation + the render interpolation loop. */
function runLiveLoop(frameDt: (k: number) => number): LiveRun {
  const hole = getHoleById(COURSE_HOLES[1].id);
  const sampler = new HoleTerrainSampler(hole, 'pro');
  const club = getClubById('DR');
  const ballPos0 = sampler.getTeeBallPosition();
  const aimYawRad = Math.atan2(
    sampler.cupPosition.x - ballPos0.x,
    -(sampler.cupPosition.z - ballPos0.z)
  );
  const launch = computeClubImpactLaunch({
    club,
    aimYawRad,
    powerRatio: 1.0,
    clubPathDeg: 0,
    faceAngleDeg: 0,
    attackAngleDeg: club.tourAttackAngleDeg,
    dynamicLoftDeltaDeg: 0,
    strikeOffsetXMm: 0,
    strikeOffsetYMm: 0,
    surface: 'tee',
    terrainNormal: sampler.getNormal(ballPos0.x, ballPos0.z),
  });
  const wind = {
    speedMps: hole.defaultWindSpeedMph * 0.44704,
    directionRad: hole.defaultWindDirRad,
    gustiness: 0.35,
  };

  let pos = { ...ballPos0 };
  let vel = { ...launch.initialVelocity };
  let omega = { ...launch.initialOmega };
  let simMode: 'flight' | 'roll' = 'flight';
  let simTimeS = 0;
  let bounceCount = 0;
  let done = false;

  const trueStates: Array<{ t: number; pos: Vec3 }> = [{ t: 0, pos: { ...pos } }];

  function stepPhysics(frameDtS: number): void {
    const dt = frameDtS / 2;
    for (let i = 0; i < 2; i++) {
      if (simMode === 'flight') {
        const groundY = sampler.getHeight(pos.x, pos.z);
        const { next } = stepFlightRK4(
          { pos, vel, omega, timeS: simTimeS },
          dt,
          wind,
          groundY,
          COASTAL_STANDARD_ATMOSPHERE
        );
        pos = next.pos;
        vel = next.vel;
        omega = next.omega;
        simTimeS = next.timeS;

        const terrainY = sampler.getHeight(pos.x, pos.z);
        const surfaceY = terrainY + BALL_RADIUS_M;
        let touchedDown = pos.y <= surfaceY;
        let splashed = false;
        if (!touchedDown && pos.y <= BALL_RADIUS_M + 0.02) {
          if (sampler.getSurface(pos.x, pos.z) === 'water') {
            touchedDown = true;
            splashed = true;
          }
        }
        if (touchedDown) {
          const surf = sampler.getSurface(pos.x, pos.z);
          pos.y = splashed ? BALL_RADIUS_M * 0.4 : surfaceY;
          if (splashed || surf === 'water' || pos.y <= BALL_RADIUS_M + 0.05) {
            done = true;
            return;
          }
          const n = sampler.getNormal(pos.x, pos.z);
          if (v3Dot(vel, n) < 0) {
            const b = resolveCompliantTurfBounce(vel, omega, n, surf, sampler.greenStimpFeet);
            vel = b.vel;
            omega = b.omega;
            bounceCount++;
            if (b.stoppedInSand) {
              done = true;
              return;
            }
            if (b.transitionToRoll || bounceCount >= 6) simMode = 'roll';
          }
        }
      } else {
        const r = stepRollingOnTurf(
          pos,
          vel,
          sampler.getHeight,
          sampler.getNormal,
          sampler.getSurface,
          sampler.cupPosition,
          true,
          dt,
          sampler.greenStimpFeet
        );
        pos = r.pos;
        vel = r.vel;
        omega = r.omega;
        simTimeS += dt;
        if (r.holed || r.stopped) {
          done = true;
          return;
        }
        if (r.becameAirborne) simMode = 'flight';
      }
    }
  }

  const frames: LiveRun['frames'] = [];
  let accum = 0;
  let wallT = 0;
  let prev = { ...pos };
  let k = 0;
  let minRenderY = Infinity;
  while (!done && wallT < 30) {
    const dt = frameDt(k);
    wallT += dt;
    accum += dt;
    let steps = 0;
    while (accum >= FIXED && !done && steps < 8) {
      prev = { ...pos };
      stepPhysics(FIXED);
      accum -= FIXED;
      steps++;
      trueStates.push({ t: simTimeS, pos: { ...pos } });
    }
    const alpha = Math.min(1, Math.max(0, accum / FIXED));
    // Mirror GolfEngine: interpolate only while the ball is still in motion; on the
    // terminal frame (splash/stop mid-step) the engine snaps to the true final position.
    const render: Vec3 = done
      ? { ...pos }
      : {
          x: prev.x + (pos.x - prev.x) * alpha,
          y: prev.y + (pos.y - prev.y) * alpha,
          z: prev.z + (pos.z - prev.z) * alpha,
        };
    if (render.y < minRenderY) minRenderY = render.y;
    frames.push({ t: wallT, renderT: simTimeS - FIXED + accum, pos: render, mode: simMode });
    k++;
  }
  return { frames, trueStates, minRenderY };
}

function maxDeviationFromTruePath(run: LiveRun): number {
  let maxDev = 0;
  const states = run.trueStates;
  // Skip the final frame: on terminal events (splash/stop mid-step) the engine intentionally
  // snaps the ball to the exact final physics state instead of interpolating.
  for (let fi = 0; fi < run.frames.length - 1; fi++) {
    const f = run.frames[fi];
    let lo = 0;
    let hi = states.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (states[mid].t <= f.renderT) lo = mid;
      else hi = mid;
    }
    const a = states[lo];
    const b = states[Math.min(hi, states.length - 1)];
    const span = Math.max(1e-9, b.t - a.t);
    const u = Math.min(1, Math.max(0, (f.renderT - a.t) / span));
    const trueP = {
      x: a.pos.x + (b.pos.x - a.pos.x) * u,
      y: a.pos.y + (b.pos.y - a.pos.y) * u,
      z: a.pos.z + (b.pos.z - a.pos.z) * u,
    };
    const dev = v3Len({ x: f.pos.x - trueP.x, y: f.pos.y - trueP.y, z: f.pos.z - trueP.z });
    if (dev > maxDev) maxDev = dev;
  }
  return maxDev;
}

function maxMidflightHeadingDeltaDeg(run: LiveRun): number {
  const frames = run.frames;
  let maxDeg = 0;
  // Skip the final 3 frames: a terminal event (splash/stop) legitimately ends the path.
  for (let i = 2; i < frames.length - 3; i++) {
    const a = frames[i - 2];
    const b = frames[i - 1];
    const c = frames[i];
    const dt1 = b.t - a.t;
    const dt2 = c.t - b.t;
    if (dt1 < 1e-4 || dt2 < 1e-4) continue;
    const v1 = {
      x: (b.pos.x - a.pos.x) / dt1,
      y: (b.pos.y - a.pos.y) / dt1,
      z: (b.pos.z - a.pos.z) / dt1,
    };
    const v2 = {
      x: (c.pos.x - b.pos.x) / dt2,
      y: (c.pos.y - b.pos.y) / dt2,
      z: (c.pos.z - b.pos.z) / dt2,
    };
    const s1 = v3Len(v1);
    const s2 = v3Len(v2);
    if (s1 > 3 && s2 > 3) {
      const cosA = Math.min(1, Math.max(-1, v3Dot(v1, v2) / (s1 * s2)));
      const deg = (Math.acos(cosA) * 180) / Math.PI;
      if (deg > maxDeg) maxDeg = deg;
    }
  }
  return maxDeg;
}

describe('Ball flight visual smoothness (regression)', () => {
  const patterns: Array<[string, (k: number) => number]> = [
    ['steady 60fps', () => 1 / 60],
    [
      'jittery 60fps (±35%)',
      (() => {
        let seed = 42;
        return () => {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          return (1 / 60) * (0.65 + 0.7 * (seed / 0x7fffffff));
        };
      })(),
    ],
    ['steady 25fps', () => 0.04],
    ['144fps', () => 1 / 144],
  ];

  for (const [label, frameDt] of patterns) {
    it(`rendered path tracks the true trajectory at ${label}`, () => {
      const run = runLiveLoop(frameDt);
      expect(run.frames.length).toBeGreaterThan(30);
      expect(maxDeviationFromTruePath(run)).toBeLessThan(0.005); // < 5 mm
      expect(maxMidflightHeadingDeltaDeg(run)).toBeLessThan(1.5); // deg per frame
    });
  }

  it('ocean-bound shots splash at the visible water plane, never below it', () => {
    const run = runLiveLoop(() => 1 / 60);
    const last = run.frames[run.frames.length - 1];
    // Hole 2 driver ends in the ocean in this scenario: ball must never render underwater
    expect(run.minRenderY).toBeGreaterThan(-0.2);
    expect(last.pos.y).toBeGreaterThan(-0.2);
    expect(last.pos.y).toBeLessThan(0.2);
  });

  it('offline preview simulation also stops at the water plane', () => {
    const hole = getHoleById(COURSE_HOLES[1].id);
    const sampler = new HoleTerrainSampler(hole, 'pro');
    const club = getClubById('DR');
    const start = sampler.getTeeBallPosition();
    const aimYawRad = Math.atan2(
      sampler.cupPosition.x - start.x,
      -(sampler.cupPosition.z - start.z)
    );
    const res = simulateFullShot(
      start,
      {
        club,
        aimYawRad,
        powerRatio: 1.0,
        clubPathDeg: 0,
        faceAngleDeg: 0,
        attackAngleDeg: club.tourAttackAngleDeg,
        dynamicLoftDeltaDeg: 0,
        strikeOffsetXMm: 0,
        strikeOffsetYMm: 0,
        surface: 'tee',
        terrainNormal: sampler.getNormal(start.x, start.z),
      },
      {
        speedMps: hole.defaultWindSpeedMph * 0.44704,
        directionRad: hole.defaultWindDirRad,
        gustiness: 0.35,
      },
      sampler,
      COASTAL_STANDARD_ATMOSPHERE
    );
    if (res.finalSurface === 'water') {
      for (const p of res.flightPoints) {
        expect(p.y).toBeGreaterThan(-0.2);
      }
    }
  });
});
