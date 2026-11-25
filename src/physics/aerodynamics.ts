import {
  AIR_KINEMATIC_VISCOSITY,
  BALL_CROSS_AREA_M2,
  BALL_DIAMETER_M,
  BALL_MASS_KG,
  BALL_RADIUS_M,
  COASTAL_STANDARD_ATMOSPHERE,
  GRAVITY,
  computeAirDensity,
  type AtmosphereConditions,
} from './constants';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function v3Add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function v3Sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function v3Scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function v3Dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function v3Cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function v3LenSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function v3Len(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function v3Norm(a: Vec3): Vec3 {
  const len = Math.hypot(a.x, a.y, a.z);
  if (len < 1e-10) return { x: 0, y: 0, z: 0 };
  const inv = 1 / len;
  return { x: a.x * inv, y: a.y * inv, z: a.z * inv };
}

export interface WindField {
  speedMps: number;      // Wind speed at 10 m reference height (m/s)
  directionRad: number;  // Direction wind is BLOWING TOWARD in XZ plane (0 = -Z forward, +PI/2 = +X right)
  gustiness: number;     // 0..1 turbulence amplitude
}

/**
 * Logarithmic atmospheric boundary layer wind profile + subtle coastal gusting.
 * Wind speed decreases near turf (z0 = 0.03 m) and rises slightly over exposed cliff heights.
 */
export function sampleWindAt(
  pos: Vec3,
  wind: WindField,
  groundHeightY: number,
  timeS: number
): Vec3 {
  if (wind.speedMps < 0.01) return { x: 0, y: 0, z: 0 };
  const heightAboveGround = Math.max(0.15, pos.y - groundHeightY);
  // Log wind profile normalized to 10 m reference height, z0 = 0.035 m
  const z0 = 0.035;
  const shear = Math.log(heightAboveGround / z0 + 1) / Math.log(10 / z0 + 1);
  const gustiness = wind.gustiness ?? 0;
  const gust =
    1 +
    gustiness *
      0.12 *
      Math.sin(timeS * 0.85 + pos.x * 0.03 + pos.z * 0.025);
  const effSpeed = wind.speedMps * Math.min(1.22, Math.max(0.32, shear)) * gust;

  return {
    x: Math.sin(wind.directionRad) * effSpeed,
    y: 0,
    z: -Math.cos(wind.directionRad) * effSpeed,
  };
}

/**
 * Dimpled golf ball drag coefficient C_D(Re, S).
 * Incorporates boundary-layer drag crisis from wind-tunnel measurements
 * (Bearman & Harvey 1976; Smits & Smith; Choi et al. 2006) plus spin-induced drag.
 */
export function computeDragCoefficient(reynolds: number, spinRatio: number): number {
  // Smooth sigmoid drop across critical Reynolds regime (Re ~ 4.5e4 -> 1.15e5)
  const reNorm = (reynolds - 6.8e4) / 1.4e4;
  const crisisBlend = 1 / (1 + Math.exp(-reNorm));
  // Laminar sub-critical ~0.47 -> supercritical dimple minimum ~0.214
  let cd0 = 0.47 - 0.256 * crisisBlend;
  // Slight gradual rise at very high Re (> 1.4e5)
  if (reynolds > 1.4e5) {
    cd0 += Math.min(0.025, (reynolds - 1.4e5) * 2.2e-7);
  }
  // Spin-induced drag increase (Bearman & Harvey / Bridgestone US5935023A)
  const cdSpin = 0.16 * Math.min(0.6, spinRatio);
  return cd0 + cdSpin;
}

/**
 * Dimpled golf ball lift coefficient C_L(S) via Bearman & Harvey saturation model,
 * calibrated against wind tunnel measurements for S in [0.04, 0.45].
 */
export function computeLiftCoefficient(spinRatio: number, reynolds: number): number {
  if (spinRatio <= 1e-6) return 0;
  const s = Math.min(0.65, spinRatio);
  // Slight low-Re attenuation below drag crisis
  const reScale = reynolds < 5.5e4 ? 0.65 + 0.35 * (reynolds / 5.5e4) : 1.0;
  return reScale * ((0.68 * s) / (0.30 + s));
}

export interface AeroState {
  pos: Vec3;
  vel: Vec3;
  omega: Vec3; // rad/s world space spin vector
  timeS: number;
}

export interface AeroForceBreakdown {
  dragN: Vec3;
  magnusN: Vec3;
  gravityN: Vec3;
  cd: number;
  cl: number;
  spinRatio: number;
  airSpeedMps: number;
}

export function computeAerodynamicAcceleration(
  _pos: Vec3,
  vel: Vec3,
  omega: Vec3,
  windVec: Vec3,
  airDensity: number
): { accel: Vec3; breakdown: AeroForceBreakdown } {
  const vRel = v3Sub(vel, windVec);
  const speed = v3Len(vRel);

  const gravForce = { x: 0, y: -BALL_MASS_KG * GRAVITY, z: 0 };

  if (speed < 1e-4) {
    return {
      accel: { x: 0, y: -GRAVITY, z: 0 },
      breakdown: {
        dragN: v3(),
        magnusN: v3(),
        gravityN: gravForce,
        cd: 0,
        cl: 0,
        spinRatio: 0,
        airSpeedMps: 0,
      },
    };
  }

  const omegaMag = v3Len(omega);
  const reynolds = (speed * BALL_DIAMETER_M) / AIR_KINEMATIC_VISCOSITY;
  const spinRatio = (BALL_RADIUS_M * omegaMag) / speed;

  const cd = computeDragCoefficient(reynolds, spinRatio);
  const cl = computeLiftCoefficient(spinRatio, reynolds);

  const dynFactor = 0.5 * airDensity * BALL_CROSS_AREA_M2 * speed;

  // F_D = -0.5 * rho * A * C_D * |v_rel| * v_rel
  const dragForce = v3Scale(vRel, -dynFactor * cd);

  // F_M = 0.5 * rho * A * C_L * |v_rel|^2 * (omega_hat x v_rel_hat)
  //     = 0.5 * rho * A * C_L * |v_rel| * (omega_hat x v_rel)
  let magnusForce = v3();
  if (omegaMag > 1e-4) {
    const omegaHat = v3Scale(omega, 1 / omegaMag);
    const cross = v3Cross(omegaHat, vRel);
    magnusForce = v3Scale(cross, dynFactor * cl);
  }

  const totalForce = v3Add(gravForce, v3Add(dragForce, magnusForce));
  const invMass = 1 / BALL_MASS_KG;

  return {
    accel: v3Scale(totalForce, invMass),
    breakdown: {
      dragN: dragForce,
      magnusN: magnusForce,
      gravityN: gravForce,
      cd,
      cl,
      spinRatio,
      airSpeedMps: speed,
    },
  };
}

/**
 * Advances one 4th-order Runge-Kutta (RK4) flight step of duration dt,
 * including Tavares / Smits aerodynamic spin decay.
 */
export function stepFlightRK4(
  state: AeroState,
  dt: number,
  wind: WindField,
  groundHeightY: number,
  atmosphere: AtmosphereConditions = COASTAL_STANDARD_ATMOSPHERE
): { next: AeroState; breakdown: AeroForceBreakdown } {
  const rho = computeAirDensity(atmosphere, Math.max(0, state.pos.y));
  const windMid = sampleWindAt(state.pos, wind, groundHeightY, state.timeS);

  const { accel: a1, breakdown } = computeAerodynamicAcceleration(
    state.pos,
    state.vel,
    state.omega,
    windMid,
    rho
  );
  const k1p = state.vel;
  const k1v = a1;

  const p2 = v3Add(state.pos, v3Scale(k1p, dt * 0.5));
  const v2 = v3Add(state.vel, v3Scale(k1v, dt * 0.5));
  const k2p = v2;
  const k2v = computeAerodynamicAcceleration(p2, v2, state.omega, windMid, rho).accel;

  const p3 = v3Add(state.pos, v3Scale(k2p, dt * 0.5));
  const v3Vel = v3Add(state.vel, v3Scale(k2v, dt * 0.5));
  const k3p = v3Vel;
  const k3v = computeAerodynamicAcceleration(p3, v3Vel, state.omega, windMid, rho).accel;

  const p4 = v3Add(state.pos, v3Scale(k3p, dt));
  const v4 = v3Add(state.vel, v3Scale(k3v, dt));
  const k4p = v4;
  const k4v = computeAerodynamicAcceleration(p4, v4, state.omega, windMid, rho).accel;

  const nextPos = {
    x: state.pos.x + (dt / 6) * (k1p.x + 2 * k2p.x + 2 * k3p.x + k4p.x),
    y: state.pos.y + (dt / 6) * (k1p.y + 2 * k2p.y + 2 * k3p.y + k4p.y),
    z: state.pos.z + (dt / 6) * (k1p.z + 2 * k2p.z + 2 * k3p.z + k4p.z),
  };

  const nextVel = {
    x: state.vel.x + (dt / 6) * (k1v.x + 2 * k2v.x + 2 * k3v.x + k4v.x),
    y: state.vel.y + (dt / 6) * (k1v.y + 2 * k2v.y + 2 * k3v.y + k4v.y),
    z: state.vel.z + (dt / 6) * (k1v.z + 2 * k2v.z + 2 * k3v.z + k4v.z),
  };

  // Aerodynamic torque spin decay (Tavares et al. / Smits & Smith): tau ~ 20s at 45 m/s
  const speedRel = v3Len(v3Sub(state.vel, windMid));
  const decayRate = 0.0145 * (0.4 + 0.6 * (speedRel / 45));
  const spinScale = Math.exp(-decayRate * dt);
  const nextOmega = v3Scale(state.omega, spinScale);

  return {
    next: {
      pos: nextPos,
      vel: nextVel,
      omega: nextOmega,
      timeS: state.timeS + dt,
    },
    breakdown,
  };
}
