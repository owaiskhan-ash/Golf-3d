import {
  BALL_RADIUS_M,
  CUP_DEPTH_M,
  CUP_RADIUS_M,
  DEG_TO_RAD,
  FLAGSTICK_RADIUS_M,
  GRAVITY,
  RAD_TO_DEG,
} from './constants';
import type { Vec3 } from './aerodynamics';
import { v3Add, v3Cross, v3Dot, v3Len, v3Norm, v3Scale, v3Sub } from './aerodynamics';
import { getSurfaceProperties, type SurfaceType } from './surfaces';

export interface BounceResult {
  vel: Vec3;
  omega: Vec3;
  transitionToRoll: boolean;
  stoppedInSand: boolean;
  impactSpeedMps: number;
}

/**
 * Penner (2002) "The Run of a Golf Ball" compliant-turf impact solver.
 * Handles:
 *  - Dynamic turf deformation contact angle theta_c
 *  - Velocity-dependent normal coefficient of restitution e(|v_n'|)
 *  - Daish sliding vs pure-rolling critical friction transition mu_c
 *  - Backspin check & spin-back ("zip") reversal on firm greens!
 *  - Cross-axis sidespin kick on bounce
 */
export function resolveCompliantTurfBounce(
  velIn: Vec3,
  omegaIn: Vec3,
  surfaceNormal: Vec3,
  surface: SurfaceType,
  greenStimpFeet = 11.2
): BounceResult {
  const props = getSurfaceProperties(surface, greenStimpFeet);
  const n = v3Norm(surfaceNormal);

  // Decompose incoming velocity into normal (toward surface) and tangential components
  const vn = v3Dot(velIn, n); // < 0 when moving into terrain
  const impactNormalSpeed = -vn;
  const vNormalVec = v3Scale(n, vn);
  const vTangentialVec = v3Sub(velIn, vNormalVec);
  const vtMag = v3Len(vTangentialVec);
  const totalSpeed = v3Len(velIn);

  if (impactNormalSpeed <= 0) {
    return {
      vel: { ...velIn },
      omega: { ...omegaIn },
      transitionToRoll: false,
      stoppedInSand: false,
      impactSpeedMps: 0,
    };
  }

  // Bunker plug / sand trap physics: steep high-speed impacts plug or stop within inches
  if (props.stopsImmediatelyInSand && impactNormalSpeed > 3.2) {
    // Small forward/upward sand skip if landing shallow, zero bounce if steep
    const shallowRatio = Math.max(0, Math.min(0.28, vtMag / (impactNormalSpeed * 6.5)));
    const tHat = vtMag > 1e-4 ? v3Scale(vTangentialVec, 1 / vtMag) : { x: 0, y: 0, z: 0 };
    const pluggedVel = v3Add(
      v3Scale(tHat, vtMag * shallowRatio),
      v3Scale(n, impactNormalSpeed * 0.08)
    );
    return {
      vel: pluggedVel,
      omega: v3Scale(omegaIn, 0.12),
      transitionToRoll: vtMag * shallowRatio < 1.2,
      stoppedInSand: impactNormalSpeed > 8.5 && vtMag < impactNormalSpeed * 0.85,
      impactSpeedMps: totalSpeed,
    };
  }

  // Establish local tangent frame: tFwd along incoming tangential velocity, tSide = tFwd x n
  const tFwd =
    vtMag > 1e-4
      ? v3Scale(vTangentialVec, 1 / vtMag)
      : v3Norm(
          Math.abs(n.z) < 0.9
            ? v3Cross({ x: 0, y: 0, z: -1 }, n)
            : v3Cross({ x: 1, y: 0, z: 0 }, n)
        );
  const tSide = v3Norm(v3Cross(tFwd, n)); // Points right of tFwd

  // Spin components in local impact frame:
  // Backspin points along +tSide (since tSide x tFwd = n => positive around tSide lifts / checks)
  const omegaBack = v3Dot(omegaIn, tSide);
  const omegaSide = v3Dot(omegaIn, n); // vertical/normal spin -> side kick
  const omegaRollSide = v3Dot(omegaIn, tFwd); // spiral spin

  // Penner Eq (8): turf compliance tilt angle theta_c
  const impactAngleDeg = Math.atan2(vtMag, Math.max(0.05, impactNormalSpeed)) * RAD_TO_DEG;
  const thetaCDeg = Math.min(
    24.0,
    props.turfComplianceAngleDeg * (totalSpeed / 18.6) * (impactAngleDeg / 44.4)
  );
  const thetaC = thetaCDeg * DEG_TO_RAD;
  const cosT = Math.cos(thetaC);
  const sinT = Math.sin(thetaC);

  // Penner Eq (6a, 6b): transform to compliant equivalent rigid surface x'-y'
  const vixPrime = vtMag * cosT - impactNormalSpeed * sinT;
  const absViyPrime = Math.max(0.05, vtMag * sinT + impactNormalSpeed * cosT);

  // Penner Eq (5a, 5b): velocity-dependent restitution e(|viy'|)
  const clampedVy = Math.min(20, absViyPrime);
  let cor =
    props.baseCor - 0.0375 * clampedVy + 0.000903 * clampedVy * clampedVy;
  cor = Math.max(0.08, Math.min(props.baseCor, cor));
  if (absViyPrime > 20) {
    cor = Math.max(0.08, props.baseCor * 0.24);
  }

  // Penner Eq (4): critical kinetic friction mu_c required to reach pure roll during collision
  const muC =
    (2 * (vixPrime + BALL_RADIUS_M * omegaBack)) /
    (7 * (1 + cor) * absViyPrime);

  let vrxPrime: number;
  let omegaBackOut: number;
  const vryPrime = cor * absViyPrime;

  if (props.kineticFriction >= Math.abs(muC)) {
    // Penner Eq (3a, 3c): enters pure rolling during collision -> backspin can reverse bounce!
    vrxPrime = (5 / 7) * vixPrime - (2 / 7) * BALL_RADIUS_M * omegaBack;
    omegaBackOut = -vrxPrime / BALL_RADIUS_M;
  } else {
    // Penner Eq (2a, 2c): slides throughout impact
    const signSlide = vixPrime + BALL_RADIUS_M * omegaBack >= 0 ? 1 : -1;
    vrxPrime = vixPrime - signSlide * props.kineticFriction * absViyPrime * (1 + cor);
    omegaBackOut =
      omegaBack -
      signSlide *
        ((5 * props.kineticFriction) / (2 * BALL_RADIUS_M)) *
        absViyPrime *
        (1 + cor);
  }

  // Penner Eq (7a, 7b): transform back to terrain frame
  const vrx = vrxPrime * cosT - vryPrime * sinT;
  const vry = Math.max(0.02, vrxPrime * sinT + vryPrime * cosT);

  // Sideways velocity kick from slice/hook sidespin (omegaSide) & spiral spin (omegaRollSide)
  const sideImpulse =
    -omegaSide * BALL_RADIUS_M * Math.min(0.32, props.kineticFriction * 0.45) -
    omegaRollSide * BALL_RADIUS_M * 0.08;

  const velOut = v3Add(
    v3Add(v3Scale(tFwd, vrx), v3Scale(n, vry)),
    v3Scale(tSide, sideImpulse)
  );

  // Reconstruct 3D post-bounce angular velocity
  const spinDamp = 1 - props.bounceSpinDamping;
  const omegaOut = v3Add(
    v3Add(v3Scale(tSide, omegaBackOut), v3Scale(n, omegaSide * 0.45)),
    v3Scale(tFwd, omegaRollSide * spinDamp)
  );

  const transitionToRoll = vry < 0.34 && impactNormalSpeed < 1.25;

  return {
    vel: velOut,
    omega: omegaOut,
    transitionToRoll,
    stoppedInSand: false,
    impactSpeedMps: totalSpeed,
  };
}

