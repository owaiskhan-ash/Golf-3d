import { describe, expect, it } from 'vitest';
import { getClubById, SHOT_TYPE_PRESETS } from '../clubs';
import { resolveFlightObstacles } from '../collisions';
import { COURSE_HOLES } from '../../course/courseData';
import { HoleTerrainSampler } from '../../course/terrainSampler';
import { BALL_RADIUS_M, COASTAL_STANDARD_ATMOSPHERE, M_TO_FEET, M_TO_YARDS } from '../constants';
import { simulateFullShot, type TerrainQuery } from '../simulation';
import { stepRollingOnTurf } from '../bounceAndRoll';
import type { Vec3, WindField } from '../aerodynamics';
import type { SurfaceType } from '../surfaces';

function makeFlatTerrain(
  surface: SurfaceType = 'fairway',
  stimpFeet = 11.2,
  cupPos: Vec3 | null = null,
  slopeZ = 0,
  slopeX = 0
): TerrainQuery {
  return {
    getHeight: (x: number, z: number) => 20 + x * slopeX + z * slopeZ,
    getNormal: () => {
      const len = Math.hypot(-slopeX, 1, -slopeZ);
      return { x: -slopeX / len, y: 1 / len, z: -slopeZ / len };
    },
    getSurface: () => surface,
    cupPosition: cupPos,
    flagstickInCup: false,
    greenStimpFeet: stimpFeet,
  };
}

const CALM_WIND: WindField = { speedMps: 0, directionRad: 0, gustiness: 0 };

