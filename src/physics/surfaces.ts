export type SurfaceType =
  | 'tee'
  | 'fairway'
  | 'fringe'
  | 'green'
  | 'rough'
  | 'heavy_rough'
  | 'bunker'
  | 'cliff_rock'
  | 'cart_path'
  | 'water';

export interface SurfacePhysicsProperties {
  type: SurfaceType;
  label: string;
  // Lie penalty applied at launch (speed & spin multipliers)
  launchSpeedFactor: number;
  launchSpinFactor: number;
  launchLoftPenaltyDeg: number; // Rough pushes grass between face & ball, lowering launch slightly or causing fliers
  // Penner compliant turf bounce parameters
  baseCor: number;              // Normal restitution baseline at zero speed
  kineticFriction: number;      // Sliding friction mu during bounce
  turfComplianceAngleDeg: number; // Penner theta_c0 at 18.6 m/s, 44.4 deg
  bounceSpinDamping: number;    // Additional tangential cushion
  // Rolling friction (Penner rho_g: a = -(5/7) * rho_g * g)
  rollingResistanceRho: number;
  stopsImmediatelyInSand: boolean;
  isHazard: boolean;
}

/**
 * Computes rolling resistance rho_g for a putting green from USGA Stimpmeter speed (feet).
 * Based on Penner (2002) & USGA Stimpmeter exit velocity V_g = 1.83 m/s:
 * D_ft * 0.3048 = (7/10) * V_g^2 / (rho_g * g)  =>  rho_g = (7 * 1.83^2) / (10 * 9.80665 * D_m)
 * Check: Stimp 10 ft (3.048 m) => rho_g = 23.442 / 298.91 = 0.0784 (Penner's "medium-fast" green!).
 */
export function stimpFeetToRollingRho(stimpFeet: number): number {
  const distM = Math.max(1.2, stimpFeet * 0.3048);
  const vStimp = 1.83; // USGA standardized Stimpmeter release velocity (m/s)
  return (7 * vStimp * vStimp) / (10 * 9.80665 * distM);
}

export function getSurfaceProperties(
  type: SurfaceType,
  greenStimpFeet = 11.2
): SurfacePhysicsProperties {
  const greenRho = stimpFeetToRollingRho(greenStimpFeet);

  switch (type) {
    case 'tee':
      return {
        type,
        label: 'Tee Box',
        launchSpeedFactor: 1.0,
        launchSpinFactor: 1.0,
        launchLoftPenaltyDeg: 0,
        baseCor: 0.50,
        kineticFriction: 0.44,
        turfComplianceAngleDeg: 14.0,
        bounceSpinDamping: 0.08,
        rollingResistanceRho: 0.24,
        stopsImmediatelyInSand: false,
        isHazard: false,
      };
    case 'fairway':
      return {
        type,
        label: 'Fairway',
        launchSpeedFactor: 0.985,
        launchSpinFactor: 0.99,
        launchLoftPenaltyDeg: 0,
        baseCor: 0.50, // Balanced coastal links turf
        kineticFriction: 0.45,
        turfComplianceAngleDeg: 13.5,
        bounceSpinDamping: 0.08,
        rollingResistanceRho: 0.21,
        stopsImmediatelyInSand: false,
        isHazard: false,
      };
    case 'fringe':
      return {
        type,
        label: 'Green Collar',
        launchSpeedFactor: 0.96,
        launchSpinFactor: 0.92,
        launchLoftPenaltyDeg: 0.3,
        baseCor: 0.45,
        kineticFriction: 0.50,
        turfComplianceAngleDeg: 14.5,
        bounceSpinDamping: 0.12,
        rollingResistanceRho: greenRho * 1.95,
        stopsImmediatelyInSand: false,
        isHazard: false,
      };
    case 'green':
      return {
        type,
        label: 'Putting Green',
        launchSpeedFactor: 0.99,
        launchSpinFactor: 1.0,
        launchLoftPenaltyDeg: 0,
        baseCor: 0.43,
        kineticFriction: 0.54,
        turfComplianceAngleDeg: 15.2,
        bounceSpinDamping: 0.12,
        rollingResistanceRho: greenRho,
        stopsImmediatelyInSand: false,
        isHazard: false,
      };
    case 'rough':
      return {
        type,
        label: 'Coastal Rough',
        launchSpeedFactor: 0.87,
        launchSpinFactor: 0.66, // Grass trapped between clubface & ball -> lower spin "flier"
        launchLoftPenaltyDeg: 1.4,
        baseCor: 0.34,
        kineticFriction: 0.55,
        turfComplianceAngleDeg: 18.5,
        bounceSpinDamping: 0.28,
        rollingResistanceRho: 0.52,
        stopsImmediatelyInSand: false,
        isHazard: false,
      };
    case 'heavy_rough':
      return {
        type,
        label: 'Deep Fescue',
        launchSpeedFactor: 0.72,
        launchSpinFactor: 0.48,
        launchLoftPenaltyDeg: 2.5,
        baseCor: 0.24,
        kineticFriction: 0.65,
        turfComplianceAngleDeg: 21.0,
        bounceSpinDamping: 0.45,
        rollingResistanceRho: 0.88,
        stopsImmediatelyInSand: false,
        isHazard: false,
      };
    case 'bunker':
      return {
        type,
        label: 'Greenside Bunker',
        launchSpeedFactor: 0.68, // Sand cushions impact unless hit cleanly with SW
        launchSpinFactor: 0.85,
        launchLoftPenaltyDeg: 4.5, // Explosion shot pops higher with open wedge
        baseCor: 0.11,
        kineticFriction: 0.78,
        turfComplianceAngleDeg: 24.0,
        bounceSpinDamping: 0.75,
        rollingResistanceRho: 2.4,
        stopsImmediatelyInSand: true,
        isHazard: false,
      };
    case 'cliff_rock':
      return {
        type,
        label: 'Coastal Cliff',
        launchSpeedFactor: 0.75,
        launchSpinFactor: 0.65,
        launchLoftPenaltyDeg: 0,
        baseCor: 0.72,
        kineticFriction: 0.35,
        turfComplianceAngleDeg: 1.0,
        bounceSpinDamping: 0.02,
        rollingResistanceRho: 0.28,
        stopsImmediatelyInSand: false,
        isHazard: false,
      };
    case 'cart_path':
      return {
        type,
        label: 'Gravel / Stone Path',
        launchSpeedFactor: 0.95,
        launchSpinFactor: 0.90,
        launchLoftPenaltyDeg: 0,
        baseCor: 0.78,
        kineticFriction: 0.25,
        turfComplianceAngleDeg: 0.5,
        bounceSpinDamping: 0.02,
        rollingResistanceRho: 0.12,
        stopsImmediatelyInSand: false,
        isHazard: false,
      };
    case 'water':
      return {
        type,
        label: 'Pacific Ocean',
        launchSpeedFactor: 0,
        launchSpinFactor: 0,
        launchLoftPenaltyDeg: 0,
        baseCor: 0,
        kineticFriction: 0,
        turfComplianceAngleDeg: 0,
        bounceSpinDamping: 1,
        rollingResistanceRho: 5,
        stopsImmediatelyInSand: true,
        isHazard: true,
      };
  }
}
