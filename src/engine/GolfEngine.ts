import * as THREE from 'three';
import { COURSE_HOLES, getHoleById } from '../course/courseData';
import { HoleTerrainSampler } from '../course/terrainSampler';
import type { DifficultyMode, HoleDefinition } from '../course/types';
import { stepFlightRK4, v3Dot, v3Len, type Vec3, type WindField } from '../physics/aerodynamics';
import { resolveCompliantTurfBounce, stepRollingOnTurf } from '../physics/bounceAndRoll';
import { getClubById, type ClubSpec } from '../physics/clubs';
import { resolveFlightObstacles } from '../physics/collisions';
import {
  BALL_RADIUS_M,
  COASTAL_STANDARD_ATMOSPHERE,
  M_TO_YARDS,
  RAD_TO_DEG,
} from '../physics/constants';
import type { LaunchTelemetry, SwingParameters } from '../physics/launchModel';
import { simulateFullShot } from '../physics/simulation';
import type { SurfaceType } from '../physics/surfaces';
import { AudioSystem } from './AudioSystem';
import { CameraSystem, type CameraMode } from './CameraSystem';
import { FoliageSystem, type FoliageDensity } from './FoliageSystem';
import { ModelsSystem, type SwingAnimPhase } from './ModelsSystem';
import { OceanSystem } from './OceanSystem';
import { ParticleEffectsSystem } from './ParticleEffects';
import { PostProcessingPipeline, type GraphicsQuality } from './PostProcessing';
import { createCourseTextures, type CourseTextureSet } from './ProceduralTextures';
import {
  SkyAtmosphereSystem,
  TIME_OF_DAY_PRESETS,
  type TimeOfDayPreset,
} from './SkyAtmosphere';
import { TerrainMeshSystem } from './TerrainMesh';
import { VisualAidsSystem } from './VisualAids';

export type ShotPlayState = 'ready' | 'swinging' | 'ball_in_motion' | 'shot_complete' | 'holed_out' | 'replaying';

export interface HoleRoundMeta {
  fairwayHit: boolean | null; // null on Par 3 / Range
  greenInRegulation: boolean;
  putts: number;
}

export interface RangeSessionStats {
  shots: number;
  avgCarryYds: number;
  avgOfflineYds: number;
  bestToPinYds: number | null;
}

export interface ShotTelemetrySummary {
  clubName: string;
  clubSpeedMph: number;
  ballSpeedMph: number;
  smashFactor: number;
  launchAngleDeg: number;
  launchDirDeg: number;
  spinRpm: number;
  spinAxisDeg: number;
  carryYds: number;
  totalYds: number;
  apexFt: number;
  landingAngleDeg: number;
  curveOfflineYds: number;
  finalSurface: SurfaceType;
  holed: boolean;
  waterPenalty: boolean;
}

export interface EngineSnapshot {
  hole: HoleDefinition;
  holeIndex: number;
  difficulty: DifficultyMode;
  playState: ShotPlayState;
  ballPos: Vec3;
  cupPos: Vec3;
  distanceToPinYds: number;
  elevationToPinFt: number;
  lieSurface: SurfaceType;
  lieSlopePct: number;
  lieUphillPct: number;
  lieSidePct: number;
  strokesOnHole: number;
  holeMeta: HoleRoundMeta;
  wind: WindField;
  aimYawRad: number;
  selectedClub: ClubSpec;
  recommendedClubId: string;
  cameraMode: CameraMode;
  cameraOrbited: boolean;
  greenGridVisible: boolean;
  flagstickInCup: boolean;
  proTracerEnabled: boolean;
  canMulligan: boolean;
  canReplay: boolean;
  shotEventLabel: string | null;
  qualityLevel: GraphicsQuality;
  autoQualityNote: string | null;
  rangeStats: RangeSessionStats;
  lastTelemetry: ShotTelemetrySummary | null;
  liveBallStats: {
    speedMph: number;
    heightFt: number;
    distFromShotStartYds: number;
  } | null;
}

export class GolfEngine {
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly cameraSys: CameraSystem;
  public readonly textures: CourseTextureSet;
  public readonly skySys: SkyAtmosphereSystem;
  public readonly oceanSys: OceanSystem;
  public readonly terrainSys: TerrainMeshSystem;
  public readonly foliageSys: FoliageSystem;
  public readonly modelsSys: ModelsSystem;
  public readonly particles: ParticleEffectsSystem;
  public readonly visualAids: VisualAidsSystem;
  public readonly audio: AudioSystem;
  public readonly postProc: PostProcessingPipeline;

  public sampler!: HoleTerrainSampler;
  public hole!: HoleDefinition;
  public holeIndex = 0;

  public playState: ShotPlayState = 'ready';
  public ballPos: Vec3 = { x: 0, y: 20, z: 0 };
  public ballVel: Vec3 = { x: 0, y: 0, z: 0 };
  public ballOmega: Vec3 = { x: 0, y: 0, z: 0 };
  public lastSafePos: Vec3 = { x: 0, y: 20, z: 0 };
  public shotStartPos: Vec3 = { x: 0, y: 20, z: 0 };

  public wind: WindField = { speedMps: 4.5, directionRad: 0, gustiness: 0.35 };
  public aimYawRad = 0;
  public selectedClub: ClubSpec = getClubById('DR');
  public strokesOnHole = 0;
  public flagstickInCup = true;
  public greenGridVisible = false;
  public showAimPreview = true;
  public foliageDensity: FoliageDensity = 'high';
  public difficulty: DifficultyMode = 'pro';
  public qualityLevel: GraphicsQuality = 'ultra';
  public autoQualityEnabled = true;

  // Active shot simulation state
  private simMode: 'flight' | 'roll' = 'flight';
  private simTimeS = 0;
  private bounceCount = 0;
  private hasLanded = false;
  private apexY = 0;
  private landingPos: Vec3 = { x: 0, y: 0, z: 0 };
  private landingAngleDeg = 0;
  private currentLaunch: LaunchTelemetry | null = null;
  private waterPenaltyTriggered = false;
  private lastTelemetry: ShotTelemetrySummary | null = null;
  private canopyCooldownS = 0;
  private pinHitNotified = false;
  private lipOutNotified = false;
  private shotEventLabel: string | null = null;
  private shotEventTimerS = 0;
  private liveTracerPoints: Vec3[] = [];
  private holeMeta: HoleRoundMeta = { fairwayHit: null, greenInRegulation: false, putts: 0 };
  private rangeCarrySum = 0;
  private rangeOfflineSum = 0;
  private rangeShots = 0;
  private rangeBestPinYds: number | null = null;

  // Mulligan undo state + Instant Shot Replay frames
  private undoSnapshot: {
    ballPos: Vec3;
    lastSafePos: Vec3;
    strokesOnHole: number;
    aimYawRad: number;
    selectedClub: ClubSpec;
    holeMeta: HoleRoundMeta;
    lastTelemetry: ShotTelemetrySummary | null;
  } | null = null;

  private activeReplayFrames: Array<{ t: number; pos: Vec3; omega: Vec3 }> = [];
  private lastReplayData: {
    frames: Array<{ t: number; pos: Vec3; omega: Vec3 }>;
    startPos: Vec3;
    aimYawRad: number;
    club: ClubSpec;
    pathDeg: number;
    endState: 'ready' | 'holed_out';
    postBallPos: Vec3;
    postAimYawRad: number;
  } | null = null;
  private replayElapsedS = 0;

  // Auto FPS scaler + ambient gull timer
  private fpsWindowS = 0;
  private fpsFrames = 0;
  private autoQualityNote: string | null = null;
  private nextGullCallS = 14;

  // Golfer Swing & Walk-In Animation
  private animPhase: SwingAnimPhase = 'address';
  private animTimerS = 0;
  private walkInElapsedS = 0;
  private readonly walkInDurationS = 2.85;
  private pendingSwingParams: SwingParameters | null = null;
  private animPathDeg = 0;
  private shotFinishWaitTimer = 0;

