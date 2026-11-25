import {
  BALL_RADIUS_M,
  COASTAL_STANDARD_ATMOSPHERE,
  M_TO_YARDS,
  RADPS_TO_RPM,
  RAD_TO_DEG,
  type AtmosphereConditions,
} from './constants';
import {
  stepFlightRK4,
  v3Dot,
  v3Len,
  v3Norm,
  type Vec3,
  type WindField,
} from './aerodynamics';
import {
  resolveCompliantTurfBounce,
  stepRollingOnTurf,
} from './bounceAndRoll';
import {
  computeClubImpactLaunch,
  type LaunchTelemetry,
  type SwingParameters,
} from './launchModel';
import type { SurfaceType } from './surfaces';

export interface TerrainQuery {
  getHeight: (x: number, z: number) => number;
  getNormal: (x: number, z: number) => Vec3;
  getSurface: (x: number, z: number) => SurfaceType;
  cupPosition: Vec3 | null;
  flagstickInCup: boolean;
  greenStimpFeet: number;
}

export interface ShotPredictionResult {
  launch: LaunchTelemetry;
  flightPoints: Vec3[];
  rollPoints: Vec3[];
  carryDistanceYds: number;
  totalDistanceYds: number;
  apexHeightYds: number;
  flightTimeS: number;
  landingAngleDeg: number;
  landingPosition: Vec3;
  finalPosition: Vec3;
  finalSurface: SurfaceType;
  curveOfflineYds: number;
  holed: boolean;
}

/**
 * Simulates an entire shot from impact through flight, bounces, and roll until rest (or hazard).
 * Used both for instant physics verification/tests and optional caddie/aim-preview trajectory arcs.
 */
