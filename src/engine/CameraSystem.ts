import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { HoleTerrainSampler } from '../course/terrainSampler';

export type CameraMode = 'address' | 'follow' | 'green_read' | 'scout' | 'reverse';

export class CameraSystem {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly controls: OrbitControls;
  public mode: CameraMode = 'address';

  private desiredPos = new THREE.Vector3();
  private desiredLook = new THREE.Vector3();
  private currentLook = new THREE.Vector3();
  private initialized = false;
  private breathPhase = 0;
  private smoothFov = 48;

  // Filtered ball-follow trackers so flight camera never stutters over terrain dips or sudden bounces
  private smoothFollowDir = new THREE.Vector2(0, -1);
  private smoothFollowAlt = 0;
  private smoothFollowCamY = 0;
  private smoothCamGroundY = 0;
  private followTrackInit = false;

  // Golfer-locked 360° look-around orbit & zoom state in 'address' mode
  private orbitYaw = 0;
  private orbitPitch = 0;
  private orbitZoom = 1.0;
  private targetOrbitYaw = 0;
  private targetOrbitPitch = 0;
  private targetOrbitZoom = 1.0;
  private activePointers = new Map<number, { x: number; y: number }>();
  private lastPinchDist: number | null = null;
  private isDraggingOrbit = false;

  // Input lock (mobile): the swipe-to-swing gesture owns the touchscreen, so orbit
  // drags / pinch zoom / wheel zoom are all disabled and the camera stays fixed.
  public inputLocked = false;

  public setInputLocked(locked: boolean): void {
    this.inputLocked = locked;
    this.controls.enabled = this.mode === 'scout' && !locked;
    if (locked) {
      this.activePointers.clear();
      this.isDraggingOrbit = false;
      this.lastPinchDist = null;
    }
    this.domElement.style.cursor =
      !locked && (this.mode === 'address' || this.mode === 'scout') ? 'grab' : 'default';
  }

  constructor(private readonly domElement: HTMLElement, aspect: number) {
    this.camera = new THREE.PerspectiveCamera(48, aspect, 0.15, 3200);
    this.camera.position.set(0, 22, 6);

    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 380;
    this.controls.enabled = false;

    this.domElement.style.touchAction = 'none';
    this.domElement.style.cursor = 'grab';
    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    this.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    this.domElement.addEventListener('dblclick', this.onDblClick);
  }

  public get isAddressOrbited(): boolean {
    return (
      Math.abs(this.targetOrbitYaw) > 0.02 ||
      Math.abs(this.targetOrbitPitch) > 0.02 ||
      Math.abs(this.targetOrbitZoom - 1.0) > 0.04
    );
  }