  private clock = new THREE.Clock();
  private elapsedTimeS = 0;
  private physicsAccumS = 0;
  private prevBallPos: Vec3 = { x: 0, y: 20, z: 0 };
  private renderBallPos: Vec3 = { x: 0, y: 20, z: 0 };
  private rafId: number | null = null;
  private listeners = new Set<(snap: EngineSnapshot) => void>();
  private lastUiEmitTime = 0;
  private lastGolferMeshVersion = -1;
  private lastReportedOrbited = false;
  private disposed = false;

  constructor(private readonly container: HTMLElement) {
    const w = Math.max(320, container.clientWidth);
    const h = Math.max(240, container.clientHeight);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 0.50;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.cameraSys = new CameraSystem(this.renderer.domElement, w / h);
    const maxAniso = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
    this.textures = createCourseTextures(maxAniso);
    this.skySys = new SkyAtmosphereSystem(this.scene, this.renderer, this.cameraSys.camera);
    this.oceanSys = new OceanSystem(this.scene);
    this.terrainSys = new TerrainMeshSystem(this.scene, this.textures);
    this.foliageSys = new FoliageSystem(this.scene, this.textures);
    this.modelsSys = new ModelsSystem(this.scene, this.textures);
    this.particles = new ParticleEffectsSystem(this.scene);
    this.visualAids = new VisualAidsSystem(this.scene);
    this.audio = new AudioSystem();
    this.postProc = new PostProcessingPipeline(this.renderer, this.scene, this.cameraSys.camera, w, h);

    this.loadHole(COURSE_HOLES[0].id);

    window.addEventListener('resize', this.handleResize);
    this.startLoop();
  }

  public subscribe(fn: (snap: EngineSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.getSnapshot());
    return () => this.listeners.delete(fn);
  }

  private emitSnapshot(): void {
    this.lastReportedOrbited = this.cameraSys.isAddressOrbited;
    const snap = this.getSnapshot();
    this.listeners.forEach((fn) => fn(snap));
  }

  public loadHole(holeId: string): void {
    const idx = COURSE_HOLES.findIndex((h) => h.id === holeId);
    this.holeIndex = idx >= 0 ? idx : 0;
    this.hole = getHoleById(COURSE_HOLES[this.holeIndex].id);
    this.sampler = new HoleTerrainSampler(this.hole, this.difficulty);

    const windMult = this.difficulty === 'amateur' ? 0.75 : this.difficulty === 'tour' ? 1.25 : 1.0;
    this.wind = {
      speedMps: this.hole.defaultWindSpeedMph * 0.44704 * windMult,
      directionRad: this.hole.defaultWindDirRad,
      gustiness: this.difficulty === 'tour' ? 0.48 : 0.35,
    };
    this.audio.setWindIntensity(this.wind.speedMps);

    this.oceanSys.configureForHole(this.hole);
    this.terrainSys.buildForHole(this.sampler);
    this.foliageSys.buildForHole(this.sampler, this.foliageDensity);
    this.modelsSys.buildHoleProps(this.sampler);
    this.visualAids.clearTracers(true);
    this.particles.clear();
    this.skySys.applyCSMToScene();
    this.lastGolferMeshVersion = this.modelsSys.golferMeshVersion;
    this.refreshDepthExcludeCache();

    this.undoSnapshot = null;
    this.lastReplayData = null;
    this.rangeCarrySum = 0;
    this.rangeOfflineSum = 0;
    this.rangeShots = 0;
    this.rangeBestPinYds = null;
    this.resetToTee();
  }

  private refreshDepthExcludeCache(): void {
    this.postProc.setDepthExcludeObjects([
      this.skySys.sky,
      this.skySys.cloudDome,
      ...this.foliageSys.getTransientGrassObjects(),
    ]);
  }

  public resetToTee(): void {
    this.strokesOnHole = 0;
    this.holeMeta = { fairwayHit: null, greenInRegulation: false, putts: 0 };
    this.undoSnapshot = null;
    this.lastReplayData = null;
    this.shotEventLabel = null;
    this.playState = 'ready';
    this.walkInElapsedS = 0;
    this.ballPos = this.sampler.getTeeBallPosition();
    this.lastSafePos = { ...this.ballPos };
    this.shotStartPos = { ...this.ballPos };
    this.ballVel = { x: 0, y: 0, z: 0 };
    this.ballOmega = { x: 0, y: 0, z: 0 };
    this.lastTelemetry = null;
    this.waterPenaltyTriggered = false;
    this.flagstickInCup = true;
    this.sampler.flagstickInCup = true;
    this.modelsSys.setFlagstickVisible(true);

    // Aim directly toward pin (or wind-compensated fairway landing zone on doglegs)
    const targetX = this.hole.id === 'hole-1' ? 12 : this.sampler.cupPosition.x;
    const targetZ = this.hole.id === 'hole-1' ? -205 : this.sampler.cupPosition.z;
    this.aimYawRad = Math.atan2(targetX - this.ballPos.x, -(targetZ - this.ballPos.z));

    this.autoSelectClub();
    this.setGreenGridVisible(false);
    this.cameraSys.setMode('address');
    this.cameraSys.snapToAddress(this.ballPos, this.aimYawRad, this.sampler, false);
    this.foliageSys.updateHeroTurfAround(this.ballPos.x, this.ballPos.z, true);
    this.skySys.focusShadowsAt(new THREE.Vector3(this.ballPos.x, this.ballPos.y, this.ballPos.z), 14);
    this.syncReadyStartPose();
    this.updatePreviewArc();
    this.emitSnapshot();
  }

  public resetBallOnRange(): void {
    this.visualAids.clearTracers();
    this.ballPos = this.sampler.getTeeBallPosition();
    this.lastSafePos = { ...this.ballPos };
    this.shotStartPos = { ...this.ballPos };
    this.ballVel = { x: 0, y: 0, z: 0 };
    this.ballOmega = { x: 0, y: 0, z: 0 };
    this.playState = 'ready';
    this.animPhase = 'walk_in';
    this.walkInElapsedS = 0;
    this.cameraSys.setMode('address');
    this.cameraSys.snapToAddress(this.ballPos, this.aimYawRad, this.sampler, false);
    this.foliageSys.updateHeroTurfAround(this.ballPos.x, this.ballPos.z, true);
    this.skySys.focusShadowsAt(new THREE.Vector3(this.ballPos.x, this.ballPos.y, this.ballPos.z), 14);
    this.syncReadyStartPose();
    this.updatePreviewArc();
    this.emitSnapshot();
  }

  public getRecommendedClubId(): string {
    const surf = this.sampler.getSurface(this.ballPos.x, this.ballPos.z);
    const distYds =
      Math.hypot(
        this.sampler.cupPosition.x - this.ballPos.x,
        this.sampler.cupPosition.z - this.ballPos.z
      ) * M_TO_YARDS;

    if (surf === 'green' || (surf === 'fringe' && distYds < 18)) {
      return 'PT';
    }
    if (surf === 'bunker' && distYds < 45) {
      return 'SW';
    }
    if (this.hole.isDrivingRange) {
      return this.selectedClub.id === 'PT' ? 'DR' : this.selectedClub.id;
    }

    // Account for elevation delta (rule of thumb: +/- 1 yd per 3 ft elevation change)
    const elevDiffFt = (this.sampler.cupPosition.y - this.ballPos.y) * 3.28084;
    const effectiveYds = distYds + elevDiffFt / 3.0;

    if (this.hole.id === 'hole-1' && surf === 'tee') {
      return '4I';
    }
    if (surf === 'tee' && this.hole.par >= 4 && distYds > 265) return 'DR';
    if (effectiveYds >= 260) return 'DR';
    if (effectiveYds >= 240) return '3W';
    if (effectiveYds >= 225) return '5W';
    if (effectiveYds >= 214) return '3H';
    if (effectiveYds >= 200) return '4I';
    if (effectiveYds >= 190) return '5I';
    if (effectiveYds >= 178) return '6I';
    if (effectiveYds >= 166) return '7I';
    if (effectiveYds >= 154) return '8I';
    if (effectiveYds >= 142) return '9I';
    if (effectiveYds >= 128) return 'PW';
    if (effectiveYds >= 110) return 'GW';
    if (effectiveYds >= 90) return 'SW';
    return 'LW';
  }

