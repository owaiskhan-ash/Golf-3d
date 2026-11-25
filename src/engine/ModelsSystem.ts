import * as THREE from 'three';
import type { ClubSpec } from '../physics/clubs';
import { BALL_RADIUS_M } from '../physics/constants';
import type { HoleTerrainSampler } from '../course/terrainSampler';
import type { SwingAnimPhase } from './GolferRig';
import type { CourseTextureSet } from './ProceduralTextures';
import { SkinnedGolferRig } from './SkinnedGolferRig';

export type { SwingAnimPhase };

interface CoastalGull {
  group: THREE.Group;
  leftWing: THREE.Mesh;
  rightWing: THREE.Mesh;
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  speed: number;
  phase: number;
}

export class ModelsSystem {
  public readonly ballMesh: THREE.Mesh;
  public readonly ballShadowBlob: THREE.Mesh;
  public readonly teeMesh: THREE.Mesh;
  public readonly golferGroup: THREE.Group;

  private readonly golferRig: SkinnedGolferRig;
  private flagGroup: THREE.Group | null = null;
  private flagUniforms: Record<string, THREE.IUniform> | null = null;
  private propsGroup: THREE.Group | null = null;
  private gulls: CoastalGull[] = [];
  private groundMarksGroup: THREE.Group;
  private groundMarks: THREE.Mesh[] = [];
  private divotGeo: THREE.PlaneGeometry;
  private divotMat: THREE.MeshStandardMaterial;
  private pitchGeo: THREE.RingGeometry;
  private pitchMat: THREE.MeshStandardMaterial;

  public get golferMeshVersion(): number {
    return this.golferRig.meshVersion;
  }

  public get golferLoaded(): boolean {
    return this.golferRig.isLoaded;
  }

