import type { CoastalTreeDef, SeaRockDef } from '../course/types';
import { BALL_RADIUS_M, CUP_DEPTH_M, CUP_RADIUS_M, FLAGSTICK_RADIUS_M } from './constants';
import { v3Dot, v3Len, v3Scale, v3Sub, type Vec3 } from './aerodynamics';

export type ObstacleHitKind = 'trunk' | 'canopy' | 'rock' | 'flagstick';

export interface ObstacleCollisionResult {
  hit: ObstacleHitKind;
  pos: Vec3;
  vel: Vec3;
  omega: Vec3;
  holedFromPin?: boolean;
}

/**
 * Resolves airborne golf-ball collisions against course trees (trunk & canopy),
 * coastal sea rocks, and an in-cup flagstick pole during live flight simulation.
 */
export function resolveFlightObstacles(
  pos: Vec3,
  vel: Vec3,
  omega: Vec3,
  trees: CoastalTreeDef[],
  seaRocks: SeaRockDef[],
  getGroundHeight: (x: number, z: number) => number,
  cupPos: Vec3 | null,
  flagstickInCup: boolean,
  canopyCooldownS: number
): ObstacleCollisionResult | null {
  // 1. Flagstick in cup (exact 2.35 m fiberglass pole above cup center)
  if (flagstickInCup && cupPos) {
    const dx = pos.x - cupPos.x;
    const dz = pos.z - cupPos.z;
    const radialDist = Math.hypot(dx, dz);
    const pinHitRadius = BALL_RADIUS_M + FLAGSTICK_RADIUS_M + 0.008;
    const relY = pos.y - cupPos.y;
    if (radialDist < pinHitRadius && relY >= -0.04 && relY <= 2.35) {
      const hSpd = Math.hypot(vel.x, vel.z);
      const nx = radialDist > 1e-5 ? dx / radialDist : hSpd > 1e-5 ? -vel.x / hSpd : 1;
      const nz = radialDist > 1e-5 ? dz / radialDist : hSpd > 1e-5 ? -vel.z / hSpd : 0;
      const vn = vel.x * nx + vel.z * nz;
      if (vn < 0) {
        const nextVel = {
          x: vel.x - 1.46 * vn * nx,
          y: vel.y * 0.55 - 0.8,
          z: vel.z - 1.46 * vn * nz,
        };
        const outPos = {
          x: cupPos.x + nx * (pinHitRadius + 0.004),
          y: pos.y,
          z: cupPos.z + nz * (pinHitRadius + 0.004),
        };
        // Direct drop into cup off flagstick if low & slow right above rim
        if (relY < 0.28 && v3Len(nextVel) < 2.2 && radialDist < CUP_RADIUS_M * 1.1) {
          return {
            hit: 'flagstick',
            pos: { x: cupPos.x, y: cupPos.y - CUP_DEPTH_M * 0.65, z: cupPos.z },
            vel: { x: 0, y: 0, z: 0 },
            omega: { x: 0, y: 0, z: 0 },
            holedFromPin: true,
          };
        }
        return {
          hit: 'flagstick',
          pos: outPos,
          vel: nextVel,
          omega: v3Scale(omega, 0.5),
        };
      }
    }
  }

  // 2. Coastal tree trunks & wind-bent canopies
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    const dx = pos.x - t.x;
    const dz = pos.z - t.z;
    const distXZ = Math.hypot(dx, dz);
    const maxReach = 3.2 * t.scale;
    if (distXZ > maxReach) continue;

    const baseY = getGroundHeight(t.x, t.z);
    const trunkR = 0.26 * t.scale + BALL_RADIUS_M;
    const trunkTopY = baseY + 4.4 * t.scale;

    // Solid bark trunk cylinder
    if (distXZ < trunkR && pos.y >= baseY && pos.y <= trunkTopY) {
      const hSpd = Math.hypot(vel.x, vel.z);
      const nx = distXZ > 1e-5 ? dx / distXZ : hSpd > 1e-5 ? -vel.x / hSpd : 1;
      const nz = distXZ > 1e-5 ? dz / distXZ : hSpd > 1e-5 ? -vel.z / hSpd : 0;
      const vn = vel.x * nx + vel.z * nz;
      if (vn < 0) {
        const restit = 0.58;
        return {
          hit: 'trunk',
          pos: {
            x: t.x + nx * (trunkR + 0.015),
            y: pos.y,
            z: t.z + nz * (trunkR + 0.015),
          },
          vel: {
            x: vel.x - (1 + restit) * vn * nx,
            y: vel.y * 0.72,
            z: vel.z - (1 + restit) * vn * nz,
          },
          omega: v3Scale(omega, 0.45),
        };
      }
    }

    // Soft conifer foliage canopy ellipsoid (only trigger once per canopy transit via cooldown)
    if (canopyCooldownS <= 0) {
      const canopyCenterY =
        baseY + (t.species === 'cypress' ? 5.6 : 6.1) * t.scale;
      const canopyRXZ = (t.species === 'cypress' ? 2.55 : 2.15) * t.scale;
      const canopyRY = (t.species === 'cypress' ? 2.25 : 2.65) * t.scale;
      const leanX = Math.sin(t.windBendRad) * 0.55 * t.scale;
      const leanZ = -Math.cos(t.windBendRad) * 0.55 * t.scale;
      const cx = (pos.x - (t.x + leanX)) / canopyRXZ;
      const cy = (pos.y - canopyCenterY) / canopyRY;
      const cz = (pos.z - (t.z + leanZ)) / canopyRXZ;
      const ellipSq = cx * cx + cy * cy + cz * cz;

      if (ellipSq <= 1.0 && v3Len(vel) > 1.8) {
        // Deterministic twig scatter deflection + drag speed reduction
        const scatterAngle = (((t.seed * 73 + Math.round(pos.y * 100)) % 100) / 100 - 0.5) * 0.52;
        const cosA = Math.cos(scatterAngle);
        const sinA = Math.sin(scatterAngle);
        const vxRot = vel.x * cosA - vel.z * sinA;
        const vzRot = vel.x * sinA + vel.z * cosA;
        return {
          hit: 'canopy',
          pos: { ...pos },
          vel: {
            x: vxRot * 0.56,
            y: Math.min(vel.y * 0.48, -1.2),
            z: vzRot * 0.56,
          },
          omega: v3Scale(omega, 0.25),
        };
      }
    }
  }

  // 3. Coastal sea rock domes
  for (let i = 0; i < seaRocks.length; i++) {
    const r = seaRocks[i];
    const dx = pos.x - r.x;
    const dz = pos.z - r.z;
    const distXZ = Math.hypot(dx, dz);
    if (distXZ > r.radius + 0.5) continue;

    const baseY = Math.max(-1.0, getGroundHeight(r.x, r.z));
    const rx = r.radius * 0.88;
    const ry = r.height * 0.86;
    const nx = dx / rx;
    const ny = (pos.y - baseY) / ry;
    const nz = dz / rx;
    const normDistSq = nx * nx + ny * ny + nz * nz;

    if (normDistSq <= 1.0 && ny >= -0.1) {
      const nRaw: Vec3 = {
        x: dx / (rx * rx),
        y: Math.max(0.05, (pos.y - baseY) / (ry * ry)),
        z: dz / (rx * rx),
      };
      const nLen = v3Len(nRaw) || 1;
      const n = v3Scale(nRaw, 1 / nLen);
      const vn = v3Dot(vel, n);
      if (vn < 0) {
        const restit = 0.64;
        const outVel = v3Sub(vel, v3Scale(n, (1 + restit) * vn));
        return {
          hit: 'rock',
          pos: {
            x: pos.x + n.x * 0.08,
            y: pos.y + n.y * 0.08,
            z: pos.z + n.z * 0.08,
          },
          vel: outVel,
          omega: v3Scale(omega, 0.4),
        };
      }
    }
  }

  return null;
}