  public autoSelectClub(): void {
    this.selectedClub = getClubById(this.getRecommendedClubId());
    const onGreen = this.sampler.getSurface(this.ballPos.x, this.ballPos.z) === 'green';
    this.setGreenGridVisible(onGreen || this.selectedClub.category === 'putter');
    if (onGreen) {
      this.flagstickInCup = false;
      this.sampler.flagstickInCup = false;
      this.modelsSys.setFlagstickVisible(false);
    } else {
      this.flagstickInCup = true;
      this.sampler.flagstickInCup = true;
      this.modelsSys.setFlagstickVisible(true);
    }
  }

  public setClub(clubId: string): void {
    if (this.playState !== 'ready') return;
    this.selectedClub = getClubById(clubId);
    this.updatePreviewArc();
    this.emitSnapshot();
  }

  public adjustAim(deltaYawRad: number): void {
    if (this.playState !== 'ready') return;
    this.aimYawRad += deltaYawRad;
    this.updatePreviewArc();
    this.emitSnapshot();
  }

  public setAimTowardsWorld(x: number, z: number): void {
    if (this.playState !== 'ready') return;
    this.aimYawRad = Math.atan2(x - this.ballPos.x, -(z - this.ballPos.z));
    this.updatePreviewArc();
    this.emitSnapshot();
  }

  public setWind(speedMph: number, dirDeg: number): void {
    this.wind.speedMps = Math.max(0, speedMph) * 0.44704;
    this.wind.directionRad = THREE.MathUtils.degToRad(dirDeg);
    this.audio.setWindIntensity(this.wind.speedMps);
    this.updatePreviewArc();
    this.emitSnapshot();
  }

  public setDifficulty(diff: DifficultyMode): void {
    this.difficulty = diff;
    this.sampler.setDifficulty(diff);
    this.terrainSys.updateCupPosition(this.sampler.cupPosition);
    this.modelsSys.updateCupPosition(this.sampler.cupPosition);
    const windMult = diff === 'amateur' ? 0.75 : diff === 'tour' ? 1.25 : 1.0;
    this.wind.speedMps = this.hole.defaultWindSpeedMph * 0.44704 * windMult;
    this.wind.gustiness = diff === 'tour' ? 0.48 : 0.35;
    this.audio.setWindIntensity(this.wind.speedMps);
    this.showAimPreview = diff !== 'tour';
    this.updatePreviewArc();
    this.emitSnapshot();
  }

  public setProTracerEnabled(enabled: boolean): void {
    this.visualAids.proTracerEnabled = enabled;
    if (!enabled) this.visualAids.clearTracers(false);
    this.emitSnapshot();
  }

  public setAutoQualityEnabled(enabled: boolean): void {
    this.autoQualityEnabled = enabled;
    this.fpsWindowS = 0;
    this.fpsFrames = 0;
  }

  public takeMulligan(): void {
    if (!this.undoSnapshot) return;
    if (this.playState === 'swinging' || this.playState === 'replaying') return;
    const u = this.undoSnapshot;
    this.undoSnapshot = null;
    this.ballPos = { ...u.ballPos };
    this.lastSafePos = { ...u.lastSafePos };
    this.strokesOnHole = u.strokesOnHole;
    this.aimYawRad = u.aimYawRad;
    this.selectedClub = u.selectedClub;
    this.holeMeta = { ...u.holeMeta };
    this.lastTelemetry = u.lastTelemetry;
    this.ballVel = { x: 0, y: 0, z: 0 };
    this.ballOmega = { x: 0, y: 0, z: 0 };
    this.waterPenaltyTriggered = false;
    this.playState = 'ready';
    this.animPhase = 'walk_in';
    this.walkInElapsedS = 0;
    this.visualAids.clearTracers(false);
    this.cameraSys.resetAddressOrbit(true);
    this.cameraSys.setMode('address');
    this.cameraSys.snapToAddress(
      this.ballPos,
      this.aimYawRad,
      this.sampler,
      this.selectedClub.category === 'putter'
    );
    this.foliageSys.updateHeroTurfAround(this.ballPos.x, this.ballPos.z, true);
    this.syncReadyStartPose();
    this.updatePreviewArc();
    this.triggerShotEvent('Mulligan Taken');
    this.emitSnapshot();
  }

  public takeUnplayableDrop(): void {
    if (this.playState !== 'ready' || this.hole.isDrivingRange) return;
    const cup = this.sampler.cupPosition;
    const distCurToPin = Math.hypot(this.ballPos.x - cup.x, this.ballPos.z - cup.z);

    let bestSpot: Vec3 | null = null;
    let bestScore = -Infinity;
    for (let radius = 2.0; radius <= 14.0; radius += 2.0) {
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2;
        const cx = this.ballPos.x + Math.cos(ang) * radius;
        const cz = this.ballPos.z + Math.sin(ang) * radius;
        const dToPin = Math.hypot(cx - cup.x, cz - cup.z);
        // USGA relief: no closer to the hole
        if (dToPin < distCurToPin - 0.15) continue;
        const surf = this.sampler.getSurface(cx, cz);
        if (surf === 'water' || surf === 'cliff_rock') continue;
        const slope = this.sampler.getSlopePercent(cx, cz).slopePct;
        const surfRank =
          surf === 'fairway' ? 40 : surf === 'rough' ? 30 : surf === 'fringe' ? 25 : surf === 'heavy_rough' ? 15 : 5;
        const score = surfRank - slope * 0.8 - radius * 0.9;
        if (score > bestScore) {
          bestScore = score;
          bestSpot = { x: cx, y: this.sampler.getHeight(cx, cz) + BALL_RADIUS_M, z: cz };
        }
      }
      if (bestSpot && bestScore > 20) break;
    }

