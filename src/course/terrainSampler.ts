import type { Vec3 } from '../physics/aerodynamics';
import { BALL_RADIUS_M, CUP_RADIUS_M } from '../physics/constants';
import type { TerrainQuery } from '../physics/simulation';
import type { SurfaceType } from '../physics/surfaces';
import {
  clamp,
  distanceToPolyline,
  fbm2D,
  lerp,
  ridgedFbm2D,
  signedDistOrganicEllipse,
  smootherstep,
  smoothstep,
} from './noise';
import type { DifficultyMode, HoleDefinition } from './types';

export interface SurfaceSample {
  height: number;
  surface: SurfaceType;
  fairwayBlend: number;
  greenBlend: number;
  fringeBlend: number;
  bunkerBlend: number;
  teeBlend: number;
  roughBlend: number;
  cliffBlend: number;
  pathBlend: number;
}

export class HoleTerrainSampler implements TerrainQuery {
  public readonly hole: HoleDefinition;
  public cupPosition: Vec3;
  public flagstickInCup = true;
  public greenStimpFeet: number;
  public difficulty: DifficultyMode = 'pro';

  constructor(hole: HoleDefinition, difficulty: DifficultyMode = 'pro') {
    this.hole = hole;
    this.difficulty = difficulty;
    this.greenStimpFeet = this.computeStimpForDifficulty(hole.green.stimpFeet, difficulty);
    this.cupPosition = this.computeCupForDifficulty(difficulty);
  }

  private computeStimpForDifficulty(baseStimp: number, diff: DifficultyMode): number {
    if (diff === 'amateur') return Math.max(8.5, baseStimp - 0.5);
    if (diff === 'tour') return Math.min(12.2, baseStimp + 2.2);
    return Math.min(10.8, baseStimp + 0.8);
  }

  private computeCupForDifficulty(diff: DifficultyMode): Vec3 {
    const g = this.hole.green;
    let ox = g.cupOffsetX;
    let oz = g.cupOffsetZ;
    if (diff === 'tour' && !this.hole.isDrivingRange) {
      if (g.sundayCupOffsetX !== undefined && g.sundayCupOffsetZ !== undefined) {
        ox = g.sundayCupOffsetX;
        oz = g.sundayCupOffsetZ;
      } else {
        // Tuck pin closer to front/side edge inside safe green margin
        const angle = (this.hole.holeNumber * 1.9) % (Math.PI * 2);
        ox = Math.cos(angle) * Math.min(g.rx * 0.48, Math.abs(g.cupOffsetX) + 3.6);
        oz = Math.sin(angle) * Math.min(g.rz * 0.46, Math.abs(g.cupOffsetZ) + 3.8);
      }
    }
    const cx = g.cx + ox;
    const cz = g.cz + oz;
    return {
      x: cx,
      y: this.getHeight(cx, cz),
      z: cz,
    };
  }

  public setDifficulty(diff: DifficultyMode): void {
    this.difficulty = diff;
    this.greenStimpFeet = this.computeStimpForDifficulty(this.hole.green.stimpFeet, diff);
    this.cupPosition = this.computeCupForDifficulty(diff);
  }