export function simulateFullShot(
  startPos: Vec3,
  swing: SwingParameters,
  wind: WindField,
  terrain: TerrainQuery,
  atmosphere: AtmosphereConditions = COASTAL_STANDARD_ATMOSPHERE
): ShotPredictionResult {
  const launch = computeClubImpactLaunch(swing);
  const flightPoints: Vec3[] = [{ ...startPos }];
  const rollPoints: Vec3[] = [];

  let pos = { ...startPos };
  let vel = { ...launch.initialVelocity };
  let omega = { ...launch.initialOmega };
  let timeS = 0;

  let apexY = startPos.y;
  let hasLanded = false;
  let landingPos = { ...startPos };
  let landingAngleDeg = 0;
  let flightTimeS = 0;
  let holed = false;

  const aimFwd = {
    x: Math.sin(swing.aimYawRad),
    y: 0,
    z: -Math.cos(swing.aimYawRad),
  };
  const aimRight = { x: -aimFwd.z, y: 0, z: aimFwd.x };

  if (launch.isPutt) {
    hasLanded = true;
    landingPos = { ...startPos };
  }

  let mode: 'flight' | 'roll' = launch.isPutt ? 'roll' : 'flight';
  let bounceCount = 0;
  const maxSimTimeS = 22;
  const dtFlight = 0.004;
  const dtRoll = 0.008;

  while (timeS < maxSimTimeS) {
    if (mode === 'flight') {
      const groundY = terrain.getHeight(pos.x, pos.z);
      const { next } = stepFlightRK4(
        { pos, vel, omega, timeS },
        dtFlight,
        wind,
        groundY,
        atmosphere
      );
      pos = next.pos;
      vel = next.vel;
      omega = next.omega;
      timeS = next.timeS;

      if (pos.y > apexY) apexY = pos.y;

      const surfaceY = terrain.getHeight(pos.x, pos.z) + BALL_RADIUS_M;
      let touchedDown = pos.y <= surfaceY;
      let splashedAtSeaPlane = false;
      // Over the ocean the visible surface is the y=0 water plane, not the seabed below —
      // end the flight there so preview arcs & splash handling never dive underwater.
      if (!touchedDown && pos.y <= BALL_RADIUS_M + 0.02) {
        if (terrain.getSurface(pos.x, pos.z) === 'water') {
          touchedDown = true;
          splashedAtSeaPlane = true;
        }
      }
      if (touchedDown) {
        const surf = terrain.getSurface(pos.x, pos.z);
        pos.y = splashedAtSeaPlane ? BALL_RADIUS_M * 0.4 : surfaceY;

        if (!hasLanded) {
          hasLanded = true;
          landingPos = { ...pos };
          flightTimeS = timeS;
          const horizSpd = Math.hypot(vel.x, vel.z);
          landingAngleDeg = Math.atan2(Math.abs(vel.y), Math.max(0.01, horizSpd)) * RAD_TO_DEG;
        }

        if (splashedAtSeaPlane || surf === 'water' || pos.y <= BALL_RADIUS_M + 0.02) {
          // Water hazard
          flightPoints.push({ ...pos });
          break;
        }

        const n = terrain.getNormal(pos.x, pos.z);
        if (v3Dot(vel, n) < 0) {
          const bounce = resolveCompliantTurfBounce(
            vel,
            omega,
            n,
            surf,
            terrain.greenStimpFeet
          );
          vel = bounce.vel;
          omega = bounce.omega;
          bounceCount++;
          flightPoints.push({ ...pos });

          if (bounce.stoppedInSand) {
            rollPoints.push({ ...pos });
            break;
          }
          if (bounce.transitionToRoll || bounceCount >= 6) {
            mode = 'roll';
            rollPoints.push({ ...pos });
          }
        }
      } else if (flightPoints.length === 0 || Math.floor(timeS / 0.04) > flightPoints.length) {
        flightPoints.push({ ...pos });
      }
    } else {
      const step = stepRollingOnTurf(
        pos,
        vel,
        terrain.getHeight,
        terrain.getNormal,
        terrain.getSurface,
        terrain.cupPosition,
        terrain.flagstickInCup,
        dtRoll,
        terrain.greenStimpFeet
      );
      pos = step.pos;
      vel = step.vel;
      omega = step.omega;
      timeS += dtRoll;

      const surf = terrain.getSurface(pos.x, pos.z);
      if (surf === 'water' || pos.y <= BALL_RADIUS_M + 0.02) {
        rollPoints.push({ ...pos });
        break;
      }
      if (step.holed) {
        holed = true;
        rollPoints.push({ ...pos });
        break;
      }
      if (step.becameAirborne) {
        mode = 'flight';
      }
      if (rollPoints.length === 0 || v3Len({
        x: pos.x - rollPoints[rollPoints.length - 1].x,
        y: pos.y - rollPoints[rollPoints.length - 1].y,
        z: pos.z - rollPoints[rollPoints.length - 1].z,
      }) > 0.12) {
        rollPoints.push({ ...pos });
      }
      if (step.stopped) {
        rollPoints.push({ ...pos });
        break;
      }
    }
  }

  const carryM = Math.hypot(landingPos.x - startPos.x, landingPos.z - startPos.z);
  const totalM = Math.hypot(pos.x - startPos.x, pos.z - startPos.z);
  const deltaFinal = { x: pos.x - startPos.x, y: 0, z: pos.z - startPos.z };
  const curveOfflineM = v3Dot(deltaFinal, aimRight);
  const finalSurface = terrain.getSurface(pos.x, pos.z);

  return {
    launch,
    flightPoints,
    rollPoints,
    carryDistanceYds: carryM * M_TO_YARDS,
    totalDistanceYds: totalM * M_TO_YARDS,
    apexHeightYds: Math.max(0, apexY - startPos.y) * M_TO_YARDS,
    flightTimeS,
    landingAngleDeg,
    landingPosition: landingPos,
    finalPosition: pos,
    finalSurface,
    curveOfflineYds: curveOfflineM * M_TO_YARDS,
    holed,
  };
}

/**
 * Formats live spin vector into readable backspin/sidespin RPM in the ball's travel plane.
 */
export function decomposeSpinRpm(vel: Vec3, omega: Vec3): { totalRpm: number; backSpinRpm: number; sideSpinRpm: number } {
  const spd = v3Len(vel);
  const totalRpm = v3Len(omega) * RADPS_TO_RPM;
  if (spd < 0.1) return { totalRpm, backSpinRpm: totalRpm, sideSpinRpm: 0 };
  const fwd = v3Norm(vel);
  const right = v3Norm({ x: -fwd.z, y: 0, z: fwd.x });
  const up = v3Norm({
    x: right.y * fwd.z - right.z * fwd.y,
    y: right.z * fwd.x - right.x * fwd.z,
    z: right.x * fwd.y - right.y * fwd.x,
  });
  const backSpinRpm = v3Dot(omega, right) * RADPS_TO_RPM;
  const sideSpinRpm = -v3Dot(omega, up) * RADPS_TO_RPM;
  return { totalRpm, backSpinRpm, sideSpinRpm };
}