describe('TrackMan PGA Tour Aerodynamics & Launch Validation', () => {
  it('Driver matches PGA Tour carry (~275-290 yds), ball speed (~170 mph), and spin (~2400-2900 rpm)', () => {
    const driver = getClubById('DR');
    const terrain = makeFlatTerrain('fairway');
    const res = simulateFullShot(
      { x: 0, y: 20 + BALL_RADIUS_M, z: 0 },
      {
        club: driver,
        aimYawRad: 0,
        powerRatio: 1.0,
        clubPathDeg: 0,
        faceAngleDeg: 0,
        attackAngleDeg: driver.tourAttackAngleDeg,
        dynamicLoftDeltaDeg: 0,
        strikeOffsetXMm: 0,
        strikeOffsetYMm: 0,
        surface: 'tee',
        terrainNormal: { x: 0, y: 1, z: 0 },
      },
      CALM_WIND,
      terrain,
      COASTAL_STANDARD_ATMOSPHERE
    );

    expect(res.launch.ballSpeedMph).toBeGreaterThan(166);
    expect(res.launch.ballSpeedMph).toBeLessThan(176);
    expect(res.launch.smashFactor).toBeGreaterThan(1.45);
    expect(res.launch.smashFactor).toBeLessThan(1.52);
    expect(res.launch.totalSpinRpm).toBeGreaterThan(2200);
    expect(res.launch.totalSpinRpm).toBeLessThan(3100);
    expect(res.carryDistanceYds).toBeGreaterThan(272);
    expect(res.carryDistanceYds).toBeLessThan(296);
    expect(res.totalDistanceYds).toBeGreaterThan(res.carryDistanceYds + 10);
  });

  it('Mid-iron (7I) and Wedge (PW) match TrackMan Tour carry & spin windows', () => {
    const terrain = makeFlatTerrain('fairway');
    const iron7 = getClubById('7I');
    const res7 = simulateFullShot(
      { x: 0, y: 20 + BALL_RADIUS_M, z: 0 },
      {
        club: iron7,
        aimYawRad: 0,
        powerRatio: 1.0,
        clubPathDeg: 0,
        faceAngleDeg: 0,
        attackAngleDeg: iron7.tourAttackAngleDeg,
        dynamicLoftDeltaDeg: 0,
        strikeOffsetXMm: 0,
        strikeOffsetYMm: 0,
        surface: 'fairway',
        terrainNormal: { x: 0, y: 1, z: 0 },
      },
      CALM_WIND,
      terrain
    );
    expect(res7.carryDistanceYds).toBeGreaterThan(165);
    expect(res7.carryDistanceYds).toBeLessThan(188);
    expect(res7.launch.totalSpinRpm).toBeGreaterThan(6000);
    expect(res7.launch.totalSpinRpm).toBeLessThan(8000);

    const pw = getClubById('PW');
    const resPW = simulateFullShot(
      { x: 0, y: 20 + BALL_RADIUS_M, z: 0 },
      {
        club: pw,
        aimYawRad: 0,
        powerRatio: 1.0,
        clubPathDeg: 0,
        faceAngleDeg: 0,
        attackAngleDeg: pw.tourAttackAngleDeg,
        dynamicLoftDeltaDeg: 0,
        strikeOffsetXMm: 0,
        strikeOffsetYMm: 0,
        surface: 'fairway',
        terrainNormal: { x: 0, y: 1, z: 0 },
      },
      CALM_WIND,
      terrain
    );
    expect(resPW.carryDistanceYds).toBeGreaterThan(130);
    expect(resPW.carryDistanceYds).toBeLessThan(152);
    expect(resPW.launch.totalSpinRpm).toBeGreaterThan(8200);
  });

  it('D-Plane shot shaping produces authentic slices, draws, and toe gear effect', () => {
    const driver = getClubById('DR');
    const terrain = makeFlatTerrain('fairway');

    // Slice: open face (+3 deg) & out-to-in path (-4 deg) -> +7 deg face-to-path
    const slice = simulateFullShot(
      { x: 0, y: 20 + BALL_RADIUS_M, z: 0 },
      {
        club: driver,
        aimYawRad: 0,
        powerRatio: 1.0,
        clubPathDeg: -4.0,
        faceAngleDeg: 3.0,
        attackAngleDeg: 0,
        dynamicLoftDeltaDeg: 1.0,
        strikeOffsetXMm: 0,
        strikeOffsetYMm: 0,
        surface: 'tee',
        terrainNormal: { x: 0, y: 1, z: 0 },
      },
      CALM_WIND,
      terrain
    );
    expect(slice.launch.launchDirectionDeg).toBeGreaterThan(0);
    expect(slice.launch.spinAxisDeg).toBeGreaterThan(10);
    expect(slice.curveOfflineYds).toBeGreaterThan(18);

    // Tour draw: slightly closed face (-1) & in-to-out path (+4) -> -5 deg face-to-path
    const draw = simulateFullShot(
      { x: 0, y: 20 + BALL_RADIUS_M, z: 0 },
      {
        club: driver,
        aimYawRad: 0,
        powerRatio: 1.0,
        clubPathDeg: 4.0,
        faceAngleDeg: -1.0,
        attackAngleDeg: 1.5,
        dynamicLoftDeltaDeg: 0.5,
        strikeOffsetXMm: 0,
        strikeOffsetYMm: 0,
        surface: 'tee',
        terrainNormal: { x: 0, y: 1, z: 0 },
      },
      CALM_WIND,
      terrain
    );
    expect(draw.launch.spinAxisDeg).toBeLessThan(-8);
    expect(draw.curveOfflineYds).toBeLessThan(-10);
  });

  it('Wind physically alters carry and lateral drift (headwind vs tailwind vs crosswind)', () => {
    const iron7 = getClubById('7I');
    const terrain = makeFlatTerrain('fairway');
    const baseSwing = {
      club: iron7,
      aimYawRad: 0,
      powerRatio: 1.0,
      clubPathDeg: 0,
      faceAngleDeg: 0,
      attackAngleDeg: iron7.tourAttackAngleDeg,
      dynamicLoftDeltaDeg: -4.0,
      strikeOffsetXMm: 0,
      strikeOffsetYMm: 0,
      surface: 'fairway' as const,
      terrainNormal: { x: 0, y: 1, z: 0 },
    };

    const calm = simulateFullShot({ x: 0, y: 20 + BALL_RADIUS_M, z: 0 }, baseSwing, CALM_WIND, terrain);
    // Headwind blows toward +Z (directionRad = PI)
    const headwind = simulateFullShot(
      { x: 0, y: 20 + BALL_RADIUS_M, z: 0 },
      baseSwing,
      { speedMps: 9.0, directionRad: Math.PI, gustiness: 0 },
      terrain
    );
    // Tailwind blows toward -Z (directionRad = 0)
    const tailwind = simulateFullShot(
      { x: 0, y: 20 + BALL_RADIUS_M, z: 0 },
      baseSwing,
      { speedMps: 9.0, directionRad: 0, gustiness: 0 },
      terrain
    );
    // Crosswind blowing left-to-right (+X -> directionRad = +PI/2)
    const crosswind = simulateFullShot(
      { x: 0, y: 20 + BALL_RADIUS_M, z: 0 },
      baseSwing,
      { speedMps: 9.0, directionRad: Math.PI / 2, gustiness: 0 },
      terrain
    );

    expect(headwind.carryDistanceYds).toBeLessThan(calm.carryDistanceYds - 14);
    expect(tailwind.carryDistanceYds).toBeGreaterThan(calm.carryDistanceYds + 10);
    expect(crosswind.curveOfflineYds).toBeGreaterThan(10);
  });

  it('Penner bounce model produces backspin check/spin-back with Lob Wedge on firm green & stops in sand', () => {
    const lw = getClubById('LW');
    const greenTerrain = makeFlatTerrain('green', 11.2);
    const wedgeRes = simulateFullShot(
      { x: 0, y: 20 + BALL_RADIUS_M, z: 0 },
      {
        club: lw,
        aimYawRad: 0,
        powerRatio: 1.0,
        clubPathDeg: 0,
        faceAngleDeg: 0,
        attackAngleDeg: lw.tourAttackAngleDeg,
        dynamicLoftDeltaDeg: 0,
        strikeOffsetXMm: 0,
        strikeOffsetYMm: 0,
        surface: 'fairway',
        terrainNormal: { x: 0, y: 1, z: 0 },
      },
      CALM_WIND,
      greenTerrain
    );

    // Total distance should be <= carry distance + 1.0 yds (checks/zips back!)
    expect(wedgeRes.totalDistanceYds).toBeLessThanOrEqual(wedgeRes.carryDistanceYds + 1.0);

    const bunkerTerrain = makeFlatTerrain('bunker', 11.2);
    const bunkerRes = simulateFullShot(
      { x: 0, y: 20 + BALL_RADIUS_M, z: 0 },
      {
        club: getClubById('7I'),
        aimYawRad: 0,
        powerRatio: 1.0,
        clubPathDeg: 0,
        faceAngleDeg: 0,
        attackAngleDeg: -4.0,
        dynamicLoftDeltaDeg: -4.0,
        strikeOffsetXMm: 0,
        strikeOffsetYMm: 0,
        surface: 'fairway',
        terrainNormal: { x: 0, y: 1, z: 0 },
      },
      CALM_WIND,
      bunkerTerrain
    );
    expect(bunkerRes.totalDistanceYds - bunkerRes.carryDistanceYds).toBeLessThan(2.5);
  });

  it('Stimpmeter calibration: ball released at 1.83 m/s on Stimp 11.2 ft green rolls 11.2 ± 0.3 ft and breaks on slope', () => {
    const stimp = 11.2;
    const flatGreen = makeFlatTerrain('green', stimp);
    let pos: Vec3 = { x: 0, y: 20 + BALL_RADIUS_M, z: 0 };
    let vel: Vec3 = { x: 0, y: 0, z: -1.83 }; // USGA Stimpmeter exit speed

    for (let i = 0; i < 1500; i++) {
      const step = stepRollingOnTurf(
        pos,
        vel,
        flatGreen.getHeight,
        flatGreen.getNormal,
        flatGreen.getSurface,
        null,
        false,
        0.008,
        stimp
      );
      pos = step.pos;
      vel = step.vel;
      if (step.stopped) break;
    }

    const rolledFt = Math.abs(pos.z) * M_TO_FEET;
    expect(rolledFt).toBeGreaterThan(stimp - 0.35);
    expect(rolledFt).toBeLessThan(stimp + 0.35);

    // Side-sloped green (3% fall to +X) should break significantly right (+X)
    const slopedGreen = makeFlatTerrain('green', stimp, null, 0, -0.03);
    let sPos: Vec3 = { x: 0, y: 20 + BALL_RADIUS_M, z: 0 };
    let sVel: Vec3 = { x: 0, y: 0, z: -2.2 };
    for (let i = 0; i < 2000; i++) {
      const step = stepRollingOnTurf(
        sPos,
        sVel,
        slopedGreen.getHeight,
        slopedGreen.getNormal,
        slopedGreen.getSurface,
        null,
        false,
        0.008,
        stimp
      );
      sPos = step.pos;
      sVel = step.vel;
      if (step.stopped) break;
    }
    expect(sPos.x).toBeGreaterThan(0.25);
  });

  it('Cup capture drops well-paced putts while fast racing putts bypass or lip out', () => {
    const cupPos: Vec3 = { x: 0, y: 20, z: -3.0 };
    const green = makeFlatTerrain('green', 11.0, cupPos);

    // Good pace putt (~1.9 m/s should comfortably reach 3m and drop into cup)
    let pos: Vec3 = { x: 0.01, y: 20 + BALL_RADIUS_M, z: 0 };
    let vel: Vec3 = { x: 0, y: 0, z: -2.1 };
    let holed = false;
    for (let i = 0; i < 1500; i++) {
      const step = stepRollingOnTurf(
        pos,
        vel,
        green.getHeight,
        green.getNormal,
        green.getSurface,
        cupPos,
        false,
        0.005,
        11.0
      );
      pos = step.pos;
      vel = step.vel;
      if (step.holed) {
        holed = true;
        break;
      }
      if (step.stopped) break;
    }
    expect(holed).toBe(true);
    expect(Math.abs(pos.z - cupPos.z) * M_TO_YARDS).toBeLessThan(0.1);
  });

  it('resolveFlightObstacles handles trunk deflection, canopy drag, and airborne flagstick hits', () => {
    const hole = COURSE_HOLES[0];
    const sampler = new HoleTerrainSampler(hole, 'pro');
    const tree = hole.trees[0];
    const groundY = sampler.getHeight(tree.x, tree.z);

    // Ball flying straight into cypress trunk
    const trunkRes = resolveFlightObstacles(
      { x: tree.x, y: groundY + 1.4, z: tree.z },
      { x: 0, y: 0, z: -28 },
      { x: 0, y: 0, z: 0 },
      hole.trees,
      hole.seaRocks,
      (x, z) => sampler.getHeight(x, z),
      null,
      false,
      0
    );
    expect(trunkRes?.hit).toBe('trunk');
    expect(trunkRes!.vel.z).toBeGreaterThan(0);

    // Ball flying through cypress canopy
    const canopyRes = resolveFlightObstacles(
      { x: tree.x, y: groundY + tree.scale * 4.5, z: tree.z },
      { x: 0, y: -4, z: -30 },
      { x: 0, y: 20, z: 0 },
      hole.trees,
      hole.seaRocks,
      (x, z) => sampler.getHeight(x, z),
      null,
      false,
      0
    );
    expect(canopyRes?.hit).toBe('canopy');
    expect(Math.hypot(canopyRes!.vel.x, canopyRes!.vel.z)).toBeLessThan(20);

    // Airborne flagstick clink
    const cup = sampler.cupPosition;
    const pinRes = resolveFlightObstacles(
      { x: cup.x, y: cup.y + 1.1, z: cup.z },
      { x: 0, y: -2, z: -12 },
      { x: 0, y: 0, z: 0 },
      hole.trees,
      hole.seaRocks,
      (x, z) => sampler.getHeight(x, z),
      cup,
      true,
      0
    );
    expect(pinRes?.hit).toBe('flagstick');
    expect(pinRes!.vel.z).toBeGreaterThan(0);
  });

  it('SHOT_TYPE_PRESETS separates high Flop shots from low Punch shots', () => {
    const lw = getClubById('LW');
    const i7 = getClubById('7I');
    const flat = makeFlatTerrain('fairway');
    const flopPreset = SHOT_TYPE_PRESETS.find((s) => s.id === 'flop')!;
    const punchPreset = SHOT_TYPE_PRESETS.find((s) => s.id === 'punch')!;

    const flop = simulateFullShot(
      { x: 0, y: 20, z: 0 },
      {
        club: lw,
        aimYawRad: 0,
        powerRatio: flopPreset.defaultPowerPct / 100,
        clubPathDeg: 0,
        faceAngleDeg: 0,
        attackAngleDeg: lw.tourAttackAngleDeg + flopPreset.attackAngleDeltaDeg,
        dynamicLoftDeltaDeg: flopPreset.dynamicLoftDeltaDeg,
        strikeOffsetXMm: 0,
        strikeOffsetYMm: 0,
        surface: 'fairway',
        terrainNormal: { x: 0, y: 1, z: 0 },
      },
      CALM_WIND,
      flat,
      COASTAL_STANDARD_ATMOSPHERE
    );
    const punch = simulateFullShot(
      { x: 0, y: 20, z: 0 },
      {
        club: i7,
        aimYawRad: 0,
        powerRatio: punchPreset.defaultPowerPct / 100,
        clubPathDeg: 0,
        faceAngleDeg: 0,
        attackAngleDeg: i7.tourAttackAngleDeg + punchPreset.attackAngleDeltaDeg,
        dynamicLoftDeltaDeg: punchPreset.dynamicLoftDeltaDeg,
        strikeOffsetXMm: 0,
        strikeOffsetYMm: 0,
        surface: 'fairway',
        terrainNormal: { x: 0, y: 1, z: 0 },
      },
      CALM_WIND,
      flat,
      COASTAL_STANDARD_ATMOSPHERE
    );

    expect(flop.launch.launchAngleDeg).toBeGreaterThan(32);
    expect(punch.launch.launchAngleDeg).toBeLessThan(17);
    expect(punch.totalDistanceYds).toBeGreaterThan(flop.totalDistanceYds * 1.5);
  });

  it('All 9 championship holes and Driving Range have valid tee, Pro cup, and Tour Sunday pin surfaces', () => {
    expect(COURSE_HOLES).toHaveLength(10);
    const parSum = COURSE_HOLES.filter((h) => !h.isDrivingRange).reduce((s, h) => s + h.par, 0);
    expect(parSum).toBe(35);

    for (const h of COURSE_HOLES) {
      const proSampler = new HoleTerrainSampler(h, 'pro');
      expect(proSampler.getSurface(h.tee.cx, h.tee.cz)).toBe('tee');
      const proCup = proSampler.cupPosition;
      expect(proSampler.getSurface(proCup.x, proCup.z)).toBe('green');

      const tourSampler = new HoleTerrainSampler(h, 'tour');
      const tourCup = tourSampler.cupPosition;
      expect(tourSampler.getSurface(tourCup.x, tourCup.z)).toBe('green');
      if (!h.isDrivingRange) {
        expect(Math.hypot(tourCup.x - proCup.x, tourCup.z - proCup.z)).toBeGreaterThan(1.5);
      }
    }
  });
});