  public getSurfaceSample(x: number, z: number): SurfaceSample {
    const hole = this.hole;
    const coastDist = hole.coastlineSignedDist(x, z);

    // 1. Base coastal landform
    let height = hole.baseLandElevation(x, z);

    // 2. Tee box sculpting (flat rectangular pad with neat mowed collar)
    const tdx = x - hole.tee.cx;
    const tdz = z - hole.tee.cz;
    const cosT = Math.cos(hole.tee.yawRad);
    const sinT = Math.sin(hole.tee.yawRad);
    const tlx = Math.abs(tdx * cosT + tdz * sinT);
    const tlz = Math.abs(-tdx * sinT + tdz * cosT);
    const teeEdgeDist = Math.max(tlx - hole.tee.halfW, tlz - hole.tee.halfL);
    const teeBlend = 1 - smoothstep(-0.3, 0.8, teeEdgeDist);
    const teePadBlend = 1 - smoothstep(-0.5, 2.8, teeEdgeDist);
    height = lerp(height, hole.tee.elevation, teePadBlend);

    // 3. Fairway spline sculpting
    let bestFairwayDist = Infinity;
    let fairwayElev = height;
    for (const spline of hole.fairwaySplines) {
      const sample = distanceToPolyline(x, z, spline);
      const signed = sample.dist - sample.widthAtT;
      if (signed < bestFairwayDist) {
        bestFairwayDist = signed;
        // Interpolate elevation along spline
        const idxF = sample.t * (spline.length - 1);
        const i0 = Math.floor(idxF);
        const i1 = Math.min(spline.length - 1, i0 + 1);
        fairwayElev = lerp(spline[i0].elevation, spline[i1].elevation, idxF - i0);
      }
    }
    const fairwaySculptBlend = 1 - smoothstep(-2.0, 9.5, bestFairwayDist);
    // Add gentle links fairway crown/undulation
    const fairwayMicro = 0.28 * fbm2D(x * 0.045, z * 0.045, 2, 2.0, 0.5, 515);
    height = lerp(height, fairwayElev + fairwayMicro, fairwaySculptBlend * 0.82);

    const fairwayMask = 1 - smoothstep(-0.4, 0.7, bestFairwayDist);
    const roughCorridorMask =
      1 - smoothstep(0.0, hole.roughCorridorHalfWidthExtra, bestFairwayDist);

    // 4. Putting Green complex + Fringe collar + Contours
    const g = hole.green;
    const greenSigned = signedDistOrganicEllipse(
      x,
      z,
      g.cx,
      g.cz,
      g.rx,
      g.rz,
      g.rotRad,
      g.lobeAmp,
      g.lobeSeed
    );
    const greenPadSculpt = 1 - smoothstep(0.25, 7.5, greenSigned);
    const gxRel = x - g.cx;
    const gzRel = z - g.cz;
    // Authentic architectural contours: plane slope + gentle tiering waves
    const tierWave =
      g.ridgeAmp *
      Math.sin(gzRel * g.ridgeFreq + 0.6 * Math.cos(gxRel * g.ridgeFreq * 0.85)) *
      smoothstep(1.5, -2.5, greenSigned);
    const greenContourHeight =
      g.baseElevation + gxRel * g.tiltX + gzRel * g.tiltZ + tierWave;
    height = lerp(height, greenContourHeight, greenPadSculpt);

    const greenMask = 1 - smoothstep(-0.22, 0.22, greenSigned);
    const fringeOuterMask = 1 - smoothstep(1.3, 1.9, greenSigned);
    const fringeMask = Math.max(0, fringeOuterMask - greenMask);

    // Extra target green pads on Driving Range
    let extraGreenMask = 0;
    if (hole.extraTargets) {
      for (const tgt of hole.extraTargets) {
        if (Math.hypot(tgt.x - g.cx, tgt.z - g.cz) < 5) continue;
        const d = Math.hypot(x - tgt.x, z - tgt.z) - 8.5;
        if (d < 4) {
          const pad = 1 - smoothstep(-0.5, 4.0, d);
          height = lerp(height, hole.baseLandElevation(tgt.x, tgt.z) + 0.25, pad);
          extraGreenMask = Math.max(extraGreenMask, 1 - smoothstep(-0.25, 0.25, d));
        }
      }
    }

    // 5. Sculpted Coastal Bunkers (sunken sand basin + raised lip brow)
    let bunkerMask = 0;
    for (const b of hole.bunkers) {
      const bd = signedDistOrganicEllipse(
        x,
        z,
        b.cx,
        b.cz,
        b.rx,
        b.rz,
        b.rotRad,
        0.1,
        b.lobeSeed
      );
      if (bd < 5.5) {
        const insideSand = 1 - smoothstep(-1.1, 0.2, bd);
        const bowlDepth = b.depth * (1 - smoothstep(-b.rx * 0.75, 0.35, bd));
        // Raised grassy lip/brow on the target side
        const dirToPtX = x - b.cx;
        const dirToPtZ = z - b.cz;
        const distPt = Math.hypot(dirToPtX, dirToPtZ) || 1;
        const lipAlign = clamp(
          (dirToPtX * Math.sin(b.lipDirRad) - dirToPtZ * Math.cos(b.lipDirRad)) / distPt,
          -1,
          1
        );
        const browRing = smoothstep(-0.3, 1.4, bd) * (1 - smoothstep(1.4, 5.2, bd));
        const browRaise =
          b.lipHeight * browRing * Math.max(0, 0.35 + 0.65 * lipAlign) * (1 - greenMask * 0.85);

        // Subtle wind-swept sand ripple micro-relief inside basin
        const ripple = insideSand * 0.04 * Math.sin((x + z) * 2.5);
        height = height - bowlDepth + browRaise + ripple;
        bunkerMask = Math.max(bunkerMask, 1 - smoothstep(-0.25, 0.25, bd));
      }
    }

    // 6. Cart Path
    let pathMask = 0;
    if (hole.cartPath) {
      const pSample = distanceToPolyline(x, z, hole.cartPath);
      const pSigned = pSample.dist - pSample.widthAtT;
      pathMask = 1 - smoothstep(-0.18, 0.25, pSigned);
    }

    // 7. Coastal Cliff Drop-off & Underwater Ocean Shelf
    // For coastDist > 12m: normal golf terrain; coastDist in [0, 12m]: craggy brow transitioning to cliff;
    // coastDist < 0: sheer stratified cliff plunging to seabed (-4.5m).
    // Protect the actual putting green surface from craggy noise / bunker lip overhang so greens stay puttable!
    const cliffNoise = ridgedFbm2D(x * 0.065, z * 0.065, 3, 999);
    const cliffDropT = smootherstep(10.5, -13.5, coastDist);
    const seabedElev = -4.2 - 1.5 * cliffNoise;
    const greenProtect = 1 - smoothstep(0.15, 2.4, greenSigned);
    const craggyEdge =
      smoothstep(11.0, 2.0, coastDist) *
      (1 - smoothstep(-3.0, -14.0, coastDist)) *
      (cliffNoise * 2.8 - 1.1) *
      (1 - greenProtect);
    height = lerp(height, seabedElev, cliffDropT) + craggyEdge;
    if (greenSigned < 1.8 && coastDist > -2.0) {
      height = lerp(height, greenContourHeight, greenProtect * (bunkerMask < 0.5 ? 1.0 : 1 - bunkerMask));
    }

    // 8. Retaining Stone Sea-Wall on Hole 3 (if applicable)
    if (hole.seawallSegments) {
      for (const seg of hole.seawallSegments) {
        const dx = seg.x2 - seg.x1;
        const dz = seg.z2 - seg.z1;
        const lenSq = dx * dx + dz * dz || 1;
        const t = clamp(((x - seg.x1) * dx + (z - seg.z1) * dz) / lenSq, 0, 1);
        const px = seg.x1 + dx * t;
        const pz = seg.z1 + dz * t;
        const dWall = Math.hypot(x - px, z - pz);
        if (dWall < 2.2) {
          const wallBlend = 1 - smoothstep(0.6, 2.2, dWall);
          height = lerp(height, seg.topElevation, wallBlend);
        }
      }
    }

    // Determine dominant discrete physics surface
    const cliffMask = smoothstep(5.5, -1.5, coastDist);
    let surface: SurfaceType = 'heavy_rough';

    if (height <= 0.12 || coastDist < -6.5) {
      surface = 'water';
    } else if (cliffMask > 0.55) {
      surface = 'cliff_rock';
    } else if (bunkerMask > 0.5) {
      surface = 'bunker';
    } else if (greenMask > 0.5 || extraGreenMask > 0.5) {
      surface = 'green';
    } else if (fringeMask > 0.45) {
      surface = 'fringe';
    } else if (teeBlend > 0.5) {
      surface = 'tee';
    } else if (pathMask > 0.5) {
      surface = 'cart_path';
    } else if (fairwayMask > 0.5) {
      surface = 'fairway';
    } else if (roughCorridorMask > 0.4) {
      surface = 'rough';
    }

    const totalGreen = Math.max(greenMask, extraGreenMask);
    const roughBlend = clamp(
      1 - Math.max(totalGreen, fringeMask, fairwayMask, teeBlend, bunkerMask, cliffMask, pathMask),
      0,
      1
    );

    return {
      height,
      surface,
      fairwayBlend: fairwayMask,
      greenBlend: totalGreen,
      fringeBlend: fringeMask,
      bunkerBlend: bunkerMask,
      teeBlend,
      roughBlend,
      cliffBlend: cliffMask,
      pathBlend: pathMask,
    };
  }

