// USGA / R&A Regulation Golf Ball & Cup Constants + Atmospheric Physics

export const GRAVITY = 9.80665; // m/s^2

export const BALL_MASS_KG = 0.04593; // USGA max 1.620 oz
export const BALL_DIAMETER_M = 0.04267; // USGA min 1.680 in
export const BALL_RADIUS_M = BALL_DIAMETER_M * 0.5; // 0.021335 m
export const BALL_CROSS_AREA_M2 = Math.PI * BALL_RADIUS_M * BALL_RADIUS_M; // ~0.00143003 m^2
export const BALL_MOMENT_OF_INERTIA = 0.4 * BALL_MASS_KG * BALL_RADIUS_M * BALL_RADIUS_M; // (2/5) m r^2

export const CUP_RADIUS_M = 0.053975; // USGA 4.25 inches diameter -> 0.053975 m radius
export const CUP_DEPTH_M = 0.105; // >= 4 inches standard cup depth
export const FLAGSTICK_RADIUS_M = 0.0095; // ~19 mm diameter tapered fiberglass pin

export const AIR_KINEMATIC_VISCOSITY = 1.48e-5; // m^2/s at ~15°C

// Unit Conversions
export const M_TO_YARDS = 1.0936132983;
export const YARDS_TO_M = 0.9144;
export const M_TO_FEET = 3.280839895;
export const FEET_TO_M = 0.3048;
export const MPH_TO_MPS = 0.44704;
export const MPS_TO_MPH = 2.236936292;
export const RPM_TO_RADPS = (Math.PI * 2) / 60;
export const RADPS_TO_RPM = 60 / (Math.PI * 2);
export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

export interface AtmosphereConditions {
  temperatureC: number;
  pressureHpa: number;
  altitudeM: number;
  humidityPct: number; // 0-100
}

export const COASTAL_STANDARD_ATMOSPHERE: AtmosphereConditions = {
  temperatureC: 16.5, // ~62°F coastal Monterey Peninsula
  pressureHpa: 1014.5,
  altitudeM: 18,
  humidityPct: 72,
};

/**
 * Computes humid air density (kg/m^3) from temperature, pressure, altitude, and relative humidity
 * using Magnus-Tetens saturation vapor pressure and ideal gas law for moist air.
 */
export function computeAirDensity(
  conditions: AtmosphereConditions = COASTAL_STANDARD_ATMOSPHERE,
  localElevationM = 0
): number {
  const totalAlt = Math.max(0, conditions.altitudeM + localElevationM);
  const T_K = conditions.temperatureC + 273.15;
  const pAtAltHpa =
    conditions.pressureHpa * Math.pow(1 - 2.25577e-5 * totalAlt, 5.25588);

  // Saturation vapor pressure in hPa (Tetens formula)
  const esHpa =
    6.1078 *
    Math.exp((17.27 * conditions.temperatureC) / (conditions.temperatureC + 237.3));
  const pvPa = (conditions.humidityPct / 100) * esHpa * 100;
  const pdPa = Math.max(1000, pAtAltHpa * 100 - pvPa);

  const Rd = 287.058;
  const Rv = 461.495;
  return pdPa / (Rd * T_K) + pvPa / (Rv * T_K);
}
