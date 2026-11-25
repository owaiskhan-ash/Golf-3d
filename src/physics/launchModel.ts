import type { ClubSpec } from './clubs';
import {
  BALL_MASS_KG,
  DEG_TO_RAD,
  MPH_TO_MPS,
  MPS_TO_MPH,
  RADPS_TO_RPM,
  RAD_TO_DEG,
  RPM_TO_RADPS,
} from './constants';
import type { Vec3 } from './aerodynamics';
import { v3Cross, v3Dot, v3Norm, v3Scale } from './aerodynamics';
import { getSurfaceProperties, type SurfaceType } from './surfaces';

export interface SwingParameters {
  club: ClubSpec;
  aimYawRad: number;           // Target line azimuth in XZ (0 = -Z, +PI/2 = +X)
  powerRatio: number;          // 0.05..1.15 fraction of player's full Tour swing speed
  clubPathDeg: number;         // -10..+10 deg (+ = in-to-out / right of target)
  faceAngleDeg: number;        // -10..+10 deg (+ = open / right of target)
  attackAngleDeg: number;      // -10..+6 deg (+ = hitting up, - = descending blow)
  dynamicLoftDeltaDeg: number; // -8..+12 deg adjustment to static loft (delofting/opening face)
  strikeOffsetXMm: number;     // -15..+15 mm (+ = toe, - = heel)
  strikeOffsetYMm: number;     // -12..+12 mm (+ = high on face, - = thin/low)
  surface: SurfaceType;
  terrainNormal: Vec3;         // Unit normal of ground under the ball
}

export interface LaunchTelemetry {
  clubSpeedMph: number;
  ballSpeedMph: number;
  smashFactor: number;
  launchAngleDeg: number;
  launchDirectionDeg: number; // Relative to aimYawRad (+ = right, - = left)
  dynamicLoftDeg: number;
  spinLoftDeg: number;
  totalSpinRpm: number;
  backSpinRpm: number;
  sideSpinRpm: number;        // + = fade/slice, - = draw/hook
  spinAxisDeg: number;        // + = tilted right (fade/slice), - = left (draw/hook)
  initialVelocity: Vec3;
  initialOmega: Vec3;
  isPutt: boolean;
}

/**
 * Computes 3D D-Plane launch vector, ball speed (COR + spin loft + sweet-spot loss),
 * and 3D spin vector (spin loft + face-to-path + bulge/roll gear effect + turf lie).
 */