  public getHeight = (x: number, z: number): number => {
    return this.getSurfaceSample(x, z).height;
  };

  public getSurface = (x: number, z: number): SurfaceType => {
    return this.getSurfaceSample(x, z).surface;
  };

  public getNormal = (x: number, z: number): Vec3 => {
    const eps = 0.14;
    const hL = this.getHeight(x - eps, z);
    const hR = this.getHeight(x + eps, z);
    const hD = this.getHeight(x, z - eps);
    const hU = this.getHeight(x, z + eps);
    const nx = hL - hR;
    const ny = 2 * eps;
    const nz = hD - hU;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  };

  public getTeeBallPosition(): Vec3 {
    const x = this.hole.tee.cx;
    const z = this.hole.tee.cz;
    return {
      x,
      y: this.getHeight(x, z) + BALL_RADIUS_M,
      z,
    };
  }

  public isInCup(pos: Vec3): boolean {
    const d = Math.hypot(pos.x - this.cupPosition.x, pos.z - this.cupPosition.z);
    return d < CUP_RADIUS_M && pos.y < this.cupPosition.y + 0.01;
  }

  public getSlopePercent(
    x: number,
    z: number,
    aimYawRad = 0
  ): { slopePct: number; uphillPct: number; sidePct: number } {
    const n = this.getNormal(x, z);
    const horiz = Math.hypot(n.x, n.z);
    const slopePct = (horiz / Math.max(0.1, n.y)) * 100;
    const fwdX = Math.sin(aimYawRad);
    const fwdZ = -Math.cos(aimYawRad);
    const rightX = Math.cos(aimYawRad);
    const rightZ = Math.sin(aimYawRad);
    // Terrain climbs along fwd when normal tilts against fwd
    const uphillPct = -(n.x * fwdX + n.z * fwdZ) * 100;
    // Positive = ground higher on left (ball above feet for RH golfer); negative = ball below feet
    const sidePct = (n.x * rightX + n.z * rightZ) * 100;
    return { slopePct, uphillPct, sidePct };
  }
}