  public resetAddressOrbit(snap = false): void {
    this.targetOrbitYaw = 0;
    this.targetOrbitPitch = 0;
    this.targetOrbitZoom = 1.0;
    if (snap) {
      this.orbitYaw = 0;
      this.orbitPitch = 0;
      this.orbitZoom = 1.0;
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.inputLocked) return;
    if (this.mode !== 'address') return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.isDraggingOrbit = this.activePointers.size > 0;
    this.lastPinchDist = this.getPinchDistance();
    this.domElement.style.cursor = 'grabbing';
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.activePointers.has(e.pointerId)) return;
    const prev = this.activePointers.get(e.pointerId)!;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.mode !== 'address') return;

    if (this.activePointers.size === 2) {
      const dist = this.getPinchDistance();
      if (dist !== null && this.lastPinchDist !== null && this.lastPinchDist > 5) {
        const scale = this.lastPinchDist / dist;
        this.targetOrbitZoom = THREE.MathUtils.clamp(this.targetOrbitZoom * scale, 0.42, 3.6);
      }
      this.lastPinchDist = dist;
    } else if (this.activePointers.size === 1) {
      this.targetOrbitYaw -= dx * 0.0065;
      this.targetOrbitPitch = THREE.MathUtils.clamp(this.targetOrbitPitch + dy * 0.0052, -0.34, 0.96);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.activePointers.has(e.pointerId)) return;
    this.activePointers.delete(e.pointerId);
    this.lastPinchDist = this.getPinchDistance();
    this.isDraggingOrbit = this.activePointers.size > 0;
    this.domElement.style.cursor =
      this.mode === 'address' || this.mode === 'scout'
        ? this.isDraggingOrbit
          ? 'grabbing'
          : 'grab'
        : 'default';
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.inputLocked) return;
    if (this.mode !== 'address') return;
    e.preventDefault();
    const factor = 1 + Math.sign(e.deltaY) * 0.11;
    this.targetOrbitZoom = THREE.MathUtils.clamp(this.targetOrbitZoom * factor, 0.42, 3.6);
  };

  private onDblClick = (): void => {
    if (this.mode === 'address') {
      this.resetAddressOrbit(false);
    }
  };

  private getPinchDistance(): number | null {
    if (this.activePointers.size < 2) return null;
    const pts = Array.from(this.activePointers.values());
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  public setMode(
    mode: CameraMode,
    ballPos?: { x: number; y: number; z: number },
    cupPos?: { x: number; y: number; z: number },
    aimYawRad = 0
  ): void {
    this.mode = mode;
    this.controls.enabled = mode === 'scout' && !this.inputLocked;
    if (mode !== 'address') {
      this.activePointers.clear();
      this.isDraggingOrbit = false;
    }
    this.domElement.style.cursor =
      !this.inputLocked && (mode === 'address' || mode === 'scout') ? 'grab' : 'default';

    if (mode === 'follow') {
      this.smoothFollowDir.set(Math.sin(aimYawRad), -Math.cos(aimYawRad)).normalize();
      this.smoothFollowAlt = 0;
      this.followTrackInit = false;
    }

    if (mode === 'scout' && ballPos && cupPos) {
      // Position scout camera gracefully above midpoint of hole/shot looking at green
      const midX = (ballPos.x + cupPos.x) * 0.5;
      const midZ = (ballPos.z + cupPos.z) * 0.5;
      const span = Math.max(40, Math.hypot(cupPos.x - ballPos.x, cupPos.z - ballPos.z) * 0.48);
      this.controls.target.set(cupPos.x * 0.7 + ballPos.x * 0.3, cupPos.y + 1, cupPos.z * 0.7 + ballPos.z * 0.3);
      this.camera.position.set(
        midX + Math.cos(aimYawRad) * span * 0.45,
        Math.max(ballPos.y, cupPos.y) + span * 0.52,
        midZ + Math.sin(aimYawRad) * span * 0.45 + 15
      );
      this.controls.update();
    }
  }

  public snapToAddress(
    ballPos: { x: number; y: number; z: number },
    aimYawRad: number,
    sampler: HoleTerrainSampler,
    isPutting: boolean
  ): void {
    this.resetAddressOrbit(true);
    this.computeAddressTargets(ballPos, aimYawRad, sampler, isPutting);
    this.camera.position.copy(this.desiredPos);
    this.currentLook.copy(this.desiredLook);
    this.camera.lookAt(this.currentLook);
    this.initialized = true;
  }

  private computeAddressTargets(
    ballPos: { x: number; y: number; z: number },
    aimYawRad: number,
    sampler: HoleTerrainSampler,
    isPutting: boolean
  ): void {
    const fwdX = Math.sin(aimYawRad);
    const fwdZ = -Math.cos(aimYawRad);
    const rightX = Math.cos(aimYawRad);
    const rightZ = Math.sin(aimYawRad);

    // 1. Default Tour Broadcast shot-line framing
    const defaultPos = new THREE.Vector3();
    const defaultLook = new THREE.Vector3();
    if (isPutting) {
      const distBack = 3.25;
      const camX = ballPos.x - fwdX * distBack + rightX * 0.34;
      const camZ = ballPos.z - fwdZ * distBack + rightZ * 0.34;
      const groundH = sampler.getHeight(camX, camZ);
      defaultPos.set(camX, Math.max(groundH + 1.15, ballPos.y + 1.42), camZ);
      defaultLook.set(ballPos.x + fwdX * 5.2 - rightX * 0.14, ballPos.y + 0.28, ballPos.z + fwdZ * 5.2 - rightZ * 0.14);
    } else {
      const distBack = 4.35;
      const camX = ballPos.x - fwdX * distBack + rightX * 0.38;
      const camZ = ballPos.z - fwdZ * distBack + rightZ * 0.38;
      const groundH = sampler.getHeight(camX, camZ);
      defaultPos.set(camX, Math.max(groundH + 1.55, ballPos.y + 1.76), camZ);
      defaultLook.set(ballPos.x + fwdX * 22 - rightX * 0.18, ballPos.y + 0.85, ballPos.z + fwdZ * 22 - rightZ * 0.18);
    }

    // 2. Golfer-locked 360° orbit + zoom framing when user drags/scrolls to look around
    const orbitBlend = Math.min(
      1,
      Math.max(
        Math.abs(this.orbitYaw) / 0.08,
        Math.abs(this.orbitPitch) / 0.08,
        Math.abs(this.orbitZoom - 1.0) / 0.10
      )
    );
    if (orbitBlend <= 0.001) {
      this.desiredPos.copy(defaultPos);
      this.desiredLook.copy(defaultLook);
      return;
    }

    // Anchor pivot squarely between the golfer ("the man") and the ball so he stays locked in frame at any angle/zoom!
    const standDist = isPutting ? 0.42 : 0.56;
    const pivotX = ballPos.x - rightX * standDist;
    const pivotY = ballPos.y + (isPutting ? 0.72 : 0.92);
    const pivotZ = ballPos.z - rightZ * standDist;

    const baseDist = isPutting ? 3.15 : 4.25;
    const basePitch = isPutting ? 0.28 : 0.21;
    const radius = baseDist * this.orbitZoom;
    const pitch = THREE.MathUtils.clamp(basePitch + this.orbitPitch, -0.14, 1.24);
    const totalYaw = aimYawRad + this.orbitYaw;

    const horizR = Math.cos(pitch) * radius;
    const orbCamX = pivotX - Math.sin(totalYaw) * horizR;
    const orbCamZ = pivotZ + Math.cos(totalYaw) * horizR;
    const orbGround = sampler.getHeight(orbCamX, orbCamZ);
    const orbCamY = Math.max(orbGround + 0.38, pivotY + Math.sin(pitch) * radius);

    this.desiredPos.lerpVectors(defaultPos, new THREE.Vector3(orbCamX, orbCamY, orbCamZ), orbitBlend);
    this.desiredLook.lerpVectors(defaultLook, new THREE.Vector3(pivotX, pivotY, pivotZ), orbitBlend);
  }

  public update(
    dt: number,
    ballPos: { x: number; y: number; z: number },
    ballVel: { x: number; y: number; z: number },
    cupPos: { x: number; y: number; z: number },
    aimYawRad: number,
    sampler: HoleTerrainSampler,
    isPutting: boolean,
    isBallMoving: boolean
  ): void {
    if (this.mode === 'scout') {
      this.controls.update();
      return;
    }

    const orbitSmooth = 1 - Math.exp(-14.0 * dt);
    this.orbitYaw += (this.targetOrbitYaw - this.orbitYaw) * orbitSmooth;
    this.orbitPitch += (this.targetOrbitPitch - this.orbitPitch) * orbitSmooth;
    this.orbitZoom += (this.targetOrbitZoom - this.orbitZoom) * orbitSmooth;

    const fwdX = Math.sin(aimYawRad);
    const fwdZ = -Math.cos(aimYawRad);

    if (this.mode === 'address' && !isBallMoving) {
      this.computeAddressTargets(ballPos, aimYawRad, sampler, isPutting);
    } else if (this.mode === 'green_read') {
      const toCupX = cupPos.x - ballPos.x;
      const toCupZ = cupPos.z - ballPos.z;
      const len = Math.hypot(toCupX, toCupZ) || 1;
      const nx = toCupX / len;
      const nz = toCupZ / len;
      const cx = ballPos.x - nx * 2.2;
      const cz = ballPos.z - nz * 2.2;
      const gh = sampler.getHeight(cx, cz);
      this.desiredPos.set(cx, Math.max(gh + 0.45, ballPos.y + 0.55), cz);
      this.desiredLook.set(cupPos.x, cupPos.y + 0.15, cupPos.z);
    } else if (this.mode === 'reverse') {
      // Broadcast tower view behind green looking back toward incoming ball!
      const gx = cupPos.x + fwdX * 20 + Math.cos(aimYawRad) * 9;
      const gz = cupPos.z + fwdZ * 20 + Math.sin(aimYawRad) * 9;
      const gh = sampler.getHeight(gx, gz);
      this.desiredPos.set(gx, Math.max(gh + 4.5, cupPos.y + 5.0), gz);
      this.desiredLook.set(ballPos.x, ballPos.y + 0.4, ballPos.z);
    } else {
      // Silky-smooth filtered Ball-Follow Flight Cam (zero bounce snap, zero terrain-bump vertical jitter)
      const speedH = Math.hypot(ballVel.x, ballVel.z);
      if (speedH > 0.8) {
        const tgtX = ballVel.x / speedH;
        const tgtZ = ballVel.z / speedH;
        const dirLerp = 1 - Math.exp(-4.5 * dt);
        this.smoothFollowDir.x += (tgtX - this.smoothFollowDir.x) * dirLerp;
        this.smoothFollowDir.y += (tgtZ - this.smoothFollowDir.y) * dirLerp;
        if (this.smoothFollowDir.lengthSq() > 1e-5) this.smoothFollowDir.normalize();
      }
      const dirX = this.smoothFollowDir.x;
      const dirZ = this.smoothFollowDir.y;

      const rawAlt = Math.max(0, ballPos.y - sampler.getHeight(ballPos.x, ballPos.z));
      const altLerp = 1 - Math.exp(-5.0 * dt);
      if (!this.followTrackInit) {
        this.smoothFollowAlt = rawAlt;
      } else {
        this.smoothFollowAlt += (rawAlt - this.smoothFollowAlt) * altLerp;
      }

      const followDist = isPutting ? 2.75 : 4.2 + Math.min(7.5, this.smoothFollowAlt * 0.24);
      const followHeight = isPutting ? 1.08 : 1.55 + Math.min(4.2, this.smoothFollowAlt * 0.14);

      const camX = ballPos.x - dirX * followDist;
      const camZ = ballPos.z - dirZ * followDist;
      const camGround = sampler.getHeight(camX, camZ);
      // Low-pass the ground height beneath the camera: sudden terrain rises (bunker brows,
      // cliff edges, mounds) previously entered the clamp below instantly and popped the
      // camera up in a single frame, which read as ball jitter against the sky.
      if (!this.followTrackInit) {
        this.smoothCamGroundY = camGround;
      } else {
        this.smoothCamGroundY += (camGround - this.smoothCamGroundY) * (1 - Math.exp(-7.5 * dt));
      }
      const rawCamY = Math.max(this.smoothCamGroundY + 1.15, ballPos.y + followHeight);
      if (!this.followTrackInit) {
        this.smoothFollowCamY = rawCamY;
        this.followTrackInit = true;
      } else {
        // Keep terrain floor constraint hard while damping upward/downward camera height smoothly
        const dampY = this.smoothFollowCamY + (rawCamY - this.smoothFollowCamY) * (1 - Math.exp(-10.0 * dt));
        this.smoothFollowCamY = Math.max(this.smoothCamGroundY + 1.05, dampY);
      }

      this.desiredPos.set(camX, this.smoothFollowCamY, camZ);
      this.desiredLook.set(ballPos.x + dirX * 2.2, ballPos.y + 0.28, ballPos.z + dirZ * 2.2);
    }

    if (!this.initialized) {
      this.camera.position.copy(this.desiredPos);
      this.currentLook.copy(this.desiredLook);
      this.initialized = true;
    } else {
      const orbitActive = this.mode === 'address' && !isBallMoving && this.isAddressOrbited;
      const posRate = isBallMoving ? 18.0 : orbitActive ? 16.0 : 8.5;
      const lookRate = isBallMoving ? 32.0 : orbitActive ? 18.0 : 10.0;
      const posSmooth = 1 - Math.exp(-posRate * dt);
      const lookSmooth = 1 - Math.exp(-lookRate * dt);
      this.camera.position.lerp(this.desiredPos, posSmooth);
      this.currentLook.lerp(this.desiredLook, lookSmooth);
    }

    // Subtle broadcast telephoto crane/handheld micro-breathing + slight flight-speed lens breathing
    this.breathPhase += dt;
    if (!this.isDraggingOrbit && !isBallMoving && (this.mode === 'address' || this.mode === 'green_read' || this.mode === 'reverse')) {
      const amp = this.mode === 'reverse' ? 0.022 : 0.0045;
      const bx = Math.sin(this.breathPhase * 0.72) * amp + Math.sin(this.breathPhase * 1.41) * amp * 0.45;
      const by = Math.cos(this.breathPhase * 0.58) * amp * 0.75;
      this.camera.position.x += bx;
      this.camera.position.y += by;
    }
    const ballSpeed = Math.hypot(ballVel.x, ballVel.y, ballVel.z);
    const targetFov = isBallMoving && this.mode === 'follow' ? 48 + Math.min(4.8, ballSpeed * 0.085) : 48;
    this.smoothFov += (targetFov - this.smoothFov) * (1 - Math.exp(-5.0 * dt));
    if (Math.abs(this.camera.fov - this.smoothFov) > 0.02) {
      this.camera.fov = this.smoothFov;
      this.camera.updateProjectionMatrix();
    }

    this.camera.lookAt(this.currentLook);
  }

  public getFocusDistance(ballPos: { x: number; y: number; z: number }): number {
    return Math.hypot(
      this.camera.position.x - ballPos.x,
      this.camera.position.y - ballPos.y,
      this.camera.position.z - ballPos.z
    );
  }

  public setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  public dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.domElement.removeEventListener('wheel', this.onWheel);
    this.domElement.removeEventListener('dblclick', this.onDblClick);
    this.controls.dispose();
  }
}
