import type { Vec3 } from '../physics/aerodynamics';

export interface SplineNode {
  x: number;
  z: number;
  halfWidth: number;
  elevation: number;
}

export interface BunkerDef {
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  rotRad: number;
  depth: number;       // Max basin depth below surrounding turf (m)
  lipHeight: number;   // Raised brow mound on target/front side (m)
  lipDirRad: number;   // Direction toward green/target where brow rises
  lobeSeed: number;
}

export type DifficultyMode = 'amateur' | 'pro' | 'tour';

export interface GreenContourDef {
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  rotRad: number;
  lobeAmp: number;
  lobeSeed: number;
  baseElevation: number;
  tiltX: number;       // Overall plane tilt along X (e.g. -0.025 = 2.5% slope down toward -X)
  tiltZ: number;       // Overall plane tilt along Z (e.g. +0.028 = front-to-back cant)
  ridgeAmp: number;    // Subtle links tiering / swales (m)
  ridgeFreq: number;
  cupOffsetX: number;  // Standard pin offset from green center (m)
  cupOffsetZ: number;
  sundayCupOffsetX?: number; // Tucked Tour pin placement offset from green center (m)
  sundayCupOffsetZ?: number;
  stimpFeet: number;
}

export interface TeeBoxDef {
  cx: number;
  cz: number;
  halfW: number;
  halfL: number;
  yawRad: number;
  elevation: number;
}

export interface CoastalTreeDef {
  x: number;
  z: number;
  scale: number;
  windBendRad: number;
  seed: number;
  species: 'cypress' | 'pine';
}

export interface SeaRockDef {
  x: number;
  z: number;
  radius: number;
  height: number;
  seed: number;
}

export interface TargetMarkerDef {
  x: number;
  z: number;
  label: string;
  yardage: number;
}

export interface HoleDefinition {
  id: string;
  holeNumber: number;
  name: string;
  subtitle: string;
  par: number;
  yardage: number;
  isDrivingRange?: boolean;
  bounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  defaultWindSpeedMph: number;
  defaultWindDirRad: number; // Direction blowing TOWARD in world XZ
  tee: TeeBoxDef;
  fairwaySplines: SplineNode[][];
  roughCorridorHalfWidthExtra: number; // How far mowed rough extends outside fairway
  bunkers: BunkerDef[];
  green: GreenContourDef;
  extraTargets?: TargetMarkerDef[]; // For Driving Range multi-flag targets
  cartPath?: Array<{ x: number; z: number; halfWidth: number }>;
  seawallSegments?: Array<{ x1: number; z1: number; x2: number; z2: number; topElevation: number }>;
  // Coastline function returns signed distance to land (>0 inland, <0 ocean water)
  coastlineSignedDist: (x: number, z: number) => number;
  // Base elevation field before fairway/green/bunker sculpting
  baseLandElevation: (x: number, z: number) => number;
  trees: CoastalTreeDef[];
  seaRocks: SeaRockDef[];
  cameraPreviewTarget: Vec3;
}