export function computeClubImpactLaunch(params: SwingParameters): LaunchTelemetry {
  const { club, aimYawRad, powerRatio, surface, terrainNormal } = params;
  const surfProps = getSurfaceProperties(surface);

  // Unit target horizontal vector and rightward vector in world XZ
  const targetFwd: Vec3 = {
    x: Math.sin(aimYawRad),
    y: 0,
    z: -Math.cos(aimYawRad),
  };
  const worldUp: Vec3 = { x: 0, y: 1, z: 0 };
  const targetRight = v3Norm(v3Cross(targetFwd, worldUp)); // (+X when aimYawRad=0)

  // Compute terrain slope effects relative to target line:
  // uphillSlopeRad > 0 when ball sits on an upslope (normal tilts backward toward -targetFwd)
  const normalBack = -v3Dot(terrainNormal, targetFwd);
  const normalSide = v3Dot(terrainNormal, targetRight); // > 0 when ball is below feet (slope falls right)
  const lieUphillDeg = Math.asin(Math.max(-0.5, Math.min(0.5, normalBack))) * RAD_TO_DEG;
  const lieSidehillDeg = Math.asin(Math.max(-0.5, Math.min(0.5, normalSide))) * RAD_TO_DEG;

  // Special case: Putting
  if (club.category === 'putter') {
    // Power 1.0 corresponds to ~9.0 mph putter head speed (~14.4 mph ball speed -> ~65 ft putt on Stimp 11)
    // Scale non-linearly so gentle touch putts (power 0.1..0.4) have fine distance control
    const maxPutterHeadMph = 9.5;
    const clubHeadSpeedMph = maxPutterHeadMph * Math.pow(Math.max(0.02, powerRatio), 1.12);
    const clubHeadSpeedMps = clubHeadSpeedMph * MPH_TO_MPS;
    const headMassKg = club.headMassGrams / 1000;
    const smash = (1 + club.cor) / (1 + BALL_MASS_KG / headMassKg);
    const ballSpeedMps = clubHeadSpeedMps * smash * surfProps.launchSpeedFactor;

    const puttStartDirDeg = params.faceAngleDeg * 0.9 + params.clubPathDeg * 0.1;
    const launchYaw = aimYawRad + puttStartDirDeg * DEG_TO_RAD;

    // Slight loft hop ~2 deg so ball settles quickly to pure roll
    const launchElevRad = 1.5 * DEG_TO_RAD;
    const initialVelocity: Vec3 = {
      x: Math.sin(launchYaw) * Math.cos(launchElevRad) * ballSpeedMps,
      y: Math.sin(launchElevRad) * ballSpeedMps,
      z: -Math.cos(launchYaw) * Math.cos(launchElevRad) * ballSpeedMps,
    };

    // Slight forward overspin + minuscule side gear
    const forwardRollOmega = (ballSpeedMps / 0.021335) * 0.45;
    const dirFwd = { x: Math.sin(launchYaw), y: 0, z: -Math.cos(launchYaw) };
    const dirRight = v3Cross(dirFwd, worldUp);
    const initialOmega = v3Scale(dirRight, -forwardRollOmega); // negative around dirRight = topspin!

    return {
      clubSpeedMph: clubHeadSpeedMph,
      ballSpeedMph: ballSpeedMps * MPS_TO_MPH,
      smashFactor: ballSpeedMps / Math.max(0.01, clubHeadSpeedMps),
      launchAngleDeg: 1.5,
      launchDirectionDeg: puttStartDirDeg,
      dynamicLoftDeg: club.loftDeg,
      spinLoftDeg: 2.0,
      totalSpinRpm: forwardRollOmega * RADPS_TO_RPM,
      backSpinRpm: -forwardRollOmega * RADPS_TO_RPM,
      sideSpinRpm: 0,
      spinAxisDeg: 0,
      initialVelocity,
      initialOmega,
      isPutt: true,
    };
  }

  // Full / Partial Swing Physics
  const clampedPower = Math.max(0.12, Math.min(1.15, powerRatio));
  const clubSpeedMph = club.tourClubSpeedMph * clampedPower;
  const clubSpeedMps = clubSpeedMph * MPH_TO_MPS;

  // Vertical roll effect on driver/woods from high/low face contact
  const strikeYInches = params.strikeOffsetYMm / 25.4;
  const strikeXInches = params.strikeOffsetXMm / 25.4;
  const rollLoftChangeDeg = (strikeYInches / club.rollRadiusInches) * RAD_TO_DEG;
  const bulgeFaceChangeDeg = (strikeXInches / club.gearRadiusInches) * RAD_TO_DEG;

  // Dynamic loft starts from Tour dynamic delivery (accounts for natural forward shaft lean)
  // adjusted by player's manual loft/deloft, roll curvature, lie slope, and turf cushion
  const rawDynamicLoft =
    club.tourDynamicLoftDeg +
    params.dynamicLoftDeltaDeg +
    rollLoftChangeDeg +
    lieUphillDeg * 0.65 +
    surfProps.launchLoftPenaltyDeg;
  const dynamicLoftDeg = Math.max(4.5, Math.min(72.0, rawDynamicLoft));

  // Effective face angle (sidehill lie aims slightly downslope due to effective lie tilt)
  const sidehillAimShiftDeg = lieSidehillDeg * Math.tan(dynamicLoftDeg * DEG_TO_RAD) * 0.45;
  const effectiveFaceDeg = params.faceAngleDeg + bulgeFaceChangeDeg + sidehillAimShiftDeg;
  const faceToPathDeg = effectiveFaceDeg - params.clubPathDeg;

  const attackAngleDeg = params.attackAngleDeg + lieUphillDeg * 0.35;

  // 3D Spin Loft (angle between club velocity vector and clubface normal)
  const verticalSpinLoftDeg = Math.max(3.5, dynamicLoftDeg - attackAngleDeg);
  const spinLoftDeg = Math.hypot(verticalSpinLoftDeg, faceToPathDeg);

  // Off-center strike smash loss (12% drop at 15 mm miss; softer on forgiving woods/irons)
  const offCenterDistMm = Math.hypot(params.strikeOffsetXMm, params.strikeOffsetYMm);
  const sweetSpotEff = Math.max(0.76, 1.0 - 0.00055 * offCenterDistMm * offCenterDistMm);

  // Penner / USGA Momentum Transfer + Spin Loft cosine loss
  const headMassKg = club.headMassGrams / 1000;
  // Energy transfer drops smoothly as spin loft grows (mirrors TrackMan driver 1.49 -> 7I 1.34 -> PW 1.24 -> LW 1.06)
  const cosSl = Math.cos(Math.min(68, spinLoftDeg) * DEG_TO_RAD);
  const loftSpeedFactor = 0.56 * cosSl + 0.44 * Math.sqrt(Math.max(0.15, cosSl));
  const rawSmash =
    ((1 + club.cor) / (1 + BALL_MASS_KG / headMassKg)) *
    loftSpeedFactor *
    sweetSpotEff;

  const ballSpeedMps = clubSpeedMps * rawSmash * surfProps.launchSpeedFactor;

  // Jorgensen D-Plane Launch Angles (calibrated across low-loft woods through 60° lob wedges)
  const propFactor = Math.max(0.56, 0.90 - 0.0046 * spinLoftDeg);
  const launchAngleDeg = Math.max(
    2.0,
    Math.min(60.0, attackAngleDeg + verticalSpinLoftDeg * propFactor)
  );

  // Horizontal starting direction: ~85% face angle + 15% path (80/20 on woods)
  const faceWeight = club.category === 'wood' ? 0.80 : 0.85;
  const launchDirectionDeg =
    effectiveFaceDeg * faceWeight + params.clubPathDeg * (1 - faceWeight);

  // Total Spin Rate (RPM):
  // Calibrated against TrackMan Tour averages:
  // Driver (~10° SL -> 2650 rpm), 7I (~29.7° SL -> 7050 rpm), PW (~40.2° SL -> 9300 rpm), LW (~51.8° SL -> 10400 rpm)
  const slRad = spinLoftDeg * DEG_TO_RAD;
  const baseSpinRpm =
    142 *
    clubSpeedMph *
    Math.sin(slRad) *
    Math.pow(Math.max(0.25, Math.cos(slRad)), 0.25) *
    club.spinFactorScale *
    sweetSpotEff;

  // High-face strike lowers driver spin ("knuckle/low-spin hot spot"), low-face adds spin
  const verticalGearSpinRpm =
    club.category === 'wood' ? -params.strikeOffsetYMm * 45 : -params.strikeOffsetYMm * 18;

  const totalSpinRpm = Math.max(
    450,
    (baseSpinRpm + verticalGearSpinRpm) * surfProps.launchSpinFactor
  );

  // Spin Axis Tilt (degrees, + = fade/slice, - = draw/hook)
  // Geometric D-Plane spin axis tilt: atan2(sin(faceToPath), sin(verticalSpinLoft))
  const geometricTiltDeg =
    Math.atan2(
      Math.sin(faceToPathDeg * DEG_TO_RAD),
      Math.sin(Math.max(5.5, verticalSpinLoftDeg) * DEG_TO_RAD)
    ) * RAD_TO_DEG;

  // Horizontal Gear Effect (off-center toe/heel strike on woods & hybrids):
  // Toe strike (+X mm) rotates wood head clockwise around CoM -> imparts LEFT/draw gear spin (- side spin)!
  const gearFactor = club.category === 'wood' ? 0.55 : club.category === 'hybrid' ? 0.3 : 0.08;
  const gearAxisShiftDeg = -params.strikeOffsetXMm * gearFactor;

  const spinAxisDeg = Math.max(-48, Math.min(48, geometricTiltDeg + gearAxisShiftDeg));
  const spinAxisRad = spinAxisDeg * DEG_TO_RAD;

  const backSpinRpm = totalSpinRpm * Math.cos(spinAxisRad);
  const sideSpinRpm = totalSpinRpm * Math.sin(spinAxisRad);

  // Construct 3D initial velocity vector in world space
  const launchYaw = aimYawRad + launchDirectionDeg * DEG_TO_RAD;
  const launchElev = launchAngleDeg * DEG_TO_RAD;

  const launchDir: Vec3 = {
    x: Math.sin(launchYaw) * Math.cos(launchElev),
    y: Math.sin(launchElev),
    z: -Math.cos(launchYaw) * Math.cos(launchElev),
  };
  const initialVelocity = v3Scale(launchDir, ballSpeedMps);

  // Construct 3D spin vector orthogonal to launchDir:
  // spinRight points RIGHT of trajectory (pure backspin axis -> spinRight x launchDir = UP)
  // spinUp points perpendicular UP in trajectory plane (-spinUp x launchDir = RIGHT fade)
  const spinRight = v3Norm(v3Cross(launchDir, worldUp));
  const spinUp = v3Norm(v3Cross(spinRight, launchDir));

  const omegaMag = totalSpinRpm * RPM_TO_RADPS;
  const omegaDir = {
    x: spinRight.x * Math.cos(spinAxisRad) - spinUp.x * Math.sin(spinAxisRad),
    y: spinRight.y * Math.cos(spinAxisRad) - spinUp.y * Math.sin(spinAxisRad),
    z: spinRight.z * Math.cos(spinAxisRad) - spinUp.z * Math.sin(spinAxisRad),
  };
  const initialOmega = v3Scale(omegaDir, omegaMag);

  return {
    clubSpeedMph,
    ballSpeedMph: ballSpeedMps * MPS_TO_MPH,
    smashFactor: ballSpeedMps / Math.max(0.01, clubSpeedMps),
    launchAngleDeg,
    launchDirectionDeg,
    dynamicLoftDeg,
    spinLoftDeg,
    totalSpinRpm,
    backSpinRpm,
    sideSpinRpm,
    spinAxisDeg,
    initialVelocity,
    initialOmega,
    isPutt: false,
  };
}