    if (!bestSpot) {
      bestSpot = { ...this.lastSafePos };
    }
    this.strokesOnHole++;
    this.ballPos = bestSpot;
    this.lastSafePos = { ...bestSpot };
    this.aimYawRad = Math.atan2(cup.x - bestSpot.x, -(cup.z - bestSpot.z));
    this.autoSelectClub();
    this.walkInElapsedS = 0;
    this.cameraSys.resetAddressOrbit(true);
    this.cameraSys.snapToAddress(
      this.ballPos,
      this.aimYawRad,
      this.sampler,
      this.selectedClub.category === 'putter'
    );
    this.foliageSys.updateHeroTurfAround(this.ballPos.x, this.ballPos.z, true);
    this.syncReadyStartPose();
    this.updatePreviewArc();
    this.triggerShotEvent('Unplayable Lie Drop (+1)');
    this.emitSnapshot();
  }

  public replayLastShot(): void {
    if (!this.lastReplayData || this.lastReplayData.frames.length < 2) return;
    if (this.playState !== 'ready' && this.playState !== 'holed_out') return;
    this.playState = 'replaying';
    this.replayElapsedS = 0;
    this.liveTracerPoints = [];
    this.visualAids.clearTracers(false);
    const rd = this.lastReplayData;
    this.renderBallPos = { ...rd.startPos };
    this.cameraSys.setMode('follow', rd.startPos, this.sampler.cupPosition, rd.aimYawRad);
    this.emitSnapshot();
  }

  public stopReplay(): void {
    if (this.playState !== 'replaying' || !this.lastReplayData) return;
    const rd = this.lastReplayData;
    this.playState = rd.endState;
    this.ballPos = { ...rd.postBallPos };
    this.renderBallPos = { ...rd.postBallPos };
    this.aimYawRad = rd.postAimYawRad;
    this.visualAids.clearTracers(false);
    if (rd.endState === 'ready') {
      this.walkInElapsedS = this.walkInDurationS;
      this.cameraSys.resetAddressOrbit(true);
      this.cameraSys.setMode('address');
      this.cameraSys.snapToAddress(
        this.ballPos,
        this.aimYawRad,
        this.sampler,
        this.selectedClub.category === 'putter'
      );
      this.updatePreviewArc();
    }
    this.emitSnapshot();
  }

  private triggerShotEvent(msg: string): void {
    this.shotEventLabel = msg;
    this.shotEventTimerS = 2.6;
  }

  public setTimeOfDay(preset: TimeOfDayPreset): void {
    const cfg = this.skySys.applyPreset(preset);
    this.oceanSys.update(
      this.elapsedTimeS,
      this.wind.speedMps,
      this.wind.directionRad,
      this.skySys.sunDirection,
      this.skySys.sunLight.color,
      new THREE.Color(cfg.fogColor),
      cfg.fogDensity,
      this.skySys.cloudOffset,
      this.skySys.cloudCoverage,
      this.skySys.mistColor,
      this.skySys.mistDensity
    );
  }

  public setGraphicsQuality(quality: GraphicsQuality): void {
    this.qualityLevel = quality;
    this.renderer.setPixelRatio(
      quality === 'medium' ? 1 : Math.min(window.devicePixelRatio, quality === 'ultra' ? 1.5 : 1.25)
    );
    this.postProc.setQuality(quality);
    this.oceanSys.planarReflectionEnabled = quality !== 'medium';
    this.skySys.setShadowResolution(quality === 'ultra' ? 4096 : quality === 'high' ? 2048 : 1024);
    const density: FoliageDensity = quality === 'ultra' ? 'high' : quality === 'high' ? 'medium' : 'low';
    if (density !== this.foliageDensity) {
      this.foliageDensity = density;
      this.foliageSys.buildForHole(this.sampler, density);
      this.foliageSys.updateHeroTurfAround(this.ballPos.x, this.ballPos.z, true);
      this.skySys.applyCSMToScene();
      this.refreshDepthExcludeCache();
    }
  }

  public setCameraMode(mode: CameraMode): void {
    if (mode === 'address') {
      this.cameraSys.resetAddressOrbit(false);
    }
    this.cameraSys.setMode(mode, this.ballPos, this.sampler.cupPosition, this.aimYawRad);
    if (mode === 'address' && this.playState === 'ready') {
      this.skySys.focusShadowsAt(new THREE.Vector3(this.ballPos.x, this.ballPos.y, this.ballPos.z), 14);
      this.foliageSys.updateHeroTurfAround(this.ballPos.x, this.ballPos.z, true);
    } else if (mode === 'green_read') {
      this.skySys.focusShadowsAt(
        new THREE.Vector3(this.sampler.cupPosition.x, this.sampler.cupPosition.y, this.sampler.cupPosition.z),
        28
      );
      this.foliageSys.updateHeroTurfAround(this.sampler.cupPosition.x, this.sampler.cupPosition.z, true);
    } else if (mode === 'scout') {
      this.skySys.focusShadowsAt(new THREE.Vector3(this.ballPos.x, this.ballPos.y, this.ballPos.z), 75);
      this.foliageSys.updateHeroTurfAround(this.cameraSys.controls.target.x, this.cameraSys.controls.target.z, true);
    } else {
      this.skySys.focusShadowsAt(new THREE.Vector3(this.ballPos.x, this.ballPos.y, this.ballPos.z), 75);
      this.foliageSys.updateHeroTurfAround(this.sampler.cupPosition.x, this.sampler.cupPosition.z, true);
    }
    this.emitSnapshot();
  }

  public resetCameraOrbit(): void {
    this.cameraSys.resetAddressOrbit(false);
    this.emitSnapshot();
  }

  public setGreenGridVisible(visible: boolean): void {
    this.greenGridVisible = visible;
    this.terrainSys.setGreenGridVisible(visible);
    this.emitSnapshot();
  }

  public toggleFlagstick(): void {
    this.flagstickInCup = !this.flagstickInCup;
    this.sampler.flagstickInCup = this.flagstickInCup;
    this.modelsSys.setFlagstickVisible(this.flagstickInCup);
    this.emitSnapshot();
  }

  public setAimPreviewVisible(visible: boolean): void {
    this.showAimPreview = visible;
    this.updatePreviewArc();
  }

  private lastPreviewInputs = {
    powerRatio: 1.0,
    clubPathDeg: 0,
    faceAngleDeg: 0,
    attackAngleDeg: 0,
    dynamicLoftDeltaDeg: 0,
    strikeOffsetXMm: 0,
    strikeOffsetYMm: 0,
  };

  public updatePreviewArc(overrides?: Partial<typeof this.lastPreviewInputs>): void {
    if (overrides) {
      this.lastPreviewInputs = { ...this.lastPreviewInputs, ...overrides };
    }
    if (!this.showAimPreview || this.playState !== 'ready') {
      this.visualAids.updateAimPreview([], null, this.sampler, false, false);
      return;
    }

    const surf = this.sampler.getSurface(this.ballPos.x, this.ballPos.z);
    const norm = this.sampler.getNormal(this.ballPos.x, this.ballPos.z);
    const isPutt = this.selectedClub.category === 'putter';

    // For putting, estimate recommended power or current preview power
    const distToCupM = Math.hypot(
      this.sampler.cupPosition.x - this.ballPos.x,
      this.sampler.cupPosition.z - this.ballPos.z
    );
    const previewPower = isPutt
      ? Math.min(1.0, Math.max(0.12, Math.sqrt(distToCupM / 22)))
      : this.lastPreviewInputs.powerRatio;

    const pred = simulateFullShot(
      this.ballPos,
      {
        club: this.selectedClub,
        aimYawRad: this.aimYawRad,
        powerRatio: previewPower,
        clubPathDeg: this.lastPreviewInputs.clubPathDeg,
        faceAngleDeg: this.lastPreviewInputs.faceAngleDeg,
        attackAngleDeg: this.selectedClub.tourAttackAngleDeg + this.lastPreviewInputs.attackAngleDeg,
        dynamicLoftDeltaDeg: this.lastPreviewInputs.dynamicLoftDeltaDeg,
        strikeOffsetXMm: this.lastPreviewInputs.strikeOffsetXMm,
        strikeOffsetYMm: this.lastPreviewInputs.strikeOffsetYMm,
        surface: surf,
        terrainNormal: norm,
      },
      this.wind,
      this.sampler,
      COASTAL_STANDARD_ATMOSPHERE
    );

    const pts = isPutt ? pred.rollPoints : pred.flightPoints;
    this.visualAids.updateAimPreview(pts, pred.landingPosition, this.sampler, isPutt, true);
  }

  /**
   * Triggers a live animated golfer swing followed by real-time 60fps RK4 physics!
   */
  public executeShot(input: {
    powerRatio: number;
    clubPathDeg: number;
    faceAngleDeg: number;
    attackAngleDeltaDeg: number;
    dynamicLoftDeltaDeg: number;
    strikeOffsetXMm: number;
    strikeOffsetYMm: number;
  }): void {
    if (this.playState !== 'ready') return;

    const surf = this.sampler.getSurface(this.ballPos.x, this.ballPos.z);
    const norm = this.sampler.getNormal(this.ballPos.x, this.ballPos.z);

    this.pendingSwingParams = {
      club: this.selectedClub,
      aimYawRad: this.aimYawRad,
      powerRatio: input.powerRatio,
      clubPathDeg: input.clubPathDeg,
      faceAngleDeg: input.faceAngleDeg,
      attackAngleDeg: this.selectedClub.tourAttackAngleDeg + input.attackAngleDeltaDeg,
      dynamicLoftDeltaDeg: input.dynamicLoftDeltaDeg,
      strikeOffsetXMm: input.strikeOffsetXMm,
      strikeOffsetYMm: input.strikeOffsetYMm,
      surface: surf,
      terrainNormal: norm,
    };

    this.animPathDeg = input.clubPathDeg;
    this.playState = 'swinging';
    if (this.modelsSys.golferLoaded && this.walkInElapsedS < this.walkInDurationS) {
      this.animPhase = 'walk_in';
    } else {
      this.walkInElapsedS = this.walkInDurationS;
      this.animPhase = 'backswing';
    }
    this.animTimerS = 0;
    this.visualAids.updateAimPreview([], null, this.sampler, false, false);
    this.emitSnapshot();
  }

  private launchBallFromPending(): void {
    if (!this.pendingSwingParams) return;

    const params = this.pendingSwingParams;
    this.pendingSwingParams = null;

    this.undoSnapshot = {
      ballPos: { ...this.ballPos },
      lastSafePos: { ...this.lastSafePos },
      strokesOnHole: this.strokesOnHole,
      aimYawRad: this.aimYawRad,
      selectedClub: this.selectedClub,
      holeMeta: { ...this.holeMeta },
      lastTelemetry: this.lastTelemetry ? { ...this.lastTelemetry } : null,
    };

    if (params.surface === 'green') {
      this.holeMeta.putts++;
    }

    this.lastSafePos = { ...this.ballPos };
    this.shotStartPos = { ...this.ballPos };
    this.strokesOnHole++;

    const pred = simulateFullShot(
      this.ballPos,
      params,
      this.wind,
      this.sampler,
      COASTAL_STANDARD_ATMOSPHERE
    );
    const launch = pred.launch;

    this.currentLaunch = launch;
    this.ballVel = { ...launch.initialVelocity };
    this.ballOmega = { ...launch.initialOmega };
    this.simMode = launch.isPutt ? 'roll' : 'flight';
    this.simTimeS = 0;
    this.bounceCount = 0;
    this.hasLanded = launch.isPutt;
    this.apexY = this.ballPos.y;
    this.landingPos = { ...this.ballPos };
    this.landingAngleDeg = 0;
    this.waterPenaltyTriggered = false;
    this.canopyCooldownS = 0;
    this.pinHitNotified = false;
    this.lipOutNotified = false;
    this.liveTracerPoints = [{ ...this.ballPos }];
    this.activeReplayFrames = [{ t: 0, pos: { ...this.ballPos }, omega: { ...launch.initialOmega } }];

    // Impact audio, turf divot decals & particles!
    this.audio.playStrike(params.club.category, params.surface, params.powerRatio);
    if (params.surface === 'bunker') {
      this.particles.emitSandSplash(this.ballPos, params.aimYawRad, params.powerRatio);
    } else if (!launch.isPutt && params.surface !== 'tee') {
      this.particles.emitTurfDivot(this.ballPos, params.aimYawRad, params.powerRatio);
      if (params.surface !== 'cart_path' && params.surface !== 'cliff_rock') {
        this.modelsSys.addDivot(this.ballPos, params.terrainNormal, params.aimYawRad);
      }
    }

    this.playState = 'ball_in_motion';
    this.physicsAccumS = 0;
    this.prevBallPos = { ...this.ballPos };
    this.renderBallPos = { ...this.ballPos };
    if (this.cameraSys.mode === 'address' || this.cameraSys.mode === 'green_read') {
      this.cameraSys.setMode('follow', this.ballPos, this.sampler.cupPosition, this.aimYawRad);
    }
    this.emitSnapshot();
  }

  private stepPhysicsSimulation(frameDt: number): void {
    const subSteps = 2;
    const dt = frameDt / subSteps;

    for (let i = 0; i < subSteps; i++) {
      if (this.playState !== 'ball_in_motion') break;

      if (this.canopyCooldownS > 0) this.canopyCooldownS = Math.max(0, this.canopyCooldownS - dt);

      if (this.simMode === 'flight') {
        const groundY = this.sampler.getHeight(this.ballPos.x, this.ballPos.z);
        const { next } = stepFlightRK4(
          {
            pos: this.ballPos,
            vel: this.ballVel,
            omega: this.ballOmega,
            timeS: this.simTimeS,
          },
          dt,
          this.wind,
          groundY,
          COASTAL_STANDARD_ATMOSPHERE
        );
        this.ballPos = next.pos;
        this.ballVel = next.vel;
        this.ballOmega = next.omega;
        this.simTimeS = next.timeS;

        if (this.ballPos.y > this.apexY) this.apexY = this.ballPos.y;

        // Check coastal trees, sea rocks & airborne flagstick collisions!
        const hitObs = resolveFlightObstacles(
          this.ballPos,
          this.ballVel,
          this.ballOmega,
          this.hole.trees,
          this.hole.seaRocks,
          this.sampler.getHeight,
          this.hole.isDrivingRange ? null : this.sampler.cupPosition,
          this.flagstickInCup,
          this.canopyCooldownS
        );
        if (hitObs) {
          this.ballPos = hitObs.pos;
          this.ballVel = hitObs.vel;
          this.ballOmega = hitObs.omega;
          if (hitObs.hit === 'canopy') {
            this.canopyCooldownS = 0.25;
            this.audio.playTreeRustle();
            this.particles.emitLeafBurst(this.ballPos, this.ballVel);
            this.triggerShotEvent('Clipped Cypress Canopy');
          } else if (hitObs.hit === 'trunk') {
            this.audio.playTrunkHit();
            this.particles.emitLeafBurst(this.ballPos, this.ballVel);
            this.triggerShotEvent('Tree Trunk Kick!');
          } else if (hitObs.hit === 'rock') {
            this.audio.playBounce('cliff_rock', v3Len(this.ballVel));
            this.particles.emitRockSpark(this.ballPos);
            this.triggerShotEvent('Sea Rock Ricochet!');
          } else if (hitObs.hit === 'flagstick') {
            this.audio.playPinClink();
            if (hitObs.holedFromPin) {
              this.audio.playCupDrop();
              this.triggerShotEvent('Dunked Off Flagstick!');
              this.finishShot(true);
              break;
            }
            this.triggerShotEvent('Hit the Pin!');
          }
        }

        const surfaceY = this.sampler.getHeight(this.ballPos.x, this.ballPos.z) + BALL_RADIUS_M;
        if (this.ballPos.y <= surfaceY) {
          const surf = this.sampler.getSurface(this.ballPos.x, this.ballPos.z);
          this.ballPos.y = surfaceY;
          const n = this.sampler.getNormal(this.ballPos.x, this.ballPos.z);

          if (!this.hasLanded) {
            this.hasLanded = true;
            this.landingPos = { ...this.ballPos };
            const hSpd = Math.hypot(this.ballVel.x, this.ballVel.z);
            this.landingAngleDeg = Math.atan2(Math.abs(this.ballVel.y), Math.max(0.01, hSpd)) * RAD_TO_DEG;
            if (surf === 'green' && this.landingAngleDeg > 28) {
              this.modelsSys.addPitchMark(this.ballPos, n);
            }
          }

          if (surf === 'water' || this.ballPos.y <= BALL_RADIUS_M + 0.05) {
            this.handleWaterHazard();
            break;
          }

          if (v3Dot(this.ballVel, n) < 0) {
            const impactSpd = v3Len(this.ballVel);
            const bounce = resolveCompliantTurfBounce(
              this.ballVel,
              this.ballOmega,
              n,
              surf,
              this.sampler.greenStimpFeet
            );
            this.ballVel = bounce.vel;
            this.ballOmega = bounce.omega;
            this.bounceCount++;

            if (impactSpd > 2.0) {
              this.audio.playBounce(surf, impactSpd);
              if (surf === 'bunker') {
                this.particles.emitSandSplash(this.ballPos, Math.atan2(this.ballVel.x, -this.ballVel.z), 0.7);
              }
            }

            if (bounce.stoppedInSand) {
              this.finishShot(false);
              break;
            }
            if (bounce.transitionToRoll || this.bounceCount >= 6) {
              this.simMode = 'roll';
            }
          }
        }
      } else {
        const res = stepRollingOnTurf(
          this.ballPos,
          this.ballVel,
          this.sampler.getHeight,
          this.sampler.getNormal,
          this.sampler.getSurface,
          this.hole.isDrivingRange ? null : this.sampler.cupPosition,
          this.flagstickInCup,
          dt,
          this.sampler.greenStimpFeet
        );
        this.ballPos = res.pos;
        this.ballVel = res.vel;
        this.ballOmega = res.omega;
        this.simTimeS += dt;

        if (res.hitPin && !this.pinHitNotified) {
          this.pinHitNotified = true;
          this.audio.playPinClink();
          this.triggerShotEvent('Hit the Flagstick!');
        }
        if (res.lipOutEvent && !this.lipOutNotified && !res.holed) {
          this.lipOutNotified = true;
          this.triggerShotEvent('Painful Lip-Out!');
        }

        const surf = this.sampler.getSurface(this.ballPos.x, this.ballPos.z);
        if (surf === 'water' || this.ballPos.y <= BALL_RADIUS_M + 0.05) {
          this.handleWaterHazard();
          break;
        }
        if (res.holed) {
          this.audio.playCupDrop();
          this.finishShot(true);
          break;
        }
        if (res.becameAirborne) {
          this.simMode = 'flight';
        }
        if (res.stopped) {
          this.finishShot(false);
          break;
        }
      }

      // Check out-of-bounds outside terrain grid
      const { minX, maxX, minZ, maxZ } = this.hole.bounds;
      if (
        this.ballPos.x < minX + 4 ||
        this.ballPos.x > maxX - 4 ||
        this.ballPos.z < minZ + 4 ||
        this.ballPos.z > maxZ - 4
      ) {
        this.handleWaterHazard();
        break;
      }
    }

    // Record tracer & replay keyframes at frame cadence
    const lastPt = this.liveTracerPoints[this.liveTracerPoints.length - 1];
    if (
      !lastPt ||
      Math.hypot(this.ballPos.x - lastPt.x, this.ballPos.y - lastPt.y, this.ballPos.z - lastPt.z) > 0.25
    ) {
      this.liveTracerPoints.push({ ...this.ballPos });
      this.visualAids.updateLiveTracer(this.liveTracerPoints, true);
    }
    this.activeReplayFrames.push({
      t: this.simTimeS,
      pos: { ...this.ballPos },
      omega: { ...this.ballOmega },
    });

    // Keep shadow frustum centered near ball
    this.skySys.focusShadowsAt(
      new THREE.Vector3(this.ballPos.x, this.ballPos.y, this.ballPos.z),
      this.simMode === 'flight' ? 95 : 55
    );
  }

  private handleWaterHazard(): void {
    this.waterPenaltyTriggered = true;
    this.particles.emitWaterSplash(this.ballPos);
    this.audio.playWaterSplash();
    this.strokesOnHole++; // 1-stroke water/cliff hazard penalty
    this.finishShot(false);
  }

  private finishShot(holed: boolean): void {
    const start = this.shotStartPos;
    const carryM = Math.hypot(this.landingPos.x - start.x, this.landingPos.z - start.z);
    const totalM = Math.hypot(this.ballPos.x - start.x, this.ballPos.z - start.z);
    const aimFwd = { x: Math.sin(this.aimYawRad), z: -Math.cos(this.aimYawRad) };
    const aimRight = { x: -aimFwd.z, z: aimFwd.x };
    const curveM = (this.ballPos.x - start.x) * aimRight.x + (this.ballPos.z - start.z) * aimRight.z;
    const surf = this.waterPenaltyTriggered
      ? 'water'
      : this.sampler.getSurface(this.ballPos.x, this.ballPos.z);

    // Update FIR / GIR / Range stats
    if (!this.hole.isDrivingRange) {
      if (this.strokesOnHole === 1 && this.hole.par >= 4) {
        this.holeMeta.fairwayHit = surf === 'fairway';
      }
      if ((surf === 'green' || holed) && this.strokesOnHole <= this.hole.par - 2) {
        this.holeMeta.greenInRegulation = true;
      }
    } else if (this.currentLaunch) {
      this.rangeShots++;
      this.rangeCarrySum += carryM * M_TO_YARDS;
      this.rangeOfflineSum += Math.abs(curveM * M_TO_YARDS);
      const pinDistYds =
        Math.hypot(this.ballPos.x - this.sampler.cupPosition.x, this.ballPos.z - this.sampler.cupPosition.z) *
        M_TO_YARDS;
      if (this.rangeBestPinYds === null || pinDistYds < this.rangeBestPinYds) {
        this.rangeBestPinYds = pinDistYds;
      }
    }

    if (this.currentLaunch) {
      this.lastTelemetry = {
        clubName: this.selectedClub.name,
        clubSpeedMph: this.currentLaunch.clubSpeedMph,
        ballSpeedMph: this.currentLaunch.ballSpeedMph,
        smashFactor: this.currentLaunch.smashFactor,
        launchAngleDeg: this.currentLaunch.launchAngleDeg,
        launchDirDeg: this.currentLaunch.launchDirectionDeg,
        spinRpm: this.currentLaunch.totalSpinRpm,
        spinAxisDeg: this.currentLaunch.spinAxisDeg,
        carryYds: carryM * M_TO_YARDS,
        totalYds: totalM * M_TO_YARDS,
        apexFt: Math.max(0, this.apexY - start.y) * 3.28084,
        landingAngleDeg: this.landingAngleDeg,
        curveOfflineYds: curveM * M_TO_YARDS,
        finalSurface: surf,
        holed,
        waterPenalty: this.waterPenaltyTriggered,
      };
    }

    // Archive TV Pro-Tracer & save Instant Shot Replay frames
    this.visualAids.archiveCurrentTracer(
      this.liveTracerPoints,
      this.hasLanded ? this.landingPos : null,
      this.sampler,
      !!this.hole.isDrivingRange
    );
    if (this.activeReplayFrames.length >= 2) {
      this.lastReplayData = {
        frames: [...this.activeReplayFrames],
        startPos: { ...this.shotStartPos },
        aimYawRad: this.aimYawRad,
        club: this.selectedClub,
        pathDeg: this.animPathDeg,
        endState: holed ? 'holed_out' : 'ready',
        postBallPos: { ...this.ballPos },
        postAimYawRad: Math.atan2(
          this.sampler.cupPosition.x - this.ballPos.x,
          -(this.sampler.cupPosition.z - this.ballPos.z)
        ),
      };
    }

    if (holed) {
      this.playState = 'holed_out';
      this.audio.playHoleCelebration(this.strokesOnHole - this.hole.par);
      this.emitSnapshot();
      return;
    }

    this.playState = 'shot_complete';
    this.shotFinishWaitTimer = this.waterPenaltyTriggered ? 1.5 : 0.85;
    this.emitSnapshot();
  }

  private prepareNextShot(): void {
    if (this.hole.isDrivingRange) {
      this.resetBallOnRange();
      return;
    }

    if (this.waterPenaltyTriggered) {
      // Return to last safe dry ground lie with +1 penalty already applied
      this.ballPos = { ...this.lastSafePos };
      this.waterPenaltyTriggered = false;
    }
    this.ballVel = { x: 0, y: 0, z: 0 };
    this.ballOmega = { x: 0, y: 0, z: 0 };
    this.playState = 'ready';
    this.animPhase = 'walk_in';
    this.walkInElapsedS = 0;

    // Automatically align toward the pin!
    this.aimYawRad = Math.atan2(
      this.sampler.cupPosition.x - this.ballPos.x,
      -(this.sampler.cupPosition.z - this.ballPos.z)
    );
    this.autoSelectClub();
    this.cameraSys.resetAddressOrbit(true);
    this.cameraSys.setMode('address');
    this.cameraSys.snapToAddress(
      this.ballPos,
      this.aimYawRad,
      this.sampler,
      this.selectedClub.category === 'putter'
    );
    this.foliageSys.updateHeroTurfAround(this.ballPos.x, this.ballPos.z, true);
    this.skySys.focusShadowsAt(new THREE.Vector3(this.ballPos.x, this.ballPos.y, this.ballPos.z), 14);
    this.syncReadyStartPose();
    this.updatePreviewArc();
    this.emitSnapshot();
  }

  private syncReadyStartPose(): void {
    this.renderBallPos = { ...this.ballPos };
    this.prevBallPos = { ...this.ballPos };
    const surf = this.sampler.getSurface(this.ballPos.x, this.ballPos.z);
    this.modelsSys.updateGolferPose(
      this.ballPos,
      this.aimYawRad,
      this.selectedClub,
      this.cameraSys.mode !== 'green_read',
      'walk_in',
      0,
      0,
      surf === 'tee' && this.selectedClub.category === 'wood',
      0,
      this.getGolferGroundHeight
    );
  }

  private readonly getGolferGroundHeight = (x: number, z: number): number => {
    return this.terrainSys.getMeshHeightAt(x, z) ?? this.sampler.getHeight(x, z);
  };

  private startLoop(): void {
    const tick = () => {
      if (this.disposed) return;
      this.rafId = requestAnimationFrame(tick);

      const dt = Math.min(0.05, this.clock.getDelta());
      this.elapsedTimeS += dt;

      // Clear transient shot event banner timer
      if (this.shotEventLabel) {
        this.shotEventTimerS -= dt;
        if (this.shotEventTimerS <= 0) {
          this.shotEventLabel = null;
          this.emitSnapshot();
        }
      }

      // Ambient coastal gull calls
      if (this.elapsedTimeS >= this.nextGullCallS) {
        this.nextGullCallS = this.elapsedTimeS + 18 + Math.random() * 14;
        this.audio.playGullCall();
      }

      // Auto frame-time quality scaler (< 22 FPS sustained for 4s steps down gracefully)
      if (this.autoQualityEnabled && !document.hidden && this.qualityLevel !== 'medium') {
        this.fpsWindowS += dt;
        this.fpsFrames++;
        if (this.fpsWindowS >= 4.0) {
          const avgFrameMs = (this.fpsWindowS / Math.max(1, this.fpsFrames)) * 1000;
          if (avgFrameMs > 46) {
            const nextQ: GraphicsQuality = this.qualityLevel === 'ultra' ? 'high' : 'medium';
            this.setGraphicsQuality(nextQ);
            this.autoQualityNote = `Auto-tuned graphics to ${nextQ.toUpperCase()} for smoother FPS`;
            this.emitSnapshot();
          }
          this.fpsWindowS = 0;
          this.fpsFrames = 0;
        }
      }

      // 1. Golfer swing & replay state machine
      if (this.playState === 'replaying' && this.lastReplayData) {
        const rd = this.lastReplayData;
        const swingLeadS = rd.club.category === 'putter' ? 0.52 : 0.76;
        this.replayElapsedS += dt;
        const frames = rd.frames;
        const totalBallS = frames[frames.length - 1].t;

        if (this.replayElapsedS < swingLeadS) {
          const isP = rd.club.category === 'putter';
          const backS = isP ? 0.36 : 0.55;
          const downS = isP ? 0.16 : 0.21;
          const isBack = this.replayElapsedS < backS;
          const pT = isBack ? this.replayElapsedS / backS : (this.replayElapsedS - backS) / downS;
          this.modelsSys.updateGolferPose(
            rd.startPos,
            rd.aimYawRad,
            rd.club,
            true,
            isBack ? 'backswing' : 'downswing',
            Math.min(1, pT),
            rd.pathDeg,
            false,
            dt,
            this.getGolferGroundHeight
          );
          this.renderBallPos = { ...rd.startPos };
        } else {
          const ballT = this.replayElapsedS - swingLeadS;
          this.modelsSys.updateGolferPose(
            rd.startPos,
            rd.aimYawRad,
            rd.club,
            ballT < 1.2,
            'followthrough',
            Math.min(1, ballT / 0.65),
            rd.pathDeg,
            false,
            dt,
            this.getGolferGroundHeight
          );
          // Binary/linear sample of replay frame
          let fIdx = 0;
          while (fIdx < frames.length - 1 && frames[fIdx + 1].t < ballT) fIdx++;
          const curF = frames[fIdx];
          const nextF = frames[Math.min(frames.length - 1, fIdx + 1)];
          const span = Math.max(1e-4, nextF.t - curF.t);
          const u = Math.min(1, Math.max(0, (ballT - curF.t) / span));
          this.renderBallPos = {
            x: curF.pos.x + (nextF.pos.x - curF.pos.x) * u,
            y: curF.pos.y + (nextF.pos.y - curF.pos.y) * u,
            z: curF.pos.z + (nextF.pos.z - curF.pos.z) * u,
          };
          this.ballOmega = curF.omega;
          const arcSlice = frames.slice(0, fIdx + 1).map((f) => f.pos);
          this.visualAids.updateLiveTracer(arcSlice, true);
          if (ballT >= totalBallS + 0.65) {
            this.stopReplay();
          }
        }
      } else if (this.playState === 'swinging') {
        const isPutt = this.selectedClub.category === 'putter';
        const backDur = isPutt ? 0.36 : 0.55;
        const downDur = isPutt ? 0.16 : 0.21;
        const followDur = isPutt ? 0.42 : 0.65;

        if (this.animPhase === 'walk_in') {
          this.walkInElapsedS = Math.min(this.walkInDurationS, this.walkInElapsedS + dt * 5.5);
          if (this.walkInElapsedS >= this.walkInDurationS) {
            this.animPhase = 'backswing';
            this.animTimerS = 0;
          }
        } else if (this.animPhase === 'backswing') {
          this.animTimerS += dt;
          if (this.animTimerS >= backDur) {
            this.animPhase = 'downswing';
            this.animTimerS = 0;
          }
        } else if (this.animPhase === 'downswing') {
          this.animTimerS += dt;
          if (this.animTimerS >= downDur) {
            this.animPhase = 'followthrough';
            this.animTimerS = 0;
            this.launchBallFromPending();
          }
        } else {
          this.animTimerS += dt;
        }
        const phaseT =
          this.animPhase === 'walk_in'
            ? this.walkInElapsedS / this.walkInDurationS
            : Math.min(
                1,
                this.animTimerS /
                  (this.animPhase === 'backswing'
                    ? backDur
                    : this.animPhase === 'downswing'
                      ? downDur
                      : followDur)
              );
        this.modelsSys.updateGolferPose(
          this.ballPos,
          this.aimYawRad,
          this.selectedClub,
          true,
          this.animPhase,
          phaseT,
          this.animPathDeg,
          this.sampler.getSurface(this.ballPos.x, this.ballPos.z) === 'tee' &&
            this.selectedClub.category === 'wood',
          dt,
          this.getGolferGroundHeight
        );
      } else if (this.playState === 'ball_in_motion') {
        if (this.animPhase === 'followthrough') {
          this.animTimerS += dt;
          this.modelsSys.updateGolferPose(
            this.shotStartPos,
            this.aimYawRad,
            this.selectedClub,
            Math.hypot(this.ballPos.x - this.shotStartPos.x, this.ballPos.z - this.shotStartPos.z) < 35,
            'followthrough',
            Math.min(1, this.animTimerS / 0.65),
            this.animPathDeg,
            false,
            dt,
            this.getGolferGroundHeight
          );
        }
        const FIXED_STEP_S = 1 / 120;
        this.physicsAccumS += dt;
        let steps = 0;
        while (this.physicsAccumS >= FIXED_STEP_S && this.playState === 'ball_in_motion' && steps < 8) {
          this.prevBallPos = { ...this.ballPos };
          this.stepPhysicsSimulation(FIXED_STEP_S);
          this.physicsAccumS -= FIXED_STEP_S;
          steps++;
        }
        if (this.playState === 'ball_in_motion') {
          const alpha = Math.min(1, Math.max(0, this.physicsAccumS / FIXED_STEP_S));
          this.renderBallPos = {
            x: this.prevBallPos.x + (this.ballPos.x - this.prevBallPos.x) * alpha,
            y: this.prevBallPos.y + (this.ballPos.y - this.prevBallPos.y) * alpha,
            z: this.prevBallPos.z + (this.ballPos.z - this.prevBallPos.z) * alpha,
          };
        } else {
          this.renderBallPos = { ...this.ballPos };
        }
      } else if (this.playState === 'shot_complete') {
        this.shotFinishWaitTimer -= dt;
        if (this.shotFinishWaitTimer <= 0) {
          this.prepareNextShot();
        }
      } else if (this.playState === 'ready') {
        const surf = this.sampler.getSurface(this.ballPos.x, this.ballPos.z);
        const isWalkReady = this.walkInElapsedS < this.walkInDurationS;
        if (this.modelsSys.golferLoaded && isWalkReady) {
          this.walkInElapsedS = Math.min(this.walkInDurationS, this.walkInElapsedS + dt);
        }
        const walkT = this.walkInElapsedS / this.walkInDurationS;
        this.modelsSys.updateGolferPose(
          this.ballPos,
          this.aimYawRad,
          this.selectedClub,
          this.cameraSys.mode !== 'green_read',
          isWalkReady ? 'walk_in' : 'address',
          isWalkReady ? walkT : 0,
          0,
          surf === 'tee' && this.selectedClub.category === 'wood',
          dt,
          this.getGolferGroundHeight
        );
      }

      // Attach CSM to async-loaded golfer GLB or newly switched club models automatically
      if (this.modelsSys.golferMeshVersion !== this.lastGolferMeshVersion) {
        this.skySys.applyCSMToScene(this.modelsSys.golferGroup);
        this.lastGolferMeshVersion = this.modelsSys.golferMeshVersion;
      }

      // 2. Update Clouds, Ocean, Terrain, Foliage, Flagstick, Ball, Particles & Camera
      const fogCfg = TIME_OF_DAY_PRESETS[this.skySys.currentPreset];
      this.skySys.update(dt, this.wind.speedMps, this.wind.directionRad, this.cameraSys.camera.position);
      this.oceanSys.update(
        this.elapsedTimeS,
        this.wind.speedMps,
        this.wind.directionRad,
        this.skySys.sunDirection,
        this.skySys.sunLight.color,
        new THREE.Color(fogCfg.fogColor),
        fogCfg.fogDensity,
        this.skySys.cloudOffset,
        this.skySys.cloudCoverage,
        this.skySys.mistColor,
        this.skySys.mistDensity
      );
      this.terrainSys.update(
        this.elapsedTimeS,
        this.skySys.sunDirection,
        this.skySys.cloudOffset,
        this.skySys.cloudCoverage,
        this.skySys.mistColor,
        this.skySys.mistDensity
      );
      const activeBallPos =
        this.playState === 'ball_in_motion' || this.playState === 'replaying'
          ? this.renderBallPos
          : this.ballPos;
      this.foliageSys.update(
        this.elapsedTimeS,
        this.wind.speedMps,
        this.wind.directionRad,
        this.skySys.sunDirection,
        this.skySys.cloudOffset,
        this.skySys.cloudCoverage,
        this.skySys.mistColor,
        this.skySys.mistDensity,
        activeBallPos
      );

      // Stream proximity grass continuously around active view/ball focus (1 chunk/frame at high flight speed)
      const grassFocus =
        this.cameraSys.mode === 'scout'
          ? this.cameraSys.controls.target
          : this.cameraSys.mode === 'green_read' || this.cameraSys.mode === 'reverse'
            ? this.sampler.cupPosition
            : activeBallPos;
      const fastFlight =
        this.playState === 'ball_in_motion' && Math.hypot(this.ballVel.x, this.ballVel.z) > 14;
      this.foliageSys.updateHeroTurfAround(grassFocus.x, grassFocus.z, false, fastFlight ? 1 : 2);

      // Keep shadow frustum tight when zoomed on ball/green, wide when tracking flight
      if (this.playState === 'ball_in_motion' || this.playState === 'replaying') {
        this.skySys.focusShadowsAt(new THREE.Vector3(activeBallPos.x, activeBallPos.y, activeBallPos.z), 58);
      }

      const groundY = this.sampler.getHeight(activeBallPos.x, activeBallPos.z);
      this.modelsSys.updateFlagAndBall(
        this.elapsedTimeS,
        this.wind.speedMps,
        this.wind.directionRad,
        activeBallPos,
        groundY,
        this.ballOmega,
        dt
      );
      this.particles.update(dt);

      const isPutting = this.selectedClub.category === 'putter';
      this.cameraSys.update(
        dt,
        activeBallPos,
        this.ballVel,
        this.sampler.cupPosition,
        this.aimYawRad,
        this.sampler,
        isPutting,
        this.playState === 'ball_in_motion' || this.playState === 'replaying'
      );

      // Notify UI only when address orbit state flips or during live ball telemetry
      const orbitedNow = this.cameraSys.isAddressOrbited;
      if (orbitedNow !== this.lastReportedOrbited) {
        this.lastReportedOrbited = orbitedNow;
        this.emitSnapshot();
      } else if (this.playState === 'ball_in_motion' && this.elapsedTimeS - this.lastUiEmitTime > 0.08) {
        this.lastUiEmitTime = this.elapsedTimeS;
        this.emitSnapshot();
      }

      const focusDist = this.cameraSys.getFocusDistance(activeBallPos);
      const dofStrength =
        (this.cameraSys.mode === 'address' || this.cameraSys.mode === 'green_read') &&
        this.playState !== 'ball_in_motion'
          ? 0.85
          : 0.0;
      this.oceanSys.updatePlanarReflection(this.renderer, this.cameraSys.camera, [
        ...this.foliageSys.getTransientGrassObjects(),
        ...this.visualAids.getObjects(),
      ]);
      this.postProc.updateSun(this.skySys.sunDirection, this.skySys.sunLight.color);
      this.postProc.updateCameraLens(dt, focusDist, dofStrength, this.skySys.sunDirection.y);
      this.postProc.render();
    };

    this.rafId = requestAnimationFrame(tick);
  }

  public getSnapshot(): EngineSnapshot {
    const distM = Math.hypot(
      this.sampler.cupPosition.x - this.ballPos.x,
      this.sampler.cupPosition.z - this.ballPos.z
    );
    const elevFt = (this.sampler.cupPosition.y - this.ballPos.y) * 3.28084;
    const surf = this.sampler.getSurface(this.ballPos.x, this.ballPos.z);
    const slope = this.sampler.getSlopePercent(this.ballPos.x, this.ballPos.z, this.aimYawRad);

    let liveBallStats: EngineSnapshot['liveBallStats'] = null;
    if (this.playState === 'ball_in_motion') {
      const groundY = this.sampler.getHeight(this.ballPos.x, this.ballPos.z);
      const distShotM = Math.hypot(
        this.ballPos.x - this.shotStartPos.x,
        this.ballPos.z - this.shotStartPos.z
      );
      liveBallStats = {
        speedMph: v3Len(this.ballVel) * 2.23694,
        heightFt: Math.max(0, this.ballPos.y - BALL_RADIUS_M - groundY) * 3.28084,
        distFromShotStartYds: distShotM * M_TO_YARDS,
      };
    }

    return {
      hole: this.hole,
      holeIndex: this.holeIndex,
      difficulty: this.difficulty,
      playState: this.playState,
      ballPos: { ...this.ballPos },
      cupPos: { ...this.sampler.cupPosition },
      distanceToPinYds: distM * M_TO_YARDS,
      elevationToPinFt: elevFt,
      lieSurface: surf,
      lieSlopePct: slope.slopePct,
      lieUphillPct: slope.uphillPct,
      lieSidePct: slope.sidePct,
      strokesOnHole: this.strokesOnHole,
      holeMeta: { ...this.holeMeta },
      wind: { ...this.wind },
      aimYawRad: this.aimYawRad,
      selectedClub: this.selectedClub,
      recommendedClubId: this.getRecommendedClubId(),
      cameraMode: this.cameraSys.mode,
      cameraOrbited: this.cameraSys.isAddressOrbited,
      greenGridVisible: this.greenGridVisible,
      flagstickInCup: this.flagstickInCup,
      proTracerEnabled: this.visualAids.proTracerEnabled,
      canMulligan: this.undoSnapshot !== null && this.playState !== 'swinging' && this.playState !== 'replaying',
      canReplay: this.lastReplayData !== null && (this.playState === 'ready' || this.playState === 'holed_out'),
      shotEventLabel: this.shotEventLabel,
      qualityLevel: this.qualityLevel,
      autoQualityNote: this.autoQualityNote,
      rangeStats: {
        shots: this.rangeShots,
        avgCarryYds: this.rangeShots > 0 ? this.rangeCarrySum / this.rangeShots : 0,
        avgOfflineYds: this.rangeShots > 0 ? this.rangeOfflineSum / this.rangeShots : 0,
        bestToPinYds: this.rangeBestPinYds,
      },
      lastTelemetry: this.lastTelemetry,
      liveBallStats,
    };
  }

  private handleResize = (): void => {
    const w = Math.max(320, this.container.clientWidth);
    const h = Math.max(240, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.postProc.setSize(w, h);
    this.cameraSys.setAspect(w / h);
    this.skySys.refreshCascades();
  };

  public dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.handleResize);
    this.postProc.dispose();
    this.cameraSys.dispose();
    this.oceanSys.dispose();
    this.terrainSys.dispose();
    this.foliageSys.dispose();
    this.modelsSys.dispose();
    this.particles.dispose();
    this.visualAids.dispose();
    this.skySys.dispose();
    this.textures.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