  constructor(
    private readonly scene: THREE.Scene,
    private readonly textures: CourseTextureSet
  ) {
    // 1. Hyper-Detailed 336-Dimple Urethane Golf Ball
    const ballGeo = new THREE.SphereGeometry(BALL_RADIUS_M, 36, 28);
    const ballMat = new THREE.MeshPhysicalMaterial({
      map: this.textures.ballAlbedo,
      normalMap: this.textures.ballNormal,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.22,
      metalness: 0.0,
      clearcoat: 0.88,
      clearcoatRoughness: 0.14,
    });
    this.ballMesh = new THREE.Mesh(ballGeo, ballMat);
    this.ballMesh.castShadow = true;
    this.scene.add(this.ballMesh);

    // Subtle ground contact ambient occlusion shadow beneath ball
    const aoCanvas = document.createElement('canvas');
    aoCanvas.width = 64;
    aoCanvas.height = 64;
    const actx = aoCanvas.getContext('2d')!;
    const grad = actx.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(0,0,0,0.52)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    actx.fillStyle = grad;
    actx.fillRect(0, 0, 64, 64);
    const aoTex = new THREE.CanvasTexture(aoCanvas);
    const aoGeo = new THREE.PlaneGeometry(0.085, 0.085);
    aoGeo.rotateX(-Math.PI / 2);
    this.ballShadowBlob = new THREE.Mesh(
      aoGeo,
      new THREE.MeshBasicMaterial({ map: aoTex, transparent: true, depthWrite: false })
    );
    this.scene.add(this.ballShadowBlob);

    // 2. Wooden Golf Tee (shown on Tee Box with Driver/Wood)
    const teeGeo = new THREE.CylinderGeometry(0.004, 0.0018, 0.055, 10);
    const teeMat = new THREE.MeshStandardMaterial({ color: 0xebd7b2, roughness: 0.6 });
    this.teeMesh = new THREE.Mesh(teeGeo, teeMat);
    this.teeMesh.castShadow = true;
    this.scene.add(this.teeMesh);

    // 3. Hyper-Realistic Photogrammetry Skinned 3D Golfer Rig (Microsoft Rocketbox + 2-bone IK)
    this.golferRig = new SkinnedGolferRig(this.textures);
    this.golferGroup = this.golferRig.root;
    this.scene.add(this.golferGroup);

    // 4. Persistent Turf Divot & Green Pitch-Mark Decals
    this.groundMarksGroup = new THREE.Group();
    this.scene.add(this.groundMarksGroup);
    this.divotGeo = new THREE.PlaneGeometry(0.085, 0.22);
    this.divotGeo.rotateX(-Math.PI / 2);
    this.divotMat = new THREE.MeshStandardMaterial({
      color: 0x3b2a19,
      roughness: 0.96,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.pitchGeo = new THREE.RingGeometry(0.008, 0.025, 14);
    this.pitchGeo.rotateX(-Math.PI / 2);
    this.pitchMat = new THREE.MeshStandardMaterial({
      color: 0x2d4a22,
      roughness: 0.90,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
  }

  public addDivot(
    pos: { x: number; y: number; z: number },
    normal: { x: number; y: number; z: number },
    aimYawRad: number
  ): void {
    while (this.groundMarks.length >= 36) {
      const oldest = this.groundMarks.shift()!;
      this.groundMarksGroup.remove(oldest);
    }
    const mesh = new THREE.Mesh(this.divotGeo, this.divotMat);
    const fwdX = Math.sin(aimYawRad);
    const fwdZ = -Math.cos(aimYawRad);
    mesh.position.set(pos.x + fwdX * 0.08, pos.y - BALL_RADIUS_M + 0.006, pos.z + fwdZ * 0.08);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(normal.x, normal.y, normal.z).normalize()
    );
    mesh.rotateY(-aimYawRad);
    this.groundMarks.push(mesh);
    this.groundMarksGroup.add(mesh);
  }

  public addPitchMark(
    pos: { x: number; y: number; z: number },
    normal: { x: number; y: number; z: number }
  ): void {
    while (this.groundMarks.length >= 36) {
      const oldest = this.groundMarks.shift()!;
      this.groundMarksGroup.remove(oldest);
    }
    const mesh = new THREE.Mesh(this.pitchGeo, this.pitchMat);
    mesh.position.set(pos.x, pos.y - BALL_RADIUS_M + 0.005, pos.z);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(normal.x, normal.y, normal.z).normalize()
    );
    this.groundMarks.push(mesh);
    this.groundMarksGroup.add(mesh);
  }

  public updateCupPosition(cupPos: { x: number; y: number; z: number }): void {
    if (this.flagGroup) {
      this.flagGroup.position.set(cupPos.x, cupPos.y, cupPos.z);
    }
  }

  public updateGolferPose(
    ballPos: { x: number; y: number; z: number },
    aimYawRad: number,
    club: ClubSpec,
    visible: boolean,
    animPhase: SwingAnimPhase,
    phaseT: number,
    clubPathDeg: number,
    showTee: boolean,
    dt = 0.016,
    groundHeightAt?: (x: number, z: number) => number
  ): void {
    this.teeMesh.visible = showTee;
    if (showTee) {
      this.teeMesh.position.set(ballPos.x, ballPos.y - 0.025, ballPos.z);
    }
    this.golferRig.updatePose(
      ballPos,
      aimYawRad,
      club,
      visible,
      animPhase,
      phaseT,
      clubPathDeg,
      dt,
      groundHeightAt
    );
  }

  public buildHoleProps(sampler: HoleTerrainSampler): void {
    this.clearHoleProps();
    const hole = sampler.hole;

    // 1. Flagstick + Animated Wind-Cloth Flag at Cup
    const cup = sampler.cupPosition;
    const fGroup = new THREE.Group();
    fGroup.position.set(cup.x, cup.y, cup.z);

    const poleMat = new THREE.MeshStandardMaterial({
      color: 0xf7f5e8,
      roughness: 0.3,
      metalness: 0.1,
    });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, 2.25, 10), poleMat);
    pole.position.y = 1.12;
    pole.castShadow = true;
    fGroup.add(pole);

    // High-vis black/yellow band near bottom of pin
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0125, 0.0125, 0.18, 10),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4 })
    );
    band.position.y = 0.55;
    fGroup.add(band);

    // Finial knob
    const finial = new THREE.Mesh(
      new THREE.SphereGeometry(0.022, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.7, roughness: 0.3 })
    );
    finial.position.y = 2.26;
    fGroup.add(finial);

    // Animated Wind-Rippling Flag Shader
    const flagGeo = new THREE.PlaneGeometry(0.62, 0.40, 16, 8);
    flagGeo.translate(0.31, 0, 0); // Hinge on pole at x=0
    const flagUniforms: Record<string, THREE.IUniform> = {
      uTime: { value: 0 },
      uWindSpeed: { value: 5.0 },
    };
    this.flagUniforms = flagUniforms;

    const flagMat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: flagUniforms,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uWindSpeed;
        varying vec2 vUv;
        varying float vWaveSlope;
        void main() {
          vUv = uv;
          vec3 p = position;
          float freq = 12.0;
          float speed = 4.0 + uWindSpeed * 0.6;
          float amp = 0.065 * p.x * (0.4 + 0.12 * uWindSpeed);
          float phase = p.x * freq - uTime * speed;
          p.z += sin(phase) * amp;
          p.y += cos(p.x * 7.0 - uTime * 3.5) * 0.018 * p.x;
          vWaveSlope = cos(phase) * amp * freq;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vWaveSlope;
        void main() {
          vec3 gold = vec3(0.95, 0.78, 0.18);
          vec3 navy = vec3(0.08, 0.19, 0.35);
          // Classic championship coastal pennant border + fabric weave
          float border = step(0.08, vUv.y) * step(vUv.y, 0.92) * step(vUv.x, 0.95);
          vec3 col = mix(gold * 0.9, navy, border);
          float d = abs(vUv.x - 0.42) * 1.4 + abs(vUv.y - 0.5);
          if (d < 0.22) col = gold;
          float weave = 0.96 + 0.04 * sin(vUv.x * 160.0) * sin(vUv.y * 110.0);
          float foldLight = 0.88 + 0.22 * clamp(vWaveSlope * 0.9, -0.5, 0.5);
          gl_FragColor = vec4(col * weave * foldLight, 1.0);
        }
      `,
    });

    const flagMesh = new THREE.Mesh(flagGeo, flagMat);
    flagMesh.position.y = 2.02;
    flagMesh.castShadow = true;
    fGroup.add(flagMesh);

    this.flagGroup = fGroup;
    this.scene.add(fGroup);

    // 2. Tee Markers, Tee Plaque, Bunker Rakes, Range Flags, Coastal Gulls & Clubhouse
    const props = new THREE.Group();

    const teeYaw = hole.tee.yawRad;
    const rightX = Math.cos(teeYaw);
    const rightZ = Math.sin(teeYaw);
    const fwdX = Math.sin(teeYaw);
    const fwdZ = -Math.cos(teeYaw);
    const markerMat = new THREE.MeshPhysicalMaterial({
      color: 0x164a8a,
      roughness: 0.22,
      clearcoat: 0.88,
    });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xc8a44d, metalness: 0.86, roughness: 0.26 });
    const cedarMat = new THREE.MeshStandardMaterial({ color: 0x5c3e28, roughness: 0.85 });
    for (const side of [-1, 1]) {
      const mx = hole.tee.cx + rightX * side * 3.1;
      const mz = hole.tee.cz + rightZ * side * 3.1;
      const my = sampler.getHeight(mx, mz);
      const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.08, 8), brassMat);
      peg.position.set(mx, my + 0.03, mz);
      props.add(peg);
      const marker = new THREE.Mesh(new THREE.SphereGeometry(0.078, 16, 12), markerMat);
      marker.position.set(mx, my + 0.095, mz);
      marker.castShadow = true;
      props.add(marker);
    }

    // Cedar & Brass Championship Tee-Box Yardage Plaque
    if (!hole.isDrivingRange) {
      const px = hole.tee.cx - rightX * 4.5 + fwdX * 1.4;
      const pz = hole.tee.cz - rightZ * 4.5 + fwdZ * 1.4;
      const py = sampler.getHeight(px, pz);
      const plaque = new THREE.Group();
      plaque.position.set(px, py, pz);
      plaque.rotation.y = -teeYaw + 0.42;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.56, 0.08), cedarMat);
      post.position.y = 0.28;
      post.castShadow = true;
      plaque.add(post);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.28, 0.04), cedarMat);
      frame.position.y = 0.58;
      frame.rotation.x = -0.35;
      frame.castShadow = true;
      plaque.add(frame);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.22, 0.012), brassMat);
      plate.position.set(0, 0.58, 0.021);
      plate.rotation.x = -0.35;
      plaque.add(plate);
      props.add(plaque);
    }

    // Pro Tour Bunker Rakes resting beside bunkers on the grass lip
    const rakeHandleMat = new THREE.MeshStandardMaterial({ color: 0xe6decb, roughness: 0.48 });
    const rakeHeadMat = new THREE.MeshStandardMaterial({ color: 0x1b3456, roughness: 0.6 });
    for (const b of hole.bunkers) {
      const ang = b.lipDirRad + Math.PI * 0.65;
      const rx = b.cx + Math.cos(ang) * (b.rx + 1.15);
      const rz = b.cz + Math.sin(ang) * (b.rz + 1.15);
      const ry = sampler.getHeight(rx, rz);
      const rake = new THREE.Group();
      rake.position.set(rx, ry + 0.025, rz);
      rake.rotation.y = ang + 0.5;
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 1.35, 8), rakeHandleMat);
      handle.rotation.z = Math.PI * 0.5;
      handle.castShadow = true;
      rake.add(handle);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.028, 0.36), rakeHeadMat);
      head.position.x = 0.67;
      head.castShadow = true;
      rake.add(head);
      props.add(rake);
    }

    // Coastal Pacific Seagulls circling smoothly above cliff & shoreline
    this.gulls = [];
    const gullBodyMat = new THREE.MeshStandardMaterial({ color: 0xf4f5f7, roughness: 0.65 });
    const wingGeo = new THREE.BoxGeometry(0.46, 0.015, 0.14);
    wingGeo.translate(0.23, 0, 0);
    const bodyGeo = new THREE.ConeGeometry(0.055, 0.34, 6);
    bodyGeo.rotateX(Math.PI * 0.5);
    const gullAnchorX = hole.green.cx - 42;
    const gullAnchorZ = hole.green.cz - 35;
    for (let i = 0; i < 4; i++) {
      const gGroup = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, gullBodyMat);
      gGroup.add(body);
      const leftWing = new THREE.Mesh(wingGeo, gullBodyMat);
      const rightWing = new THREE.Mesh(wingGeo, gullBodyMat);
      rightWing.scale.x = -1;
      gGroup.add(leftWing);
      gGroup.add(rightWing);
      props.add(gGroup);
      this.gulls.push({
        group: gGroup,
        leftWing,
        rightWing,
        cx: gullAnchorX + (i - 1.5) * 26,
        cy: 26 + (i % 3) * 8,
        cz: gullAnchorZ + i * 38,
        radius: 24 + i * 9,
        speed: 0.24 + i * 0.04,
        phase: i * 1.65,
      });
    }

    // Extra Driving Range target flags
    if (hole.extraTargets) {
      for (const tgt of hole.extraTargets) {
        if (Math.hypot(tgt.x - cup.x, tgt.z - cup.z) < 4) continue;
        const ty = sampler.getHeight(tgt.x, tgt.z);
        const rPole = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, 2.2, 8), poleMat);
        rPole.position.set(tgt.x, ty + 1.1, tgt.z);
        rPole.castShadow = true;
        props.add(rPole);

        const rFlag = new THREE.Mesh(
          new THREE.PlaneGeometry(0.55, 0.35),
          new THREE.MeshStandardMaterial({ color: 0xe63946, side: THREE.DoubleSide })
        );
        rFlag.position.set(tgt.x + 0.28, ty + 1.98, tgt.z);
        props.add(rFlag);
      }
    }

    // Scenic Monterey Coastal Lodge overlooking Hole 3's 18th Amphitheater Green!
    if (hole.id === 'hole-3') {
      const lodge = new THREE.Group();
      const lx = -58;
      const lz = -522;
      const ly = sampler.getHeight(lx, lz);
      lodge.position.set(lx, ly, lz);

      const wallMat = new THREE.MeshStandardMaterial({ color: 0xede6d8, roughness: 0.85 });
      const roofMat = new THREE.MeshStandardMaterial({ color: 0x5c3627, roughness: 0.78 });
      const glassMat = new THREE.MeshPhysicalMaterial({
        color: 0x8fb8cc,
        roughness: 0.12,
        metalness: 0.2,
      });

      const body = new THREE.Mesh(new THREE.BoxGeometry(28, 8.5, 14), wallMat);
      body.position.y = 4.25;
      body.castShadow = true;
      body.receiveShadow = true;
      lodge.add(body);

      const roof = new THREE.Mesh(new THREE.ConeGeometry(21, 4.2, 4), roofMat);
      roof.position.y = 10.6;
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(1.2, 1, 0.65);
      roof.castShadow = true;
      lodge.add(roof);

      const veranda = new THREE.Mesh(new THREE.BoxGeometry(26, 0.6, 5.5), wallMat);
      veranda.position.set(0, 2.4, 9.2);
      lodge.add(veranda);

      const windows = new THREE.Mesh(new THREE.BoxGeometry(22, 3.2, 0.3), glassMat);
      windows.position.set(0, 5.2, 7.05);
      lodge.add(windows);

      props.add(lodge);
    }

    this.propsGroup = props;
    this.scene.add(props);
  }

  public setFlagstickVisible(visible: boolean): void {
    if (this.flagGroup) this.flagGroup.visible = visible;
  }

  public updateFlagAndBall(
    timeS: number,
    windSpeedMps: number,
    windDirRad: number,
    ballPos: { x: number; y: number; z: number },
    groundY: number,
    ballSpinOmega: { x: number; y: number; z: number },
    dt: number
  ): void {
    this.ballMesh.position.set(ballPos.x, ballPos.y, ballPos.z);

    // Integrate visual spin quaternion cleanly
    const wx = ballSpinOmega.x;
    const wy = ballSpinOmega.y;
    const wz = ballSpinOmega.z;
    const wMag = Math.hypot(wx, wy, wz);
    if (wMag > 1e-3 && dt > 0) {
      const axis = new THREE.Vector3(wx / wMag, wy / wMag, wz / wMag);
      const dq = new THREE.Quaternion().setFromAxisAngle(axis, Math.min(0.65, wMag * dt));
      this.ballMesh.quaternion.premultiply(dq).normalize();
    }

    // Contact shadow shrinks softly with altitude
    const alt = Math.max(0, ballPos.y - BALL_RADIUS_M - groundY);
    this.ballShadowBlob.position.set(ballPos.x, groundY + 0.008, ballPos.z);
    const s = 1 + Math.min(2.2, alt * 0.45);
    this.ballShadowBlob.scale.set(s, 1, s);
    (this.ballShadowBlob.material as THREE.MeshBasicMaterial).opacity = Math.max(
      0.0,
      0.75 * Math.exp(-alt * 0.35)
    );

    // Rotate flag pennant into live wind vector
    if (this.flagGroup) {
      // Flag geometry extends along +X; rotating around Y by (PI/2 - windDirRad) points +X along (sin(windDir), -cos(windDir))!
      this.flagGroup.rotation.y = Math.PI * 0.5 - windDirRad;
    }
    if (this.flagUniforms) {
      this.flagUniforms.uTime.value = timeS;
      this.flagUniforms.uWindSpeed.value = windSpeedMps;
    }

    // Animate circling coastal seagulls
    for (const g of this.gulls) {
      const ang = timeS * g.speed + g.phase;
      const gx = g.cx + Math.cos(ang) * g.radius;
      const gz = g.cz + Math.sin(ang) * g.radius;
      const gy = g.cy + Math.sin(timeS * 0.7 + g.phase) * 1.4;
      g.group.position.set(gx, gy, gz);
      g.group.rotation.y = -ang;
      g.group.rotation.z = -0.22;
      const flap = Math.sin(timeS * 5.2 + g.phase * 3.0) * 0.36;
      const glide = Math.sin(timeS * 0.6 + g.phase) > 0.2 ? 0.15 : 1.0;
      g.leftWing.rotation.z = flap * glide + 0.08;
      g.rightWing.rotation.z = -flap * glide - 0.08;
    }
  }

  public clearHoleProps(): void {
    this.gulls = [];
    for (const m of this.groundMarks) {
      this.groundMarksGroup.remove(m);
    }
    this.groundMarks = [];
    if (this.flagGroup) {
      this.scene.remove(this.flagGroup);
      this.flagGroup.traverse((o) => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
        if ((o as THREE.Mesh).material) ((o as THREE.Mesh).material as THREE.Material).dispose();
      });
      this.flagGroup = null;
      this.flagUniforms = null;
    }
    if (this.propsGroup) {
      this.scene.remove(this.propsGroup);
      this.propsGroup.traverse((o) => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
        if ((o as THREE.Mesh).material) ((o as THREE.Mesh).material as THREE.Material).dispose();
      });
      this.propsGroup = null;
    }
  }

  public dispose(): void {
    this.clearHoleProps();
    this.scene.remove(this.groundMarksGroup);
    this.divotGeo.dispose();
    this.divotMat.dispose();
    this.pitchGeo.dispose();
    this.pitchMat.dispose();
    this.golferRig.dispose();
    this.ballMesh.geometry.dispose();
    (this.ballMesh.material as THREE.Material).dispose();
  }
}
