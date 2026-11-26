import * as THREE from 'three';
import { lerp } from '../course/noise';
import type { HoleTerrainSampler } from '../course/terrainSampler';
import type { CoastalTreeDef } from '../course/types';
import type { CourseTextureSet } from './ProceduralTextures';

function makeSeededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967295;
  };
}

export type FoliageDensity = 'high' | 'medium' | 'low';

const GRASS_CHUNK_SIZE = 4.5;
const GRASS_GRID_RADIUS = 2;
const GRASS_GRID_DIM = GRASS_GRID_RADIUS * 2 + 1; // 5x5 = 25 chunks (22.5m x 22.5m high-density proximity ring)
const GRASS_CHUNK_COUNT = GRASS_GRID_DIM * GRASS_GRID_DIM;

export class FoliageSystem {
  private grassMesh: THREE.InstancedMesh | null = null;
  private heroGrassMesh: THREE.InstancedMesh | null = null;
  private fescuePlumeMesh: THREE.InstancedMesh | null = null;
  private iceplantMesh: THREE.InstancedMesh | null = null;
  private grassUniforms: Record<string, THREE.IUniform> | null = null;
  private treeGroup: THREE.Group | null = null;
  private rockGroup: THREE.Group | null = null;
  private treeSwayUniforms: Record<string, THREE.IUniform> | null = null;
  private currentSampler: HoleTerrainSampler | null = null;
  private currentDensity: FoliageDensity = 'high';
  private chunkCap = 960;
  private chunkGx = new Int32Array(GRASS_CHUNK_COUNT);
  private chunkGz = new Int32Array(GRASS_CHUNK_COUNT);
  private readonly tmpDummy = new THREE.Object3D();
  private readonly tmpColor = new THREE.Color();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly textures: CourseTextureSet
  ) {}

  public getTransientGrassObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    if (this.grassMesh) out.push(this.grassMesh);
    if (this.heroGrassMesh) out.push(this.heroGrassMesh);
    if (this.fescuePlumeMesh) out.push(this.fescuePlumeMesh);
    return out;
  }

  public buildForHole(sampler: HoleTerrainSampler, density: FoliageDensity = 'high'): void {
    this.clearCurrent();
    this.currentSampler = sampler;
    this.currentDensity = density;

    this.buildCoastalGrass(sampler, density);
    this.buildHeroGrassBuffer();
    this.buildCoastalFescuePlumes(sampler, density);
    this.buildCoastalIceplant(sampler, density);
    this.buildMontereyTrees(sampler);
    this.buildCoastalSeaRocks(sampler);

    const teeBall = sampler.getTeeBallPosition();
    if (this.grassUniforms) {
      this.grassUniforms.uBallPos.value.set(teeBall.x, teeBall.y, teeBall.z);
    }
    this.updateHeroTurfAround(teeBall.x, teeBall.z, true);
  }

  private createGrassMaterial(): THREE.MeshStandardMaterial {
    const bladeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.68,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    if (!this.grassUniforms) {
      this.grassUniforms = {
        uTime: { value: 0 },
        uWindDir: { value: new THREE.Vector2(0.7, -0.7) },
        uWindSpeed: { value: 5.0 },
        uSunDir: { value: new THREE.Vector3(0.4, 0.6, -0.5).normalize() },
        uCloudOffset: { value: new THREE.Vector2() },
        uCloudCoverage: { value: 0.49 },
        uMistColor: { value: new THREE.Color(0xc0d9eb) },
        uMistDensity: { value: 0.0045 },
        uBallPos: { value: new THREE.Vector3(99999, 0, 99999) },
      };
    }
    const uniforms = this.grassUniforms;

    bladeMat.customProgramCacheKey = () => 'coastal-grass-8k-v4';
    bladeMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          uniform float uTime;
          uniform vec2 uWindDir;
          uniform float uWindSpeed;
          uniform vec3 uBallPos;
          varying float vBladeTip;
          varying vec3 vBladeWorld;
        `
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          #include <begin_vertex>
          vec4 instWorld = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float ballDist = length(instWorld.xz - uBallPos.xz);
          float partMask = 1.0 - smoothstep(0.014, 0.056, ballDist);
          transformed.y *= ballDist < 0.022 ? 0.0 : mix(1.0, 0.28, partMask);
          float gust = sin(uTime * (1.8 + uWindSpeed * 0.14) + instWorld.x * 0.19 + instWorld.z * 0.17)
                     + 0.45 * sin(uTime * 3.4 + instWorld.x * 0.65 - instWorld.z * 0.52);
          float bend = pow(uv.y, 1.75) * (0.12 + 0.042 * uWindSpeed) * (0.65 + 0.35 * gust);
          transformed.x += uWindDir.x * bend;
          transformed.z += uWindDir.y * bend;
          transformed.y -= bend * 0.24 * uv.y;
          vBladeTip = uv.y;
          vBladeWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        `
        )
        .replace(
          '#include <color_vertex>',
          /* glsl */ `
          #include <color_vertex>
          #ifdef USE_INSTANCING_COLOR
            // Ground root thatch shadow smoothly at base (0.30) up to vibrant sunlit chlorophyll tip (1.18)
            vColor.xyz *= mix(0.30, 1.18, smoothstep(0.0, 0.88, uv.y));
          #endif
        `
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          uniform vec3 uSunDir;
          uniform vec2 uCloudOffset;
          uniform float uCloudCoverage;
          uniform vec3 uMistColor;
          uniform float uMistDensity;
          varying float vBladeTip;
          varying vec3 vBladeWorld;

          float fgHash(vec2 p) {
            p = fract(p * vec2(234.34, 435.345));
            p += dot(p, p + 34.23);
            return fract(p.x * p.y);
          }
          float fgNoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(fgHash(i), fgHash(i + vec2(1.0, 0.0)), f.x),
                       mix(fgHash(i + vec2(0.0, 1.0)), fgHash(i + vec2(1.0, 1.0)), f.x), f.y);
          }
          float fgCloudShadow(vec3 wp) {
            vec2 uv = wp.xz * 0.0042 + uCloudOffset * 1.15 - (uSunDir.xz / max(uSunDir.y + 0.18, 0.25)) * 0.28;
            float d = fgNoise(uv * 1.15) * 0.55 + fgNoise(uv * 2.35) * 0.30 + fgNoise(uv * 4.7) * 0.15;
            return 1.0 - smoothstep(uCloudCoverage - 0.03, uCloudCoverage + 0.28, d) * 0.54;
          }
        `
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `
          #include <roughnessmap_fragment>
          // Matte root sheath -> glossy waxy upper leaf cuticle
          roughnessFactor = mix(0.88, 0.36, smoothstep(0.18, 0.92, vBladeTip));
        `
        )
        .replace(
          '#include <lights_fragment_end>',
          /* glsl */ `
          #include <lights_fragment_end>
          float gCloud = fgCloudShadow(vBladeWorld);
          reflectedLight.directDiffuse *= gCloud;
          reflectedLight.directSpecular *= gCloud;
          // Warm chlorophyll subsurface translucency + subtle sky cuticle sheen on V-ribbed blades
          vec3 gViewDir = normalize(cameraPosition - vBladeWorld);
          float gBacklit = pow(clamp(dot(gViewDir, -uSunDir), 0.0, 1.0), 2.8) * gCloud;
          reflectedLight.directDiffuse += vec3(0.25, 0.36, 0.07) * gBacklit * vBladeTip * 0.50;
          float gRim = pow(1.0 - clamp(abs(dot(geometryNormal, geometryViewDir)), 0.0, 1.0), 3.0);
          reflectedLight.indirectSpecular += vec3(0.32, 0.44, 0.28) * gRim * vBladeTip * 0.18;
        `
        )
        .replace(
          '#include <fog_fragment>',
          /* glsl */ `
          #include <fog_fragment>
          float gDist = length(cameraPosition - vBladeWorld);
          float gMistElev = exp(-max(0.0, vBladeWorld.y - 1.5) * 0.14);
          float gMist = clamp((1.0 - exp(-gDist * uMistDensity * 1.55)) * gMistElev, 0.0, 0.58);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uMistColor, gMist);
        `
        );
    };

    return bladeMat;
  }

  /**
   * Builds a 5-blade sculpted 3D turf clump where each blade is ~4.5 mm slender, arched
   * with staggered height/azimuth, and folded along a central V-midrib for crisp directional shading.
   */
  private createGrassBladeGeometry(): THREE.BufferGeometry {
    const bladeCount = 5;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const ySteps = [0.0, 0.34, 0.70, 1.0];
    const halfWidths = [0.0036, 0.0028, 0.0014, 0.0];
    const droopSteps = [0.0, 0.012, 0.042, 0.088];

    const rng = makeSeededRandom(5519);

    for (let b = 0; b < bladeCount; b++) {
      const yaw = (b / bladeCount) * Math.PI * 2 + (rng() - 0.5) * 0.45;
      const rootRad = b === 0 ? 0.002 : 0.006 + rng() * 0.010;
      const rx = Math.cos(yaw) * rootRad;
      const rz = Math.sin(yaw) * rootRad;
      const hMul = b === 0 ? 1.04 : 0.74 + rng() * 0.32;
      const droopMul = 0.75 + rng() * 0.65;
      const widthMul = 0.85 + rng() * 0.35;

      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const baseV = positions.length / 3;

      for (let r = 0; r < 3; r++) {
        const y = ySteps[r] * hMul;
        const hw = halfWidths[r] * widthMul;
        const fwd = droopSteps[r] * droopMul;
        const ridgeZ = -hw * 0.42; // V-fold midrib relief so blade faces catch sunlit & shaded angles

        // Left edge, central midrib ridge, right edge
        const pts: Array<[number, number, number]> = [
          [-hw, y, fwd],
          [0.0, y, fwd + ridgeZ],
          [hw, y, fwd],
        ];
        for (let c = 0; c < 3; c++) {
          const [lx, ly, lz] = pts[c];
          const wx = rx + lx * cosY + lz * sinY;
          const wz = rz - lx * sinY + lz * cosY;
          positions.push(wx, ly, wz);
          uvs.push(c * 0.5, ySteps[r]);
        }
      }

      // Razor-sharp pointed tip vertex
      const tipFwd = droopSteps[3] * droopMul;
      positions.push(rx + tipFwd * sinY, ySteps[3] * hMul, rz + tipFwd * cosY);
      uvs.push(0.5, 1.0);

      // Connect 3-vertex V-folded rows cleanly
      for (let r = 0; r < 2; r++) {
        const row0 = baseV + r * 3;
        const row1 = row0 + 3;
        indices.push(row0 + 0, row0 + 1, row1 + 0, row0 + 1, row1 + 1, row1 + 0);
        indices.push(row0 + 1, row0 + 2, row1 + 1, row0 + 2, row1 + 2, row1 + 1);
      }
      const rowTop = baseV + 6;
      const tipIdx = baseV + 9;
      indices.push(rowTop + 0, rowTop + 1, tipIdx);
      indices.push(rowTop + 1, rowTop + 2, tipIdx);
    }

    const bladeGeo = new THREE.BufferGeometry();
    bladeGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    bladeGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    bladeGeo.setIndex(indices);
    bladeGeo.computeVertexNormals();
    return bladeGeo;
  }

  private buildCoastalGrass(sampler: HoleTerrainSampler, density: FoliageDensity): void {
    const hole = sampler.hole;
    const targetCount = density === 'high' ? 20000 : density === 'medium' ? 11000 : 5500;
    const rng = makeSeededRandom(hole.holeNumber * 997 + 41);

    const bladeGeo = this.createGrassBladeGeometry();
    const bladeMat = this.createGrassMaterial();

    const instMesh = new THREE.InstancedMesh(bladeGeo, bladeMat, targetCount);
    instMesh.castShadow = false;
    instMesh.receiveShadow = true;

    const { minX, maxX, minZ, maxZ } = hole.bounds;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let placed = 0;
    let attempts = 0;

    while (placed < targetCount && attempts < targetCount * 10) {
      attempts++;
      const x = lerp(minX + 10, maxX - 10, rng());
      const z = lerp(minZ + 10, maxZ - 10, rng());
      const s = sampler.getSurfaceSample(x, z);

      // Focus lush 3D clumps in rough, heavy fescue, bunker brows & coastal edges
      if (s.surface === 'water' || s.surface === 'green' || s.surface === 'tee' || s.surface === 'bunker' || s.surface === 'cart_path') {
        continue;
      }
      if (s.cliffBlend > 0.45 || s.height < 4.5) continue;

      if (s.surface === 'fairway' && rng() > 0.04) continue;
      if (s.surface === 'fringe' && rng() > 0.20) continue;

      const tuftCount = s.surface === 'heavy_rough' ? 2 : 1;
      for (let t = 0; t < tuftCount && placed < targetCount; t++) {
        const jx = x + (rng() - 0.5) * 0.35;
        const jz = z + (rng() - 0.5) * 0.35;
        const jy = sampler.getHeight(jx, jz);

        const heightScale =
          s.surface === 'heavy_rough'
            ? 0.20 + rng() * 0.30
            : s.surface === 'rough'
              ? 0.10 + rng() * 0.14
              : 0.045 + rng() * 0.03;

        dummy.position.set(jx, jy - 0.008, jz);
        dummy.rotation.set(
          (rng() - 0.5) * 0.22,
          rng() * Math.PI * 2,
          (rng() - 0.5) * 0.22
        );
        const wSc = 1.0 + rng() * 0.65;
        dummy.scale.set(wSc, heightScale, wSc);
        dummy.updateMatrix();
        instMesh.setMatrixAt(placed, dummy.matrix);

        if (s.surface === 'heavy_rough' && rng() > 0.48) {
          color.setRGB(0.30 + rng() * 0.15, 0.31 + rng() * 0.10, 0.12 + rng() * 0.05);
        } else {
          color.setRGB(0.09 + rng() * 0.07, 0.23 + rng() * 0.11, 0.06 + rng() * 0.04);
        }
        instMesh.setColorAt(placed, color);
        placed++;
      }
    }

    instMesh.count = placed;
    instMesh.instanceMatrix.needsUpdate = true;
    if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;

    this.grassMesh = instMesh;
    this.scene.add(instMesh);
  }

  /**
   * Allocates a 5x5 toroidal proximity chunk buffer (22.5m x 22.5m sliding field, up to 26,250 clumps / 131,250 3D blades)
   * that streams world-locked grass ahead of camera & ball motion without hitches or post-shot pop-in.
   */
  private buildHeroGrassBuffer(): void {
    this.chunkCap = this.currentDensity === 'high' ? 1050 : this.currentDensity === 'medium' ? 580 : 260;
    const heroCap = GRASS_CHUNK_COUNT * this.chunkCap;
    const bladeGeo = this.createGrassBladeGeometry();
    const bladeMat = this.createGrassMaterial();
    const heroMesh = new THREE.InstancedMesh(bladeGeo, bladeMat, heroCap);
    heroMesh.castShadow = false;
    heroMesh.receiveShadow = true;
    heroMesh.frustumCulled = false;
    heroMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Ensure instanceColor buffer is allocated upfront with DynamicDrawUsage
    heroMesh.setColorAt(0, new THREE.Color(0xffffff));
    if (heroMesh.instanceColor) heroMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    const zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < heroCap; i++) {
      heroMesh.setMatrixAt(i, zeroM);
    }
    heroMesh.count = heroCap;
    heroMesh.instanceMatrix.needsUpdate = true;

    this.chunkGx.fill(999999);
    this.chunkGz.fill(999999);
    this.heroGrassMesh = heroMesh;
    this.scene.add(heroMesh);
  }

  private populateGrassChunk(gx: number, gz: number, slot: number): void {
    if (!this.heroGrassMesh || !this.currentSampler) return;
    const sampler = this.currentSampler;
    const hole = sampler.hole;
    const { minX, maxX, minZ, maxZ } = hole.bounds;
    const x0 = gx * GRASS_CHUNK_SIZE;
    const z0 = gz * GRASS_CHUNK_SIZE;
    const baseOffset = slot * this.chunkCap;
    const dummy = this.tmpDummy;
    const color = this.tmpColor;

    // Skip chunks completely outside hole bounds cleanly
    if (x0 + GRASS_CHUNK_SIZE < minX || x0 > maxX || z0 + GRASS_CHUNK_SIZE < minZ || z0 > maxZ) {
      dummy.position.set(0, -100, 0);
      dummy.scale.set(0, 0, 0);
      dummy.updateMatrix();
      for (let i = 0; i < this.chunkCap; i++) {
        this.heroGrassMesh.setMatrixAt(baseOffset + i, dummy.matrix);
      }
      this.chunkGx[slot] = gx;
      this.chunkGz[slot] = gz;
      return;
    }

    const seed = ((gx * 73856093) ^ (gz * 19349663) ^ (hole.holeNumber * 83492791)) >>> 0;
    const rng = makeSeededRandom(seed);
    const cH = Math.cos(hole.tee.yawRad);
    const sH = Math.sin(hole.tee.yawRad);

    let placed = 0;
    let attempts = 0;
    const maxAttempts = this.chunkCap * 3;

    while (placed < this.chunkCap && attempts < maxAttempts) {
      attempts++;
      const x = x0 + rng() * GRASS_CHUNK_SIZE;
      const z = z0 + rng() * GRASS_CHUNK_SIZE;
      if (x < minX + 1 || x > maxX - 1 || z < minZ + 1 || z > maxZ - 1) continue;

      const s = sampler.getSurfaceSample(x, z);
      if (
        s.surface === 'water' ||
        s.surface === 'green' ||
        s.surface === 'bunker' ||
        s.surface === 'cart_path' ||
        s.cliffBlend > 0.45 ||
        s.height < 3.5
      ) {
        continue;
      }

      const isMowed = s.surface === 'fairway' || s.surface === 'tee' || s.surface === 'fringe';
      const jy = s.height;
      const hScale =
        s.surface === 'tee' || s.surface === 'fringe'
          ? 0.022 + rng() * 0.015
          : s.surface === 'fairway'
            ? 0.028 + rng() * 0.018
            : s.surface === 'rough'
              ? 0.085 + rng() * 0.095
              : 0.16 + rng() * 0.18;

      const rotX = x * cH + z * sH;
      const rotZ = -x * sH + z * cH;
      const mowWave = Math.sin(rotX * 0.92);
      const stripe = Math.max(0, Math.min(1, mowWave * 0.5 + 0.5));
      const mowerLean = isMowed ? mowWave * 0.16 : 0.0;

      dummy.position.set(x, jy - 0.005, z);
      dummy.rotation.set(
        (rng() - 0.5) * 0.24 + sH * mowerLean,
        rng() * Math.PI * 2,
        (rng() - 0.5) * 0.24 - cH * mowerLean
      );
      const wScale = isMowed ? 0.78 + rng() * 0.36 : 1.05 + rng() * 0.52;
      dummy.scale.set(wScale, hScale, wScale);
      dummy.updateMatrix();
      this.heroGrassMesh.setMatrixAt(baseOffset + placed, dummy.matrix);

      if (isMowed) {
        const cross = Math.sin(rotZ * 0.55) * 0.5 + 0.5;
        const stripeMix = stripe * 0.78 + cross * 0.22;
        const bioJitter = (rng() - 0.5) * 0.028;
        color.setRGB(
          Math.max(0.04, 0.078 + stripeMix * 0.052 + bioJitter),
          Math.max(0.10, 0.225 + stripeMix * 0.095 + bioJitter * 1.4),
          Math.max(0.03, 0.058 + stripeMix * 0.028 + bioJitter * 0.6)
        );
      } else if (s.surface === 'heavy_rough' && rng() > 0.48) {
        color.setRGB(0.28 + rng() * 0.14, 0.28 + rng() * 0.10, 0.11 + rng() * 0.05);
      } else {
        color.setRGB(0.08 + rng() * 0.06, 0.20 + rng() * 0.10, 0.05 + rng() * 0.03);
      }
      this.heroGrassMesh.setColorAt(baseOffset + placed, color);
      placed++;
    }

    // Zero-scale unused tail slots inside sparse cliff/water/bunker chunks
    if (placed < this.chunkCap) {
      dummy.position.set(0, -100, 0);
      dummy.scale.set(0, 0, 0);
      dummy.updateMatrix();
      for (let i = placed; i < this.chunkCap; i++) {
        this.heroGrassMesh.setMatrixAt(baseOffset + i, dummy.matrix);
      }
    }

    this.chunkGx[slot] = gx;
    this.chunkGz[slot] = gz;
  }

  public updateHeroTurfAround(cx: number, cz: number, immediate = false, maxBudget = 2): void {
    if (!this.heroGrassMesh || !this.currentSampler) return;

    const centerGx = Math.floor(cx / GRASS_CHUNK_SIZE);
    const centerGz = Math.floor(cz / GRASS_CHUNK_SIZE);

    const dirty: Array<{ gx: number; gz: number; slot: number; dist2: number }> = [];
    const mod = (n: number) => ((n % GRASS_GRID_DIM) + GRASS_GRID_DIM) % GRASS_GRID_DIM;

    for (let dz = -GRASS_GRID_RADIUS; dz <= GRASS_GRID_RADIUS; dz++) {
      const gz = centerGz + dz;
      const slotZ = mod(gz);
      for (let dx = -GRASS_GRID_RADIUS; dx <= GRASS_GRID_RADIUS; dx++) {
        const gx = centerGx + dx;
        const slot = slotZ * GRASS_GRID_DIM + mod(gx);
        if (this.chunkGx[slot] !== gx || this.chunkGz[slot] !== gz) {
          const midX = (gx + 0.5) * GRASS_CHUNK_SIZE;
          const midZ = (gz + 0.5) * GRASS_CHUNK_SIZE;
          const d2 = (midX - cx) * (midX - cx) + (midZ - cz) * (midZ - cz);
          dirty.push({ gx, gz, slot, dist2: d2 });
        }
      }
    }

    if (!dirty.length) return;

    // Stream nearest chunks first so foreground turf is always populated before outer perimeter
    dirty.sort((a, b) => a.dist2 - b.dist2);

    const budget = immediate ? dirty.length : Math.min(maxBudget, dirty.length > 4 ? maxBudget : 1);
    const uploadFull = immediate;

    if (uploadFull) {
      this.heroGrassMesh.instanceMatrix.updateRanges.length = 0;
      if (this.heroGrassMesh.instanceColor) this.heroGrassMesh.instanceColor.updateRanges.length = 0;
    }

    for (let i = 0; i < budget; i++) {
      const item = dirty[i];
      this.populateGrassChunk(item.gx, item.gz, item.slot);
      if (!uploadFull) {
        this.heroGrassMesh.instanceMatrix.updateRanges.push({
          start: item.slot * this.chunkCap * 16,
          count: this.chunkCap * 16,
        });
        if (this.heroGrassMesh.instanceColor) {
          this.heroGrassMesh.instanceColor.updateRanges.push({
            start: item.slot * this.chunkCap * 3,
            count: this.chunkCap * 3,
          });
        }
      }
    }

    this.heroGrassMesh.instanceMatrix.needsUpdate = true;
    if (this.heroGrassMesh.instanceColor) this.heroGrassMesh.instanceColor.needsUpdate = true;
  }

  /**
   * Slender golden coastal fescue seed-plume tufts in heavy rough & coastal dune margins.
   */
  private buildCoastalFescuePlumes(sampler: HoleTerrainSampler, density: FoliageDensity): void {
    const cap = density === 'high' ? 2400 : density === 'medium' ? 1200 : 500;
    const rng = makeSeededRandom(sampler.hole.holeNumber * 1297 + 41);

    // 3 arched slender stalks crowned with soft feathered seed-plume tips
    const pos: number[] = [];
    const norm: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    let vOff = 0;

    for (let s = 0; s < 3; s++) {
      const yaw = (s / 3) * Math.PI * 2 + 0.3;
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const lean = 0.14 + s * 0.03;
      const segs = 4;
      for (let k = 0; k <= segs; k++) {
        const t = k / segs;
        const y = t;
        const arch = t * t * lean;
        // Thin stem rising into feathery seed plume near top 45%
        const halfW = t < 0.52 ? 0.011 * (1 - t * 0.25) : 0.026 * Math.sin(((t - 0.45) / 0.55) * Math.PI);
        const w = Math.max(0.004, halfW);
        const rx = cosY * w;
        const rz = -sinY * w;
        const cx = sinY * arch;
        const cz = cosY * arch;
        pos.push(cx - rx, y, cz - rz, cx + rx, y, cz + rz);
        const nx = sinY * 0.35;
        const nz = cosY * 0.35;
        norm.push(nx, 0.92, nz, nx, 0.92, nz);
        uv.push(0, t, 1, t);
      }
      for (let k = 0; k < segs; k++) {
        const b = vOff + k * 2;
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
      vOff += (segs + 1) * 2;
    }

    const plumeGeo = new THREE.BufferGeometry();
    plumeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    plumeGeo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    plumeGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    plumeGeo.setIndex(idx);

    const plumeMat = this.createGrassMaterial();
    plumeMat.roughness = 0.56;
    const plumeMesh = new THREE.InstancedMesh(plumeGeo, plumeMat, cap);
    plumeMesh.castShadow = false;
    plumeMesh.receiveShadow = true;

    const { minX, maxX, minZ, maxZ } = sampler.hole.bounds;
    const dummy = this.tmpDummy;
    const color = this.tmpColor;
    let placed = 0;
    let attempts = 0;

    while (placed < cap && attempts < cap * 28) {
      attempts++;
      const x = lerp(minX + 10, maxX - 10, rng());
      const z = lerp(minZ + 10, maxZ - 10, rng());
      const s = sampler.getSurfaceSample(x, z);
      if (s.surface !== 'heavy_rough' && !(s.surface === 'rough' && s.cliffBlend > 0.08)) continue;
      if (s.cliffBlend > 0.44 || s.height < 4.5) continue;

      dummy.position.set(x, s.height - 0.01, z);
      dummy.rotation.set((rng() - 0.5) * 0.16, rng() * Math.PI * 2, (rng() - 0.5) * 0.16);
      const hSc = 0.42 + rng() * 0.34;
      const wSc = 0.85 + rng() * 0.6;
      dummy.scale.set(wSc, hSc, wSc);
      dummy.updateMatrix();
      plumeMesh.setMatrixAt(placed, dummy.matrix);

      // Sunlit wheat-gold / coastal straw plume variation
      color.setRGB(0.48 + rng() * 0.18, 0.40 + rng() * 0.14, 0.17 + rng() * 0.08);
      plumeMesh.setColorAt(placed, color);
      placed++;
    }

    plumeMesh.count = placed;
    plumeMesh.instanceMatrix.needsUpdate = true;
    if (plumeMesh.instanceColor) plumeMesh.instanceColor.needsUpdate = true;
    this.fescuePlumeMesh = plumeMesh;
    this.scene.add(plumeMesh);
  }

  /**
   * Low coastal Monterey iceplant & golden cliff-top scrub along rocky cliff brows.
   */
  private buildCoastalIceplant(sampler: HoleTerrainSampler, density: FoliageDensity): void {
    const cap = density === 'high' ? 1800 : density === 'medium' ? 1000 : 450;
    const rng = makeSeededRandom(sampler.hole.holeNumber * 613 + 77);
    const geo = new THREE.DodecahedronGeometry(0.26, 1);
    geo.scale(1.3, 0.42, 1.3);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.84,
      metalness: 0.0,
    });
    const inst = new THREE.InstancedMesh(geo, mat, cap);
    inst.receiveShadow = true;

    const { minX, maxX, minZ, maxZ } = sampler.hole.bounds;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let placed = 0;
    let attempts = 0;

    while (placed < cap && attempts < cap * 24) {
      attempts++;
      const x = lerp(minX + 8, maxX - 8, rng());
      const z = lerp(minZ + 8, maxZ - 8, rng());
      const s = sampler.getSurfaceSample(x, z);
      if (s.cliffBlend < 0.12 || s.cliffBlend > 0.62 || s.height < 4.0) continue;

      dummy.position.set(x, s.height - 0.04, z);
      dummy.rotation.set((rng() - 0.5) * 0.4, rng() * Math.PI * 2, (rng() - 0.5) * 0.4);
      const sc = 0.7 + rng() * 1.4;
      dummy.scale.set(sc, sc * (0.7 + rng() * 0.5), sc);
      dummy.updateMatrix();
      inst.setMatrixAt(placed, dummy.matrix);

      // Mix of deep succulent olive, magenta Monterey iceplant bloom & coastal golden bush
      const r = rng();
      if (r > 0.78) {
        color.setRGB(0.68, 0.22, 0.46); // Coastal iceplant blossom
      } else if (r > 0.64) {
        color.setRGB(0.66, 0.52, 0.16); // Coastal California poppy/bush
      } else {
        color.setRGB(0.14 + rng() * 0.08, 0.24 + rng() * 0.08, 0.10 + rng() * 0.04);
      }
      inst.setColorAt(placed, color);
      placed++;
    }

    inst.count = placed;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    this.iceplantMesh = inst;
    this.scene.add(inst);
  }

  private createCanopyTemplate(kind: 'cypress_pad' | 'pine_tuft' | 'edge_spray'): {
    pos: Float32Array;
    norm: Float32Array;
    uv: Float32Array;
    shade: Float32Array;
    idx: Uint16Array;
  } {
    // Multi-shell curved botanical canopy primitives with spherified normals + core-to-tip shading
    const shells: THREE.BufferGeometry[] = [];
    const width = kind === 'cypress_pad' ? 3.55 : kind === 'pine_tuft' ? 2.85 : 2.55;
    const height = kind === 'cypress_pad' ? 2.05 : kind === 'pine_tuft' ? 2.65 : 1.75;

    const addCurvedShell = (yaw: number, pitch: number, roll: number, w: number, h: number, bow: number) => {
      const g = new THREE.PlaneGeometry(w, h, 3, 2);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const px = p.getX(i);
        const py = p.getY(i);
        const rNorm2 = (px * px) / (w * w * 0.30) + (py * py) / (h * h * 0.34);
        const pz = (1.0 - rNorm2) * w * bow;
        p.setXYZ(i, px, py, pz);
      }
      g.rotateX(pitch);
      g.rotateZ(roll);
      g.rotateY(yaw);
      shells.push(g);
    };

    if (kind === 'cypress_pad') {
      // 3 crossed curved layers + angled upper dome pad -> lush billowing Monterey Cypress cloud-tiers from any camera angle
      addCurvedShell(0.0, -0.14, 0.04, width, height, 0.17);
      addCurvedShell(Math.PI * 0.35, 0.12, -0.06, width * 0.94, height * 0.96, 0.16);
      addCurvedShell(Math.PI * 0.70, -0.10, 0.05, width * 0.90, height * 0.92, 0.16);
      addCurvedShell(Math.PI * 0.18, -Math.PI * 0.36, 0.0, width * 0.88, width * 0.78, 0.18);
    } else if (kind === 'pine_tuft') {
      // Open airy 3D needle starburst tuft for Monterey/Torrey Pine crowns
      addCurvedShell(0.0, 0.18, 0.08, width, height, 0.15);
      addCurvedShell(Math.PI / 3, -0.22, -0.08, width * 0.96, height * 0.98, 0.15);
      addCurvedShell((Math.PI * 2) / 3, 0.16, 0.06, width * 0.92, height * 0.95, 0.15);
    } else {
      // Asymmetric wispy outer branch fringe spray
      addCurvedShell(0.0, -0.22, 0.12, width, height, 0.14);
      addCurvedShell(Math.PI * 0.46, 0.18, -0.10, width * 0.88, height * 0.90, 0.14);
    }

    let totalVerts = 0;
    let totalIdx = 0;
    for (const s of shells) {
      totalVerts += s.attributes.position.count;
      totalIdx += s.index!.count;
    }

    const pos = new Float32Array(totalVerts * 3);
    const norm = new Float32Array(totalVerts * 3);
    const uv = new Float32Array(totalVerts * 2);
    const shade = new Float32Array(totalVerts);
    const idx = new Uint16Array(totalIdx);

    let vOff = 0;
    let iOff = 0;
    const tmpN = new THREE.Vector3();
    const maxR = Math.max(width, height) * 0.52;

    for (const s of shells) {
      const sp = s.attributes.position;
      const suv = s.attributes.uv;
      const sidx = s.index!;
      for (let i = 0; i < sp.count; i++) {
        const vx = sp.getX(i);
        const vy = sp.getY(i);
        const vz = sp.getZ(i);
        const vi = vOff + i;
        pos[vi * 3] = vx;
        pos[vi * 3 + 1] = vy;
        pos[vi * 3 + 2] = vz;
        tmpN.set(vx, vy * 1.18 + height * 0.24, vz).normalize();
        norm[vi * 3] = tmpN.x;
        norm[vi * 3 + 1] = tmpN.y;
        norm[vi * 3 + 2] = tmpN.z;
        uv[vi * 2] = suv.getX(i);
        uv[vi * 2 + 1] = suv.getY(i);

        // Radial & vertical botanical shade factor (0 = shaded inner core, 1 = sunlit outer needle tips)
        const distRatio = Math.min(1, Math.hypot(vx, vy, vz) / maxR);
        const upRatio = Math.min(1, Math.max(0, (vy / (height * 0.5)) * 0.5 + 0.5));
        shade[vi] = Math.min(1, Math.max(0, distRatio * 0.56 + upRatio * 0.44));
      }
      for (let i = 0; i < sidx.count; i++) {
        idx[iOff + i] = sidx.getX(i) + vOff;
      }
      vOff += sp.count;
      iOff += sidx.count;
      s.dispose();
    }

    return { pos, norm, uv, shade, idx };
  }

  private buildMontereyTrees(sampler: HoleTerrainSampler): void {
    const trees = sampler.hole.trees;
    if (!trees.length) return;

    const group = new THREE.Group();

    const swayUniforms: Record<string, THREE.IUniform> = {
      uTime: { value: 0 },
      uWindSpeed: { value: 5.0 },
      uWindDir: { value: new THREE.Vector2(0.7, -0.7) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.6, -0.5).normalize() },
      uCloudOffset: { value: new THREE.Vector2() },
      uCloudCoverage: { value: 0.49 },
      uMistColor: { value: new THREE.Color(0xc0d9eb) },
      uMistDensity: { value: 0.0045 },
    };
    this.treeSwayUniforms = swayUniforms;

    // Shared cloud/mist GLSL helpers for both bark and foliage batches
    const sharedEnvFrag = /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec2 uCloudOffset;
      uniform float uCloudCoverage;
      uniform vec3 uMistColor;
      uniform float uMistDensity;
      varying vec3 vCanopyWorld;

      float tcHash(vec2 p) {
        p = fract(p * vec2(234.34, 435.345));
        p += dot(p, p + 34.23);
        return fract(p.x * p.y);
      }
      float tcNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(tcHash(i), tcHash(i + vec2(1.0, 0.0)), f.x),
                   mix(tcHash(i + vec2(0.0, 1.0)), tcHash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float tcCloudShadow(vec3 wp) {
        vec2 uv = wp.xz * 0.0042 + uCloudOffset * 1.15 - (uSunDir.xz / max(uSunDir.y + 0.18, 0.25)) * 0.28;
        float d = tcNoise(uv * 1.15) * 0.55 + tcNoise(uv * 2.35) * 0.30 + tcNoise(uv * 4.7) * 0.15;
        return 1.0 - smoothstep(uCloudCoverage - 0.03, uCloudCoverage + 0.28, d) * 0.50;
      }
    `;

    // 1. Batched 4K Furrowed Coastal Bark Material (with wind sway locked at roots via aSwayAmp)
    const barkMat = new THREE.MeshStandardMaterial({
      map: this.textures.barkMap,
      normalMap: this.textures.barkNormal,
      normalScale: new THREE.Vector2(1.38, 1.38),
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.0,
    });
    barkMat.customProgramCacheKey = () => 'bark-4k-v3';
    barkMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, swayUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          attribute float aSwayAmp;
          uniform float uTime;
          uniform float uWindSpeed;
          uniform vec2 uWindDir;
          varying vec3 vCanopyWorld;
        `
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          #include <begin_vertex>
          float wFactor = 0.22 + 0.14 * uWindSpeed;
          float bMacro = sin(uTime * 0.95 + position.x * 0.14 + position.z * 0.11);
          float bGust = sin(uTime * 1.65 - position.x * 0.09 + position.z * 0.17) * 0.45;
          float bDisp = (bMacro + bGust + 0.25) * 0.085 * wFactor * aSwayAmp;
          transformed.x += uWindDir.x * bDisp;
          transformed.z += uWindDir.y * bDisp;
          vCanopyWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        `
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${sharedEnvFrag}`)
        .replace(
          '#include <lights_fragment_end>',
          /* glsl */ `
          #include <lights_fragment_end>
          float bCloud = tcCloudShadow(vCanopyWorld);
          reflectedLight.directDiffuse *= bCloud;
          reflectedLight.directSpecular *= bCloud;
        `
        )
        .replace(
          '#include <fog_fragment>',
          /* glsl */ `
          #include <fog_fragment>
          float cDist = length(cameraPosition - vCanopyWorld);
          float cMistElev = exp(-max(0.0, vCanopyWorld.y - 1.5) * 0.14);
          float cMist = clamp((1.0 - exp(-cDist * uMistDensity * 1.55)) * cMistElev, 0.0, 0.58);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uMistColor, cMist);
        `
        );
    };

    // 2. Species-Specific 4K Canopy Shader Builder (Monterey Cypress vs Monterey Pine)
    const createCanopyMaterial = (
      map: THREE.Texture,
      key: string,
      roughness: number,
      translucencyTint: THREE.Vector3
    ): THREE.MeshStandardMaterial => {
      const mat = new THREE.MeshStandardMaterial({
        map,
        // Alpha-to-coverage lets the MSAA target (up to 4 samples, allocated in
        // PostProcessing) resolve the needle cutout analytically instead of a hard
        // binary discard. That kills the crawling/thinning edges and the white fringing
        // you get from alphaTest + mipmaps at distance. The threshold can come down
        // sharply because coverage now handles the soft transition.
        alphaTest: 0.12,
        alphaToCoverage: true,
        vertexColors: true,
        side: THREE.DoubleSide,
        roughness,
        metalness: 0.0,
      });
      mat.customProgramCacheKey = () => key;
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, swayUniforms);
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            /* glsl */ `
            #include <common>
            attribute float aSwayAmp;
            uniform float uTime;
            uniform float uWindSpeed;
            uniform vec2 uWindDir;
            varying vec3 vCanopyWorld;
            varying vec3 vCanopyNormal;
            varying vec2 vLeafUv;
          `
          )
          .replace(
            '#include <begin_vertex>',
            /* glsl */ `
            #include <begin_vertex>
            vLeafUv = uv;
            float wFactor = 0.22 + 0.14 * uWindSpeed;
            float bMacro = sin(uTime * 0.95 + position.x * 0.14 + position.z * 0.11);
            float bGust = sin(uTime * 1.65 - position.x * 0.09 + position.z * 0.17) * 0.45;
            float limbDisp = (bMacro + bGust + 0.25) * 0.085 * wFactor * aSwayAmp;
            float leafFlutter = sin(uTime * 2.7 + position.x * 1.45 + position.y * 1.9 + position.z * 1.25)
              * 0.045 * wFactor * (0.35 + 0.65 * aSwayAmp);
            transformed.x += uWindDir.x * limbDisp + leafFlutter;
            transformed.y += leafFlutter * 0.45;
            transformed.z += uWindDir.y * limbDisp - leafFlutter * 0.65;
            vCanopyWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
            vCanopyNormal = normalize(mat3(modelMatrix) * objectNormal);
          `
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            /* glsl */ `
            #include <common>
            varying vec3 vCanopyNormal;
            varying vec2 vLeafUv;
            ${sharedEnvFrag}
          `
          )
          .replace(
            '#include <map_fragment>',
            /* glsl */ `
            #include <map_fragment>
            // Close-up micro-needle crispness & waxy outer scale glint modulation
            float microFoliage = tcNoise(vCanopyWorld.xz * 7.5 + vLeafUv * 18.0);
            diffuseColor.rgb *= (0.88 + 0.24 * microFoliage);
          `
          )
          .replace(
            '#include <normal_fragment_maps>',
            /* glsl */ `
            #include <normal_fragment_maps>
            // The needle sprays ship as albedo + alpha only, which leaves every frond
            // perfectly flat-shaded (no normal map, no tangent basis). Derive needle-sized
            // relief cheaply in-shader from the luminance of the spray card: dense needle
            // cores read convex, the soft gaps between fascicles read concave, so the
            // canopy catches light like geometry.
            {
              float lTexel = 1.0 / 512.0;
              float lC = dot(texture2D(map, vLeafUv).rgb, vec3(0.2126, 0.7152, 0.0722));
              float lX = dot(texture2D(map, vLeafUv + vec2(lTexel, 0.0)).rgb, vec3(0.2126, 0.7152, 0.0722));
              float lY = dot(texture2D(map, vLeafUv + vec2(0.0, lTexel)).rgb, vec3(0.2126, 0.7152, 0.0722));
              float lA = texture2D(map, vLeafUv).a;
              vec2 slope = vec2(lX - lC, lY - lC) * 2.0 + vec2(1.0 - lA) * 0.35;
              // View-space basis around the geometric normal (no TBN is available here
              // because the canopy carries no tangent-space normal map).
              vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
              vec3 rightV = normalize(cross(upV, normal) + vec3(1e-5));
              vec3 upT = cross(normal, rightV);
              normal = normalize(normal - (rightV * slope.x + upT * slope.y) * 1.65);
            }
          `
          )
          .replace(
            '#include <lights_fragment_end>',
            /* glsl */ `
            #include <lights_fragment_end>
            float cCloud = tcCloudShadow(vCanopyWorld);
            reflectedLight.directDiffuse *= cCloud;
            reflectedLight.directSpecular *= cCloud;
            // Canopy sky-dome occlusion: shaded underside vs sunlit crown top
            float canopySkyBias = 0.62 + 0.38 * clamp(vCanopyNormal.y * 0.5 + 0.5, 0.0, 1.0);
            reflectedLight.indirectDiffuse *= canopySkyBias;
            vec3 cView = normalize(cameraPosition - vCanopyWorld);
            float cBack = pow(clamp(dot(cView, -uSunDir), 0.0, 1.0), 3.0) * cCloud;
            reflectedLight.directDiffuse += vec3(${translucencyTint.x.toFixed(3)}, ${translucencyTint.y.toFixed(3)}, ${translucencyTint.z.toFixed(3)}) * cBack * 0.44;
          `
          )
          .replace(
            '#include <fog_fragment>',
            /* glsl */ `
            #include <fog_fragment>
            vec3 cMDir = normalize(vCanopyWorld - cameraPosition);
            float cSunScat = pow(max(dot(cMDir, uSunDir), 0.0), 4.0);
            float cDist = length(cameraPosition - vCanopyWorld);
            float cMistElev = exp(-max(0.0, vCanopyWorld.y - 1.5) * 0.14);
            float cMist = clamp((1.0 - exp(-cDist * uMistDensity * 1.55)) * cMistElev, 0.0, 0.58);
            vec3 cAerial = mix(uMistColor, uMistColor * vec3(1.12, 1.02, 0.88), cSunScat * 0.35);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, cAerial, cMist);
          `
          );
      };
      return mat;
    };

    const cypressMat = createCanopyMaterial(
      this.textures.cypressFoliageMap,
      'monterey-canopy-4k-v3-cypress',
      0.75,
      new THREE.Vector3(0.15, 0.25, 0.05)
    );
    const pineMat = createCanopyMaterial(
      this.textures.pineFoliageMap,
      'monterey-canopy-4k-v3-pine',
      0.72,
      new THREE.Vector3(0.18, 0.26, 0.06)
    );

    const cypressDepthMat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: this.textures.cypressFoliageMap,
      alphaTest: 0.12,
      alphaToCoverage: true,
      side: THREE.DoubleSide,
    });
    const pineDepthMat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: this.textures.pineFoliageMap,
      alphaTest: 0.12,
      alphaToCoverage: true,
      side: THREE.DoubleSide,
    });

    // Geometry accumulators for single-batch hole rendering (3 draw calls total!)
    const makeBatch = () => ({
      pos: [] as number[],
      norm: [] as number[],
      uv: [] as number[],
      col: [] as number[],
      sway: [] as number[],
      idx: [] as number[],
    });
    const barkBatch = makeBatch();
    const cypressBatch = makeBatch();
    const pineBatch = makeBatch();

    const tplCypressPad = this.createCanopyTemplate('cypress_pad');
    const tplPineTuft = this.createCanopyTemplate('pine_tuft');
    const tplEdgeSpray = this.createCanopyTemplate('edge_spray');

    // Scratch math objects (allocated once)
    const qTransport = new THREE.Quaternion();
    const prevT = new THREE.Vector3();
    const curT = new THREE.Vector3();
    const frameN = new THREE.Vector3();
    const frameB = new THREE.Vector3();
    const refUp = new THREE.Vector3();
    const tmpCol = new THREE.Color();
    const tmpV = new THREE.Vector3();
    const tmpN = new THREE.Vector3();

    const appendTube = (
      batch: ReturnType<typeof makeBatch>,
      points: THREE.Vector3[],
      radii: number[],
      radialSegs: number,
      baseCol: THREE.Color,
      topCol: THREE.Color,
      uScale: number,
      vScale: number,
      swayStart: number,
      swayEnd: number,
      gnarlSeed: number,
      gnarlAmp: number
    ) => {
      const nRings = points.length;
      if (nRings < 2) return;
      const vStart = batch.pos.length / 3;
      const ringStride = radialSegs + 1;
      let cumDist = 0;

      for (let i = 0; i < nRings; i++) {
        const p = points[i];
        const t = i / (nRings - 1);
        if (i === 0) {
          curT.subVectors(points[1], points[0]).normalize();
          refUp.set(Math.abs(curT.y) < 0.88 ? 0 : 1, Math.abs(curT.y) < 0.88 ? 1 : 0, 0);
          frameN.crossVectors(refUp, curT).normalize();
          frameB.crossVectors(curT, frameN).normalize();
        } else {
          cumDist += p.distanceTo(points[i - 1]);
          prevT.copy(curT);
          if (i < nRings - 1) {
            curT.subVectors(points[i + 1], points[i - 1]).normalize();
          } else {
            curT.subVectors(points[i], points[i - 1]).normalize();
          }
          qTransport.setFromUnitVectors(prevT, curT);
          frameN.applyQuaternion(qTransport);
          frameN.addScaledVector(curT, -frameN.dot(curT)).normalize();
          frameB.crossVectors(curT, frameN).normalize();
        }

        const swayVal = lerp(swayStart, swayEnd, t * t);
        tmpCol.copy(baseCol).lerp(topCol, t);
        // Subtle flared root buttress & bole fluting near base
        const fluteWeight = gnarlAmp * (1.0 - 0.55 * t);

        for (let j = 0; j <= radialSegs; j++) {
          const uFrac = j / radialSegs;
          const theta = uFrac * Math.PI * 2;
          const c = Math.cos(theta);
          const s = Math.sin(theta);
          const gnarl =
            1.0 +
            fluteWeight *
              (Math.sin(theta * 3.0 + t * 4.5 + gnarlSeed) * 0.65 +
                Math.cos(theta * 5.0 - t * 6.0 + gnarlSeed * 1.7) * 0.35);
          const rad = radii[i] * gnarl;
          const nx = frameN.x * c + frameB.x * s;
          const ny = frameN.y * c + frameB.y * s;
          const nz = frameN.z * c + frameB.z * s;

          batch.pos.push(p.x + nx * rad, p.y + ny * rad, p.z + nz * rad);
          batch.norm.push(nx, ny, nz);
          batch.uv.push(uFrac * uScale, cumDist * vScale);

          const skyShade = 0.86 + 0.18 * Math.max(-0.4, ny);
          batch.col.push(tmpCol.r * skyShade, tmpCol.g * skyShade, tmpCol.b * skyShade);
          batch.sway.push(swayVal);
        }
      }

      for (let i = 0; i < nRings - 1; i++) {
        const r0 = vStart + i * ringStride;
        const r1 = vStart + (i + 1) * ringStride;
        for (let j = 0; j < radialSegs; j++) {
          const a = r0 + j;
          const b = r1 + j;
          const c = r1 + j + 1;
          const d = r0 + j + 1;
          batch.idx.push(a, d, b, d, c, b);
        }
      }
    };

    const appendSpray = (
      batch: ReturnType<typeof makeBatch>,
      tpl: ReturnType<FoliageSystem['createCanopyTemplate']>,
      center: THREE.Vector3,
      quat: THREE.Quaternion,
      scaleVec: THREE.Vector3,
      coreCol: THREE.Color,
      tipCol: THREE.Color,
      swayAmp: number
    ) => {
      const vStart = batch.pos.length / 3;
      const vCount = tpl.pos.length / 3;
      for (let i = 0; i < vCount; i++) {
        tmpV.set(
          tpl.pos[i * 3] * scaleVec.x,
          tpl.pos[i * 3 + 1] * scaleVec.y,
          tpl.pos[i * 3 + 2] * scaleVec.z
        );
        tmpV.applyQuaternion(quat).add(center);
        tmpN.set(tpl.norm[i * 3], tpl.norm[i * 3 + 1], tpl.norm[i * 3 + 2]).applyQuaternion(quat).normalize();
        batch.pos.push(tmpV.x, tmpV.y, tmpV.z);
        batch.norm.push(tmpN.x, tmpN.y, tmpN.z);
        batch.uv.push(tpl.uv[i * 2], tpl.uv[i * 2 + 1]);

        tmpCol.copy(coreCol).lerp(tipCol, tpl.shade[i]);
        batch.col.push(tmpCol.r, tmpCol.g, tmpCol.b);
        batch.sway.push(swayAmp);
      }
      for (let i = 0; i < tpl.idx.length; i++) {
        batch.idx.push(vStart + tpl.idx[i]);
      }
    };

    // Build every tree into the unified batches with distinct botanical archetypes!
    for (const def of trees) {
      this.appendCoastalTreeToBatches(
        def,
        sampler,
        barkBatch,
        def.species === 'cypress' ? cypressBatch : pineBatch,
        tplCypressPad,
        tplPineTuft,
        tplEdgeSpray,
        appendTube,
        appendSpray
      );
    }

    const finalizeBatch = (
      batch: ReturnType<typeof makeBatch>,
      mat: THREE.Material,
      depthMat?: THREE.Material
    ) => {
      if (!batch.idx.length) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(batch.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(batch.norm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uv, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(batch.col, 3));
      geo.setAttribute('aSwayAmp', new THREE.Float32BufferAttribute(batch.sway, 1));
      geo.setIndex(batch.idx);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (depthMat) mesh.customDepthMaterial = depthMat;
      group.add(mesh);
    };

    finalizeBatch(barkBatch, barkMat);
    finalizeBatch(cypressBatch, cypressMat, cypressDepthMat);
    finalizeBatch(pineBatch, pineMat, pineDepthMat);

    this.treeGroup = group;
    this.scene.add(group);
  }

  private appendCoastalTreeToBatches(
    def: CoastalTreeDef,
    sampler: HoleTerrainSampler,
    barkBatch: { pos: number[]; norm: number[]; uv: number[]; col: number[]; sway: number[]; idx: number[] },
    foliageBatch: { pos: number[]; norm: number[]; uv: number[]; col: number[]; sway: number[]; idx: number[] },
    tplCypressPad: ReturnType<FoliageSystem['createCanopyTemplate']>,
    tplPineTuft: ReturnType<FoliageSystem['createCanopyTemplate']>,
    tplEdgeSpray: ReturnType<FoliageSystem['createCanopyTemplate']>,
    appendTube: (
      batch: { pos: number[]; norm: number[]; uv: number[]; col: number[]; sway: number[]; idx: number[] },
      points: THREE.Vector3[],
      radii: number[],
      radialSegs: number,
      baseCol: THREE.Color,
      topCol: THREE.Color,
      uScale: number,
      vScale: number,
      swayStart: number,
      swayEnd: number,
      gnarlSeed: number,
      gnarlAmp: number
    ) => void,
    appendSpray: (
      batch: { pos: number[]; norm: number[]; uv: number[]; col: number[]; sway: number[]; idx: number[] },
      tpl: ReturnType<FoliageSystem['createCanopyTemplate']>,
      center: THREE.Vector3,
      quat: THREE.Quaternion,
      scaleVec: THREE.Vector3,
      coreCol: THREE.Color,
      tipCol: THREE.Color,
      swayAmp: number
    ) => void
  ): void {
    const rng = makeSeededRandom(def.seed);
    const groundY = sampler.getHeight(def.x, def.z);
    const origin = new THREE.Vector3(def.x, groundY - 0.18, def.z);

    // Choose one of 5 distinct coastal botanical archetypes!
    const archRoll = rng();
    const archetype:
      | 'windswept_lone_cypress'
      | 'split_twin_cypress'
      | 'broad_coastal_cypress'
      | 'tall_monterey_pine'
      | 'umbrella_sea_pine' =
      def.species === 'cypress'
        ? archRoll < 0.38
          ? 'windswept_lone_cypress'
          : archRoll < 0.70
            ? 'split_twin_cypress'
            : 'broad_coastal_cypress'
        : archRoll < 0.56
          ? 'tall_monterey_pine'
          : 'umbrella_sea_pine';

    const sc = def.scale * (def.species === 'cypress' ? 1.12 : 1.04) * (0.90 + rng() * 0.22);
    const windAngle = def.windBendRad + (rng() - 0.5) * 0.42;
    const windDx = Math.sin(windAngle);
    const windDz = -Math.cos(windAngle);

    // Per-tree bark tint multiplier (works over 1024px furrowed barkMap without double-darkening!)
    const barkStyle = rng();
    const barkBaseCol = new THREE.Color().setRGB(
      0.74 + (barkStyle - 0.5) * 0.18 + (rng() - 0.5) * 0.10,
      0.70 + (rng() - 0.5) * 0.12,
      0.66 - (barkStyle - 0.5) * 0.10 + (rng() - 0.5) * 0.10
    );
    // Root-collar darkened mossy bark vs sun-bleached upper ridge bark
    const barkRootCol = new THREE.Color(
      barkBaseCol.r * 0.62,
      barkBaseCol.g * 0.72,
      barkBaseCol.b * 0.58
    );
    const barkUpperCol = new THREE.Color(
      Math.min(1.15, barkBaseCol.r * (1.08 + barkStyle * 0.16)),
      Math.min(1.15, barkBaseCol.g * (1.08 + barkStyle * 0.16)),
      Math.min(1.15, barkBaseCol.b * (1.06 + barkStyle * 0.18))
    );

    // Per-tree chlorophyll tint & core-to-tip AO multiplier (applied over already-colored 1024px foliage maps)
    const hueShift = (rng() - 0.5) * 0.06;
    const valShift = (rng() - 0.5) * 0.14;
    const treeCoreCol = new THREE.Color().setRGB(
      0.56 + hueShift * 0.9 + valShift * 0.4,
      0.66 + valShift * 0.5,
      0.58 - hueShift * 0.7 + valShift * 0.4
    );
    const treeTipCol = new THREE.Color().setRGB(
      Math.min(1.22, 0.98 + hueShift * 1.4 + valShift),
      Math.min(1.22, 1.06 + valShift),
      Math.min(1.15, 0.88 - hueShift * 1.1 + valShift * 0.7)
    );
    const sprayQuat = new THREE.Quaternion();
    const sprayEuler = new THREE.Euler();
    const sprayScale = new THREE.Vector3();

    // Helper: stamp a cluster of varied multi-shell sprays at a limb tip
    const stampFoliageCluster = (
      tipPos: THREE.Vector3,
      count: number,
      baseW: number,
      baseH: number,
      spreadR: number,
      isCypress: boolean,
      sunBias: number,
      swayAmp: number
    ) => {
      const innerCore = treeCoreCol.clone().multiplyScalar(0.78 + 0.22 * sunBias);
      const outerTip = treeTipCol.clone().multiplyScalar(0.92 + 0.22 * sunBias);
      for (let k = 0; k < count; k++) {
        const ang = rng() * Math.PI * 2;
        const rad = Math.pow(rng(), 0.72) * spreadR;
        const pos = new THREE.Vector3(
          tipPos.x + Math.cos(ang) * rad + windDx * 0.22 * sc,
          tipPos.y + (rng() - 0.36) * spreadR * (isCypress ? 0.34 : 0.68),
          tipPos.z + Math.sin(ang) * rad + windDz * 0.22 * sc
        );
        sprayEuler.set(
          (rng() - 0.5) * (isCypress ? 0.30 : 0.65) - (isCypress ? 0.08 : 0.0),
          rng() * Math.PI * 2,
          (rng() - 0.5) * (isCypress ? 0.26 : 0.55)
        );
        sprayQuat.setFromEuler(sprayEuler);
        const sMul = 0.74 + rng() * 0.54;
        sprayScale.set(baseW * sMul, baseH * sMul * (0.86 + rng() * 0.28), baseW * sMul);
        const tpl =
          k === count - 1 && rng() > 0.42
            ? tplEdgeSpray
            : isCypress
              ? tplCypressPad
              : tplPineTuft;
        appendSpray(foliageBatch, tpl, pos, sprayQuat, sprayScale, innerCore, outerTip, swayAmp);
      }
    };

    // Helper: grow flared surface root buttresses gripping coastal soil
    const buildRoots = (baseR: number, rootCount: number) => {
      for (let r = 0; r < rootCount; r++) {
        const rAng = (r / rootCount) * Math.PI * 2 + (rng() - 0.5) * 0.55;
        const dx = Math.cos(rAng);
        const dz = Math.sin(rAng);
        const rLen = baseR * (2.6 + rng() * 1.9);
        const rPts: THREE.Vector3[] = [];
        const rRads: number[] = [];
        for (let i = 0; i <= 3; i++) {
          const t = i / 3;
          const dist = rLen * t;
          const wx = origin.x + dx * dist;
          const wz = origin.z + dz * dist;
          const gy = sampler.getHeight(wx, wz);
          const py = lerp(origin.y + baseR * 1.45, gy - 0.22, Math.pow(t, 0.72));
          rPts.push(new THREE.Vector3(wx, py, wz));
          rRads.push(baseR * lerp(0.56, 0.11, t));
        }
        appendTube(barkBatch, rPts, rRads, 5, barkRootCol, barkRootCol, 1.5, 0.45, 0, 0, def.seed + r * 31, 0.14);
      }
    };

    // Helper: grow main curved spline trunk + optional twin split + forked boughs
    const baseRad = (archetype === 'tall_monterey_pine' ? 0.34 : 0.44) * sc;
    buildRoots(baseRad, archetype === 'tall_monterey_pine' ? 3 : 4 + (rng() > 0.5 ? 1 : 0));

    const growLimbWithSubBranches = (
      startPos: THREE.Vector3,
      dirHint: THREE.Vector3,
      limbLen: number,
      startRad: number,
      isCypress: boolean,
      heightRatio: number
    ) => {
      const nPts = 5;
      const pts: THREE.Vector3[] = [];
      const rads: number[] = [];
      const cur = startPos.clone();
      const stepDir = dirHint.clone().normalize();
      const swayVal = 0.35 + 0.55 * heightRatio;

      for (let i = 0; i < nPts; i++) {
        const t = i / (nPts - 1);
        pts.push(cur.clone());
        rads.push(startRad * lerp(1.0, 0.22, Math.pow(t, 0.85)));
        if (i < nPts - 1) {
          // Cypress boughs twist horizontally & sweep up near tips; pine boughs stay straighter
          const droop = isCypress ? Math.sin(t * Math.PI) * 0.14 + t * 0.28 : 0.12;
          stepDir.x += windDx * (isCypress ? 0.22 : 0.08) + (rng() - 0.5) * 0.26;
          stepDir.z += windDz * (isCypress ? 0.22 : 0.08) + (rng() - 0.5) * 0.26;
          stepDir.y += droop;
          stepDir.normalize();
          cur.addScaledVector(stepDir, limbLen / (nPts - 1));
        }
      }
      appendTube(
        barkBatch,
        pts,
        rads,
        5,
        barkBaseCol.clone().multiplyScalar(0.84),
        barkUpperCol,
        1.2,
        0.55,
        heightRatio * 0.45,
        swayVal,
        def.seed + Math.round(heightRatio * 97),
        0.08
      );

      // Fork 2–3 secondary sub-limbs near outer 55–100% of bough
      const forkCount = isCypress ? 3 : 2;
      for (let f = 0; f < forkCount; f++) {
        const attachIdx = f === 0 ? 2 : 3;
        const forkStart = pts[attachIdx];
        const forkYaw = Math.atan2(stepDir.z, stepDir.x) + (f - (forkCount - 1) * 0.5) * (0.72 + rng() * 0.35);
        const forkLen = limbLen * (0.38 + rng() * 0.26);
        const forkEnd = new THREE.Vector3(
          forkStart.x + Math.cos(forkYaw) * forkLen + windDx * 0.28 * sc,
          forkStart.y + (0.28 + rng() * 0.65) * sc,
          forkStart.z + Math.sin(forkYaw) * forkLen + windDz * 0.28 * sc
        );
        const forkMid = forkStart.clone().lerp(forkEnd, 0.5);
        forkMid.y += (rng() - 0.25) * 0.35 * sc;
        appendTube(
          barkBatch,
          [forkStart, forkMid, forkEnd],
          [rads[attachIdx] * 0.72, rads[attachIdx] * 0.44, 0.025 * sc],
          4,
          barkBaseCol,
          barkUpperCol,
          1.0,
          0.6,
          swayVal * 0.78,
          Math.min(1, swayVal + 0.12),
          def.seed + f * 53,
          0.05
        );

        stampFoliageCluster(
          forkEnd,
          isCypress ? 3 : 3,
          (isCypress ? 0.92 : 0.84) * sc,
          (isCypress ? 0.74 : 0.92) * sc,
          (isCypress ? 1.45 : 1.15) * sc,
          isCypress,
          heightRatio * 0.75 + (f === 1 ? 0.25 : 0.1),
          Math.min(1, swayVal + 0.15)
        );
      }

      // Terminal main crown pad
      stampFoliageCluster(
        pts[nPts - 1],
        isCypress ? 4 : 3,
        (isCypress ? 1.05 : 0.90) * sc,
        (isCypress ? 0.78 : 0.96) * sc,
        (isCypress ? 1.55 : 1.25) * sc,
        isCypress,
        heightRatio,
        Math.min(1, swayVal + 0.18)
      );
    };

    const buildSplineTrunk = (
      startPos: THREE.Vector3,
      height: number,
      rStart: number,
      rEnd: number,
      leanStrength: number,
      swayTop: number,
      seedOff: number,
      spreadVec?: THREE.Vector3
    ): THREE.Vector3[] => {
      const rings = 9;
      const pts: THREE.Vector3[] = [];
      const rads: number[] = [];
      const p = startPos.clone();
      const sCurvePhase = rng() * Math.PI * 2;
      const latSign = rng() > 0.5 ? 1 : -1;

      for (let i = 0; i < rings; i++) {
        const t = i / (rings - 1);
        const pt = p.clone();
        if (spreadVec) {
          pt.addScaledVector(spreadVec, Math.pow(t, 0.85));
        }
        pts.push(pt);
        // Dramatic flared collar near ground, organic knotted swells mid-trunk
        const buttressFlare = t < 0.22 ? 1.0 + Math.pow((0.22 - t) / 0.22, 1.8) * 0.42 : 1.0;
        const gnarlSwell = 1.0 + 0.06 * Math.sin(t * 9.0 + seedOff);
        rads.push(lerp(rStart, rEnd, Math.pow(t, 0.78)) * buttressFlare * gnarlSwell);

        if (i < rings - 1) {
          const stepH = height / (rings - 1);
          const windPush = leanStrength * (0.35 + 1.15 * t) * stepH;
          const snake = Math.sin(t * Math.PI * 1.65 + sCurvePhase) * 0.22 * latSign * stepH;
          p.x += windDx * windPush + (-windDz) * snake + (rng() - 0.5) * 0.22 * sc;
          p.z += windDz * windPush + windDx * snake + (rng() - 0.5) * 0.22 * sc;
          p.y += stepH * (1.0 - 0.16 * Math.min(1, leanStrength));
        }
      }

      appendTube(
        barkBatch,
        pts,
        rads,
        8,
        barkRootCol,
        barkUpperCol,
        2.0,
        0.48,
        0.0,
        swayTop,
        def.seed + seedOff,
        0.13
      );
      return pts;
    };

    if (archetype === 'windswept_lone_cypress') {
      const trunkPts = buildSplineTrunk(origin, 6.9 * sc, baseRad, 0.11 * sc, 0.48 + rng() * 0.22, 0.45, 11);
      const boughCount = 6;
      for (let b = 0; b < boughCount; b++) {
        const frac = lerp(0.48, 0.96, b / (boughCount - 1));
        const idx = Math.min(trunkPts.length - 1, Math.round(frac * (trunkPts.length - 1)));
        // Bias branches leeward so tree reads unmistakably wind-carved off the Pacific!
        const baseYaw = windAngle + (b / boughCount - 0.5) * Math.PI * 1.45 + (rng() - 0.5) * 0.4;
        const dir = new THREE.Vector3(
          Math.sin(baseYaw) + windDx * 0.55,
          0.16 + rng() * 0.28,
          -Math.cos(baseYaw) + windDz * 0.55
        );
        growLimbWithSubBranches(
          trunkPts[idx],
          dir,
          (3.2 + rng() * 2.2) * sc,
          baseRad * (0.48 - frac * 0.16),
          true,
          frac
        );
      }
      // Crown apex flat windswept cap
      stampFoliageCluster(
        trunkPts[trunkPts.length - 1],
        4,
        1.12 * sc,
        0.72 * sc,
        1.75 * sc,
        true,
        1.0,
        0.85
      );
    } else if (archetype === 'split_twin_cypress') {
      // Knotted low bole splitting into 2 diverging curved trunks
      const bolePts = buildSplineTrunk(origin, 2.3 * sc, baseRad * 1.12, baseRad * 0.78, 0.18, 0.08, 21);
      const forkBase = bolePts[bolePts.length - 1];
      const splitAngle = rng() * Math.PI * 2;
      for (let stem = 0; stem < 2; stem++) {
        const dirSign = stem === 0 ? 1 : -1;
        const hScale = stem === 0 ? 5.2 * sc : 4.4 * sc;
        const pushMag = (1.65 + stem * 0.35) * sc * dirSign;
        const spreadVec = new THREE.Vector3(Math.cos(splitAngle) * pushMag, 0, Math.sin(splitAngle) * pushMag);
        const sPts = buildSplineTrunk(
          forkBase,
          hScale,
          baseRad * (stem === 0 ? 0.56 : 0.46),
          0.09 * sc,
          0.26,
          0.46,
          37 + stem * 19,
          spreadVec
        );
        const limbs = stem === 0 ? 4 : 3;
        for (let b = 0; b < limbs; b++) {
          const frac = lerp(0.45, 0.95, b / Math.max(1, limbs - 1));
          const idx = Math.min(sPts.length - 1, Math.round(frac * (sPts.length - 1)));
          const yaw = splitAngle + (stem === 0 ? 0 : Math.PI) + (b - 1) * 1.05 + (rng() - 0.5) * 0.4;
          const dir = new THREE.Vector3(Math.cos(yaw), 0.22 + rng() * 0.25, Math.sin(yaw));
          growLimbWithSubBranches(sPts[idx], dir, (2.6 + rng() * 1.7) * sc, baseRad * 0.32, true, frac);
        }
        stampFoliageCluster(sPts[sPts.length - 1], 3, 1.02 * sc, 0.70 * sc, 1.45 * sc, true, 0.95, 0.82);
      }
    } else if (archetype === 'broad_coastal_cypress') {
      const trunkPts = buildSplineTrunk(origin, 6.4 * sc, baseRad * 1.08, 0.14 * sc, 0.22, 0.38, 43);
      const boughCount = 7;
      for (let b = 0; b < boughCount; b++) {
        const frac = lerp(0.38, 0.95, b / (boughCount - 1));
        const idx = Math.min(trunkPts.length - 1, Math.round(frac * (trunkPts.length - 1)));
        const yaw = (b / boughCount) * Math.PI * 2 + (rng() - 0.5) * 0.45;
        const dir = new THREE.Vector3(Math.cos(yaw), 0.18 + rng() * 0.30, Math.sin(yaw));
        growLimbWithSubBranches(
          trunkPts[idx],
          dir,
          (3.4 + rng() * 1.9) * sc,
          baseRad * (0.46 - frac * 0.14),
          true,
          frac
        );
      }
      stampFoliageCluster(trunkPts[trunkPts.length - 1], 4, 1.15 * sc, 0.78 * sc, 1.65 * sc, true, 1.0, 0.78);
    } else if (archetype === 'tall_monterey_pine') {
      // Tall sinuous coastal pine with 3–4 separated horizontal branch whorls (distinct air gaps!)
      const trunkPts = buildSplineTrunk(origin, 10.6 * sc, baseRad, 0.08 * sc, 0.16, 0.52, 61);
      const whorls = [0.46, 0.65, 0.82, 0.94];
      for (let w = 0; w < whorls.length; w++) {
        const frac = whorls[w];
        const idx = Math.min(trunkPts.length - 1, Math.round(frac * (trunkPts.length - 1)));
        const limbsInWhorl = w < 2 ? 3 : 3;
        const whorlSpin = rng() * Math.PI * 2;
        for (let b = 0; b < limbsInWhorl; b++) {
          const yaw = whorlSpin + (b / limbsInWhorl) * Math.PI * 2 + (rng() - 0.5) * 0.45;
          const dir = new THREE.Vector3(Math.cos(yaw), 0.14 + w * 0.09 + rng() * 0.14, Math.sin(yaw));
          const bLen = (3.3 - w * 0.52 + rng() * 1.1) * sc;
          growLimbWithSubBranches(trunkPts[idx], dir, bLen, baseRad * (0.40 - w * 0.06), false, frac);
        }
      }
      stampFoliageCluster(trunkPts[trunkPts.length - 1], 3, 0.95 * sc, 1.02 * sc, 1.15 * sc, false, 1.0, 0.90);
    } else {
      // umbrella_sea_pine: clean tall sweeping trunk flaring into a high parasol pine crown
      const trunkPts = buildSplineTrunk(origin, 9.8 * sc, baseRad, 0.11 * sc, 0.24, 0.54, 79);
      const boughCount = 6;
      for (let b = 0; b < boughCount; b++) {
        const frac = lerp(0.68, 0.97, b / (boughCount - 1));
        const idx = Math.min(trunkPts.length - 1, Math.round(frac * (trunkPts.length - 1)));
        const yaw = (b / boughCount) * Math.PI * 2 + (rng() - 0.5) * 0.42;
        const dir = new THREE.Vector3(Math.cos(yaw), 0.34 + rng() * 0.22, Math.sin(yaw));
        growLimbWithSubBranches(
          trunkPts[idx],
          dir,
          (2.9 + rng() * 1.6) * sc,
          baseRad * 0.36,
          false,
          frac
        );
      }
      stampFoliageCluster(trunkPts[trunkPts.length - 1], 4, 1.02 * sc, 0.92 * sc, 1.40 * sc, false, 1.0, 0.92);
    }
  }

  private buildCoastalSeaRocks(sampler: HoleTerrainSampler): void {
    const rocks = sampler.hole.seaRocks;
    if (!rocks.length) return;

    const group = new THREE.Group();
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x575249,
      normalMap: this.textures.rockNormal,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.72,
      metalness: 0.04,
    });

    for (const r of rocks) {
      const rng = makeSeededRandom(r.seed);
      const geo = new THREE.IcosahedronGeometry(r.radius, 2);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i);
        const vy = pos.getY(i);
        const vz = pos.getZ(i);
        const wobble =
          0.74 +
          0.32 * Math.sin(vx * 1.3 + r.seed) * Math.cos(vz * 1.1 - r.seed) +
          (rng() - 0.5) * 0.14;
        pos.setXYZ(i, vx * wobble, vy * (r.height / r.radius) * (0.85 + 0.15 * wobble), vz * wobble);
      }
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, rockMat);
      const groundY = sampler.getHeight(r.x, r.z);
      mesh.position.set(r.x, Math.max(-0.8, groundY) + r.height * 0.15, r.z);
      mesh.rotation.y = rng() * Math.PI * 2;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    this.rockGroup = group;
    this.scene.add(group);
  }

  public update(
    timeS: number,
    windSpeedMps: number,
    windDirRad: number,
    sunDir?: THREE.Vector3,
    cloudOffset?: THREE.Vector2,
    cloudCoverage?: number,
    mistColor?: THREE.Color,
    mistDensity?: number,
    ballPos?: { x: number; y: number; z: number }
  ): void {
    if (this.grassUniforms) {
      this.grassUniforms.uTime.value = timeS;
      this.grassUniforms.uWindSpeed.value = windSpeedMps;
      this.grassUniforms.uWindDir.value.set(Math.sin(windDirRad), -Math.cos(windDirRad));
      if (sunDir) this.grassUniforms.uSunDir.value.copy(sunDir).normalize();
      if (cloudOffset) this.grassUniforms.uCloudOffset.value.copy(cloudOffset);
      if (cloudCoverage !== undefined) this.grassUniforms.uCloudCoverage.value = cloudCoverage;
      if (mistColor) this.grassUniforms.uMistColor.value.copy(mistColor);
      if (mistDensity !== undefined) this.grassUniforms.uMistDensity.value = mistDensity;
      if (ballPos) this.grassUniforms.uBallPos.value.set(ballPos.x, ballPos.y, ballPos.z);
    }
    if (this.treeSwayUniforms) {
      this.treeSwayUniforms.uTime.value = timeS;
      this.treeSwayUniforms.uWindSpeed.value = windSpeedMps;
      this.treeSwayUniforms.uWindDir.value.set(Math.sin(windDirRad), -Math.cos(windDirRad));
      if (sunDir) this.treeSwayUniforms.uSunDir.value.copy(sunDir).normalize();
      if (cloudOffset) this.treeSwayUniforms.uCloudOffset.value.copy(cloudOffset);
      if (cloudCoverage !== undefined) this.treeSwayUniforms.uCloudCoverage.value = cloudCoverage;
      if (mistColor) this.treeSwayUniforms.uMistColor.value.copy(mistColor);
      if (mistDensity !== undefined) this.treeSwayUniforms.uMistDensity.value = mistDensity;
    }
  }

  public clearCurrent(): void {
    if (this.grassMesh) {
      this.scene.remove(this.grassMesh);
      this.grassMesh.geometry.dispose();
      (this.grassMesh.material as THREE.Material).dispose();
      this.grassMesh = null;
    }
    if (this.heroGrassMesh) {
      this.scene.remove(this.heroGrassMesh);
      this.heroGrassMesh.geometry.dispose();
      (this.heroGrassMesh.material as THREE.Material).dispose();
      this.heroGrassMesh = null;
    }
    if (this.fescuePlumeMesh) {
      this.scene.remove(this.fescuePlumeMesh);
      this.fescuePlumeMesh.geometry.dispose();
      (this.fescuePlumeMesh.material as THREE.Material).dispose();
      this.fescuePlumeMesh = null;
    }
    if (this.iceplantMesh) {
      this.scene.remove(this.iceplantMesh);
      this.iceplantMesh.geometry.dispose();
      (this.iceplantMesh.material as THREE.Material).dispose();
      this.iceplantMesh = null;
    }
    if (this.treeGroup) {
      this.scene.remove(this.treeGroup);
      this.treeGroup.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) (mesh.material as THREE.Material).dispose();
        if (mesh.customDepthMaterial) (mesh.customDepthMaterial as THREE.Material).dispose();
      });
      this.treeGroup = null;
    }
    if (this.rockGroup) {
      this.scene.remove(this.rockGroup);
      this.rockGroup.traverse((o) => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
        if ((o as THREE.Mesh).material) ((o as THREE.Mesh).material as THREE.Material).dispose();
      });
      this.rockGroup = null;
    }
    this.grassUniforms = null;
    this.treeSwayUniforms = null;
    this.currentSampler = null;
  }

  public dispose(): void {
    this.clearCurrent();
  }
}