export interface RollStepResult {
  pos: Vec3;
  vel: Vec3;
  omega: Vec3;
  stopped: boolean;
  holed: boolean;
  lipOutEvent: boolean;
  hitPin: boolean;
  becameAirborne: boolean;
}

/**
 * Advances one rolling step on terrain manifold (Stimpmeter rolling resistance + 5/7 slope gravity + cup lip physics).
 */
export function stepRollingOnTurf(
  pos: Vec3,
  vel: Vec3,
  terrainHeightFn: (x: number, z: number) => number,
  terrainNormalFn: (x: number, z: number) => Vec3,
  surfaceFn: (x: number, z: number) => SurfaceType,
  cupPos: Vec3 | null,
  flagstickInCup: boolean,
  dt: number,
  greenStimpFeet = 11.2
): RollStepResult {
  const n = v3Norm(terrainNormalFn(pos.x, pos.z));
  const surface = surfaceFn(pos.x, pos.z);
  const props = getSurfaceProperties(surface, greenStimpFeet);

  // Project velocity onto tangent plane
  const vDotN = v3Dot(vel, n);
  let vt = v3Sub(vel, v3Scale(n, vDotN));
  const speed = v3Len(vt);

  // Gravitational acceleration projected along surface tangent plane (5/7 factor for solid rolling sphere!)
  const gravVec: Vec3 = { x: 0, y: -GRAVITY, z: 0 };
  const gravDotN = v3Dot(gravVec, n);
  const gravTangent = v3Sub(gravVec, v3Scale(n, gravDotN));
  const slopeAccel = v3Scale(gravTangent, 5 / 7);

  // Rolling friction deceleration magnitude: a_roll = (5/7) * rho_g * g * cos(slopeAngle)
  const cosSlope = Math.max(0.1, n.y);
  const frictionDecelMag = (5 / 7) * props.rollingResistanceRho * GRAVITY * cosSlope;

  let lipOutEvent = false;
  let hitPin = false;

  // Check if static friction holds the ball at rest when speed is tiny
  const slopeAccelMag = v3Len(slopeAccel);
  if (speed < 0.042) {
    if (slopeAccelMag <= frictionDecelMag * 1.15) {
      // Ball comes completely to rest on slope
      const restY = terrainHeightFn(pos.x, pos.z) + BALL_RADIUS_M;
      return {
        pos: { x: pos.x, y: restY, z: pos.z },
        vel: { x: 0, y: 0, z: 0 },
        omega: { x: 0, y: 0, z: 0 },
        stopped: true,
        holed: false,
        lipOutEvent: false,
        hitPin: false,
        becameAirborne: false,
      };
    }
  }

  // Apply slope acceleration + rolling friction opposing motion
  let netAccel = { ...slopeAccel };
  if (speed > 1e-4) {
    const vDir = v3Scale(vt, 1 / speed);
    netAccel = v3Sub(netAccel, v3Scale(vDir, frictionDecelMag));
  }

  let nextVt = v3Add(vt, v3Scale(netAccel, dt));

  // Prevent friction from reversing velocity direction across zero on flat ground
  if (speed > 1e-4 && v3Dot(nextVt, vt) < 0 && slopeAccelMag < frictionDecelMag) {
    nextVt = { x: 0, y: 0, z: 0 };
  }

  let nextPos = v3Add(pos, v3Scale(v3Add(vt, nextVt), 0.5 * dt));

  // Check flagstick collision & USGA regulation cup capture / lip-out
  if (cupPos) {
    const dx = nextPos.x - cupPos.x;
    const dz = nextPos.z - cupPos.z;
    const radialDist = Math.hypot(dx, dz);
    const nextSpeed = v3Len(nextVt);

    // Flagstick collision if pin is in cup
    if (flagstickInCup && radialDist < BALL_RADIUS_M + FLAGSTICK_RADIUS_M) {
      const normalPin = radialDist > 1e-5 ? { x: dx / radialDist, y: 0, z: dz / radialDist } : { x: 1, y: 0, z: 0 };
      const vnPin = v3Dot(nextVt, normalPin);
      if (vnPin < 0) {
        hitPin = true;
        // Restitution off fiberglass pin ~0.48
        nextVt = v3Sub(nextVt, v3Scale(normalPin, 1.48 * vnPin));
        if (v3Len(nextVt) < 1.85 && radialDist < CUP_RADIUS_M) {
          // Drops straight down into cup off the flagstick!
          return {
            pos: { x: cupPos.x, y: cupPos.y - CUP_DEPTH_M * 0.65, z: cupPos.z },
            vel: { x: 0, y: 0, z: 0 },
            omega: { x: 0, y: 0, z: 0 },
            stopped: true,
            holed: true,
            lipOutEvent: false,
            hitPin: true,
            becameAirborne: false,
          };
        }
      }
    }

    // Cup rim physics (effective capture radius depends on ball speed & center offset)
    if (radialDist < CUP_RADIUS_M + BALL_RADIUS_M * 0.25) {
      const radialDir = radialDist > 1e-6 ? { x: dx / radialDist, y: 0, z: dz / radialDist } : { x: 1, y: 0, z: 0 };
      // Tangential component around the rim
      const tangDir = { x: -radialDir.z, y: 0, z: radialDir.x };
      const vRad = v3Dot(nextVt, radialDir);
      const vTang = v3Dot(nextVt, tangDir);

      // Inside cup capture threshold (USGA: max speed to drop at center ~2.05 m/s; edge catch drops slower)
      const edgeFraction = Math.min(1, radialDist / CUP_RADIUS_M);
      const maxCaptureSpeed = 2.05 * (1 - 0.58 * edgeFraction * edgeFraction);

      if (radialDist < CUP_RADIUS_M * 0.88 && nextSpeed <= maxCaptureSpeed) {
        return {
          pos: { x: cupPos.x, y: cupPos.y - CUP_DEPTH_M * 0.65, z: cupPos.z },
          vel: { x: 0, y: 0, z: 0 },
          omega: { x: 0, y: 0, z: 0 },
          stopped: true,
          holed: true,
          lipOutEvent: false,
          hitPin,
          becameAirborne: false,
        };
      }

      // Lip-out / cup rim deflection! Ball curves toward center then slingshots out if too fast
      if (radialDist < CUP_RADIUS_M && Math.abs(vTang) > 0.35) {
        lipOutEvent = true;
        // Pull gently inward then deflect around rim curvature
        const inwardPull = -2.8 * (1 - edgeFraction * 0.4);
        nextVt = v3Add(
          v3Scale(radialDir, vRad * 0.65 + inwardPull * dt),
          v3Scale(tangDir, vTang * 0.92)
        );
      }
    }
  }

  // Constrain to analytical surface height
  const groundY = terrainHeightFn(nextPos.x, nextPos.z);
  const nextN = v3Norm(terrainNormalFn(nextPos.x, nextPos.z));
  // Check if ball launches over a steep lip / ridge crest (centripetal speed exceeds gravity normal component)
  const vSpeed = v3Len(nextVt);
  const becameAirborne = vSpeed > 5.5 && v3Dot(nextVt, nextN) > 0.35;

  nextPos.y = groundY + BALL_RADIUS_M;

  // Rolling angular velocity: omega = (n x v) / r  -> wait: check sign!
  // Check: when moving forward along -Z with n = +Y, top moves forward (-Z), bottom stationary -> right-hand thumb points -X!
  // Let's check (+Y) x (-Z) = -X! EXACT!
  const rollOmega = v3Scale(v3Cross(nextN, nextVt), 1 / BALL_RADIUS_M);

  return {
    pos: nextPos,
    vel: nextVt,
    omega: rollOmega,
    stopped: false,
    holed: false,
    lipOutEvent,
    hitPin,
    becameAirborne,
  };
}
