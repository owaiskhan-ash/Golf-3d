import * as THREE from 'three';
import { clamp } from '../course/noise';
import type { HoleTerrainSampler } from '../course/terrainSampler';
import type { CourseTextureSet, PhotoTextureSet } from './ProceduralTextures';

/**
 * Generates an adaptive, single-watertight terrain mesh where vertex density concentrates smoothly
 * around the putting green & greenside bunkers (~0.45m spacing) and fairway spine (~1.2m spacing)
 * while stretching smoothly toward the distant coastline cliffs (~3.5m spacing).
 */
export class TerrainMeshSystem {
  public mesh: THREE.Mesh | null = null;
  public cupGroup: THREE.Group | null = null;
  public seawallGroup: THREE.Group | null = null;
  private splatTexture: THREE.DataTexture | null = null;
  private greenSlopeTexture: THREE.DataTexture | null = null;
  private shaderUniforms: Record<string, THREE.IUniform> | null = null;
  private showGreenGrid = false;
  private gridXCoords: Float32Array | null = null;
  private gridZCoords: Float32Array | null = null;
  private gridPositions: Float32Array | null = null;
  private gridSegX = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly textures: CourseTextureSet,
    private photo?: PhotoTextureSet
  ) {}

  /** Wires the photographic CC0 PBR texture set once streamed in; fades the layer on. */
  public setPhotoTextures(set: PhotoTextureSet): void {
    // Guard the failure path: when KTX2/Basis is unsupported the set carries no textures and
    // the photographic layer must stay off (uPhotoStrength 0) rather than sampling nothing.
    if (!set.colorAtlas || !set.normalAtlas) return;
    this.photo = set;
    if (this.shaderUniforms) {
      this.shaderUniforms.uPhotoColorAtlas.value = set.colorAtlas;
      this.shaderUniforms.uPhotoNormalAtlas.value = set.normalAtlas;
      this.shaderUniforms.uPhotoStrength.value = 1.0;
    }
  }

  public buildForHole(sampler: HoleTerrainSampler): void {
    this.clearCurrent();

    const hole = sampler.hole;
    const { minX, maxX, minZ, maxZ } = hole.bounds;
    const greenX = hole.green.cx;
    const greenZ = hole.green.cz;

    // 1. Bake high-resolution 768 x 1024 RGBA Surface Splatmap (fast hole switching; razor edges driven by 1024px blade-fraying shader)
    // R = Fairway + Tee, G = Green + Fringe, B = Bunker, A = Rough/Cliff/Path encoded
    const sw = 768;
    const sh = 1024;
    const splatData = new Uint8Array(sw * sh * 4);
    for (let iy = 0; iy < sh; iy++) {
      const v = (iy + 0.5) / sh;
      const z = minZ + v * (maxZ - minZ);
      for (let ix = 0; ix < sw; ix++) {
        const u = (ix + 0.5) / sw;
        const x = minX + u * (maxX - minX);
        const s = sampler.getSurfaceSample(x, z);
        const idx = (iy * sw + ix) * 4;
        splatData[idx] = Math.round(clamp(Math.max(s.fairwayBlend, s.teeBlend), 0, 1) * 255);
        splatData[idx + 1] = Math.round(
          clamp(s.greenBlend + s.fringeBlend * 0.45, 0, 1) * 255
        );
        splatData[idx + 2] = Math.round(clamp(s.bunkerBlend, 0, 1) * 255);
        // Pack fringe (0.35), path (0.65), cliff (1.0) cleanly into A
        const aVal =
          s.cliffBlend > 0.1
            ? 0.55 + 0.45 * s.cliffBlend
            : s.pathBlend > 0.2
              ? 0.28 + 0.22 * s.pathBlend
              : s.fringeBlend * 0.24;
        splatData[idx + 3] = Math.round(clamp(aVal, 0, 1) * 255);
      }
    }
    this.splatTexture = new THREE.DataTexture(splatData, sw, sh, THREE.RGBAFormat);
    this.splatTexture.minFilter = THREE.LinearFilter;
    this.splatTexture.magFilter = THREE.LinearFilter;
    this.splatTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.splatTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.splatTexture.needsUpdate = true;

    // 2. Bake 128x128 Green Break Slope Vector Field around Putting Green
    const gRad = Math.max(hole.green.rx, hole.green.rz) + 5;
    const gw = 128;
    const gSlopeData = new Uint8Array(gw * gw * 4);
    for (let iy = 0; iy < gw; iy++) {
      const v = (iy + 0.5) / gw;
      const z = greenZ + (v * 2 - 1) * gRad;
      for (let ix = 0; ix < gw; ix++) {
        const u = (ix + 0.5) / gw;
        const x = greenX + (u * 2 - 1) * gRad;
        const n = sampler.getNormal(x, z);
        // Downhill slope direction: (-nx, -nz) normalized by max ~8% slope
        const sx = clamp(-n.x / 0.08 * 0.5 + 0.5, 0, 1);
        const sz = clamp(-n.z / 0.08 * 0.5 + 0.5, 0, 1);
        const mag = clamp(Math.hypot(n.x, n.z) / 0.06, 0, 1);
        const idx = (iy * gw + ix) * 4;
        gSlopeData[idx] = Math.round(sx * 255);
        gSlopeData[idx + 1] = Math.round(sz * 255);
        gSlopeData[idx + 2] = Math.round(mag * 255);
        gSlopeData[idx + 3] = 255;
      }
    }
    this.greenSlopeTexture = new THREE.DataTexture(gSlopeData, gw, gw, THREE.RGBAFormat);
    this.greenSlopeTexture.minFilter = THREE.LinearFilter;
    this.greenSlopeTexture.magFilter = THREE.LinearFilter;
    this.greenSlopeTexture.needsUpdate = true;

    // 3. Build Monotonic Warped Watertight Grid (concentrates density around Green & Fairway!)
    const segX = 180;
    const segZ = 240;
    const xCoords = this.buildWarpedAxis(minX, maxX, greenX, 26, segX);
    const zCoords = this.buildWarpedAxis(minZ, maxZ, greenZ, 30, segZ);

    const vertCount = (segX + 1) * (segZ + 1);
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    const aoAttr = new Float32Array(vertCount);

    const cupX = sampler.cupPosition.x;
    const cupZ = sampler.cupPosition.z;

    let ptr = 0;
    let uvPtr = 0;
    let aoPtr = 0;
    for (let iz = 0; iz <= segZ; iz++) {
      const z = zCoords[iz];
      const v = (z - minZ) / (maxZ - minZ);
      for (let ix = 0; ix <= segX; ix++) {
        const x = xCoords[ix];
        const u = (x - minX) / (maxX - minX);
        let y = sampler.getHeight(x, z);
        const n = sampler.getNormal(x, z);

        // Gently depress immediate vertex inside 6cm cup radius if vertex falls right inside cup
        const distCup = Math.hypot(x - cupX, z - cupZ);
        if (distCup < 0.09) {
          y -= 0.04 * (1 - distCup / 0.09);
        }

        // Bake multi-scale terrain concavity, broad swale AO & tree-canopy ground shade pools
        const hL = sampler.getHeight(x - 1.6, z);
        const hR = sampler.getHeight(x + 1.6, z);
        const hD = sampler.getHeight(x, z - 1.6);
        const hU = sampler.getHeight(x, z + 1.6);
        const hWL = sampler.getHeight(x - 5.0, z);
        const hWR = sampler.getHeight(x + 5.0, z);
        const hWD = sampler.getHeight(x, z - 5.0);
        const hWU = sampler.getHeight(x, z + 5.0);
        const fineConc = Math.max(0, (hL + hR + hD + hU - 4 * y) * 1.15);
        const broadConc = Math.max(0, (hWL + hWR + hWD + hWU - 4 * y) * 0.36);
        const slopeAO = 0.80 + 0.20 * n.y;
        // Convexity (crests, bunker lips, green mound shoulders) also needs its own term:
        // purely concave-only AO left every ridge perfectly clean, which flattens the
        // micro-relief the normal maps are trying to sell. Positive curvature brightens.
        const ridgeConv = Math.max(0, (4 * y - (hL + hR + hD + hU)) * 0.55);
        const crestGain = Math.min(0.10, ridgeConv);
        let treeGroundAO = 1.0;
        for (const tr of hole.trees) {
          const td = Math.hypot(x - tr.x, z - tr.z);
          const trRad = 4.6 * tr.scale;
          if (td < trRad) {
            const k = 1.0 - td / trRad;
            treeGroundAO = Math.min(treeGroundAO, 1.0 - 0.30 * k * k);
          }
        }
        aoAttr[aoPtr++] = clamp(
          (1.0 - Math.min(0.45, fineConc + broadConc)) * slopeAO * treeGroundAO + crestGain,
          0.48,
          1.0
        );

        positions[ptr] = x;
        positions[ptr + 1] = y;
        positions[ptr + 2] = z;

        normals[ptr] = n.x;
        normals[ptr + 1] = n.y;
        normals[ptr + 2] = n.z;

        uvs[uvPtr] = u;
        uvs[uvPtr + 1] = v;

        ptr += 3;
        uvPtr += 2;
      }
    }

    const indices: number[] = [];
    for (let iz = 0; iz < segZ; iz++) {
      for (let ix = 0; ix < segX; ix++) {
        const a = iz * (segX + 1) + ix;
        const b = a + 1;
        const c = a + (segX + 1);
        const d = c + 1;
        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('aTerrainAO', new THREE.BufferAttribute(aoAttr, 1));
    geo.setIndex(indices);

    this.gridXCoords = xCoords;
    this.gridZCoords = zCoords;
    this.gridPositions = positions;
    this.gridSegX = segX;

    // 4. Custom PBR Material with Multi-Layer Turf Stripes, Bunker Sand, Triplanar Cliff Rock & Green Grid
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0.0,
    });

    const uniforms: Record<string, THREE.IUniform> = {
      uSplatMap: { value: this.splatTexture },
      uGreenSlopeMap: { value: this.greenSlopeTexture },
      uGrassDetail: { value: this.textures.grassDetailMap },
      uGrassNorm: { value: this.textures.grassNormal },
      uSandNorm: { value: this.textures.sandNormal },
      uRockNorm: { value: this.textures.rockNormal },
      uBounds: { value: new THREE.Vector4(minX, maxX, minZ, maxZ) },
      uGreenRegion: { value: new THREE.Vector4(greenX, greenZ, gRad, 0) },
      uCupPos: { value: new THREE.Vector3(cupX, sampler.cupPosition.y, cupZ) },
      uHoleYaw: { value: hole.tee.yawRad },
      uTime: { value: 0 },
      uShowGreenGrid: { value: this.showGreenGrid ? 1.0 : 0.0 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.5, -0.5).normalize() },
      uCloudOffset: { value: new THREE.Vector2() },
      uCloudCoverage: { value: 0.49 },
      uMistColor: { value: new THREE.Color(0xc0d9eb) },
      uMistDensity: { value: 0.0045 },
      // Photographic CC0 PBR layer (KTX2 quad atlases) — strength fades in once transcoded
      uPhotoStrength: { value: this.photo?.loaded && this.photo.colorAtlas ? 1.0 : 0.0 },
      uPhotoColorAtlas: { value: this.photo?.colorAtlas ?? null },
      uPhotoNormalAtlas: { value: this.photo?.normalAtlas ?? null },
    };
    this.shaderUniforms = uniforms;

    // Keep three from inserting its own normal-map sampler for the photo layer: we sample
    // uPhotoNormalAtlas manually. Bump the cache key whenever the injected GLSL changes.
    mat.customProgramCacheKey = () => 'terrain-cinema-pbr-v6-ktx2-packed';
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          attribute float aTerrainAO;
          varying vec3 vTerrainWorldPos;
          varying vec3 vTerrainWorldNormal;
          varying float vTerrainAO;
        `
        )
        .replace(
          '#include <worldpos_vertex>',
          /* glsl */ `
          #include <worldpos_vertex>
          vTerrainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vTerrainWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
          vTerrainAO = aTerrainAO;
        `
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          uniform sampler2D uSplatMap;
          uniform sampler2D uGreenSlopeMap;
          uniform sampler2D uGrassDetail;
          uniform sampler2D uGrassNorm;
          uniform sampler2D uSandNorm;
          uniform sampler2D uRockNorm;
          uniform vec4 uBounds;
          uniform vec4 uGreenRegion;
          uniform vec3 uCupPos;
          uniform float uHoleYaw;
          uniform float uTime;
          uniform float uShowGreenGrid;
          uniform vec3 uSunDir;
          uniform vec2 uCloudOffset;
          uniform float uCloudCoverage;
          uniform vec3 uMistColor;
          uniform float uMistDensity;
          uniform float uPhotoStrength;
          uniform sampler2D uPhotoColorAtlas;
          uniform sampler2D uPhotoNormalAtlas;

          varying vec3 vTerrainWorldPos;
          varying vec3 vTerrainWorldNormal;
          varying float vTerrainAO;

          // Hue/chroma of a photographic sample, luminance-normalized so the procedural
          // palette keeps control of brightness while the photo drives realistic hue
          vec3 tPhotoHue(vec3 c) {
            float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
            return c / max(l, 0.045);
          }

          float tHash(vec2 p) {
            p = fract(p * vec2(234.34, 435.345));
            p += dot(p, p + 34.23);
            return fract(p.x * p.y);
          }

          float tNoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(tHash(i), tHash(i + vec2(1.0, 0.0)), f.x),
              mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), f.x),
              f.y
            );
          }

          float tFbm(vec2 p) {
            float v = 0.0;
            float a = 0.5;
            for (int i = 0; i < 3; i++) {
              v += a * tNoise(p);
              p = p * 2.04 + vec2(13.7, 29.3);
              a *= 0.5;
            }
            return v;
          }

          // 2x2 atlas quadrant remap: 0 lawn, 1 rough, 2 sand, 3 rock.
          // The atlas is Basis-compressed with pregenerated mips, so plain bilinear
          // filtering is safe. The mip level is clamped to 4.0 below: past that a single
          // texel spans the entire quadrant inset and all four materials average together,
          // which is what made distant grass ghost into the sand terms.
          vec2 tPhotoQuadUv(vec2 uv, float quad) {
            vec2 cell = fract(uv) * 0.484 + 0.008;
            return cell + vec2(quad == 1.0 || quad == 3.0 ? 0.5 : 0.0, quad >= 2.0 ? 0.5 : 0.0);
          }

          // Explicit-LOD atlas sample (WebGL2 textureLod), mip-capped so quadrants never
          // cross-pollinate. Falls back to implicit LOD on GLES2-class hardware.
          vec4 tPhotoSample(sampler2D atlas, vec2 uv, float quad, float lod) {
            vec2 auv = tPhotoQuadUv(uv, quad);
          #ifdef TERRAIN_NO_EXPLICIT_LOD
            return texture2D(atlas, auv);
          #else
            return textureLod(atlas, auv, min(lod, 4.0));
          #endif
          }

          // Seamless anti-tiling for albedo: a second sample of the same tile taken at a
          // different scale AND rotation, crossfaded by low-frequency noise. Both layers are
          // continuous functions of world position, so unlike per-cell "stochastic tiling"
          // there is no cell grid to seam — it simply destroys the regular repeat that a
          // single fixed-scale sample produced from the drone camera.
          // (Normal maps deliberately do NOT use this: rotating a stored vector field would
          // rotate the lighting response rather than the detail.)
          vec4 tPhotoAlbedoOctave(sampler2D atlas, vec2 uv, float quad, float seed, float lod) {
            vec4 a = tPhotoSample(atlas, uv, quad, lod);
            float ang = 0.63 + seed * 0.021;
            float ca = cos(ang);
            float sa = sin(ang);
            vec2 uv2 = mat2(ca, -sa, sa, ca) * uv * 0.43 + vec2(0.37, 0.61);
            vec4 b = tPhotoSample(atlas, uv2, quad, lod);
            float m = smoothstep(0.28, 0.72, tNoise(uv * 0.23 + seed)) * 0.55;
            return mix(a, b, m);
          }

        `
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
          #include <map_fragment>
          vec2 splatUv = vec2(
            (vTerrainWorldPos.x - uBounds.x) / (uBounds.y - uBounds.x),
            (vTerrainWorldPos.z - uBounds.z) / (uBounds.w - uBounds.z)
          );
          vec4 sp = texture2D(uSplatMap, clamp(splatUv, 0.0, 1.0));

          float cH = cos(uHoleYaw);
          float sH = sin(uHoleYaw);
          float rotX = vTerrainWorldPos.x * cH + vTerrainWorldPos.z * sH;
          float rotZ = -vTerrainWorldPos.x * sH + vTerrainWorldPos.z * cH;
          vec2 rotXZ = vec2(rotX, rotZ);

          // Multi-scale 1024px 24,000-blade turf detail (macro patch + 4.5mm fairway blades + 1.5mm putting green Poa fiber)
          float camDist = length(cameraPosition - vTerrainWorldPos);
          float nearMicro = 1.0 - smoothstep(10.0, 44.0, camDist);
          vec3 gMacro = texture2D(uGrassDetail, vTerrainWorldPos.xz * 0.36).rgb;
          vec3 gBlade = texture2D(uGrassDetail, rotXZ * 1.45 + vec2(0.19, 0.41)).rgb;
          vec3 gMicro = texture2D(uGrassDetail, rotXZ * 3.65 + vec2(0.53, 0.27)).rgb;

          float bladeHeight = mix(gMacro.r * 0.55 + gBlade.r * 0.45, gMacro.r * 0.24 + gBlade.r * 0.48 + gMicro.r * 0.28, nearMicro);
          float bladePigment = mix(gMacro.g * 0.5 + gBlade.g * 0.5, gBlade.g * 0.62 + gMicro.g * 0.38, nearMicro);
          float bladeThatch = mix(gMacro.b, gBlade.b * 0.72 + gMicro.b * 0.28, nearMicro);

          // Photographic PBR samples (CC0 ambientCG): real lawn/meadow/sandstone albedo.
          // bladeHeight/pigment/thatch blend toward photo-derived values so every downstream
          // turf recipe (rough, first cut, fairway, green) inherits photographic structure.
          // Albedo uses the rotated stochastic tile; the alpha channel carries the packed
          // dampness/gloss term used later by the roughness pass.
          vec2 pRockPlanarUv = (vTerrainWorldNormal.y < 0.7
            ? vec2(vTerrainWorldPos.x + vTerrainWorldPos.z, vTerrainWorldPos.y)
            : vTerrainWorldPos.xz) * 0.22;
          vec4 pLawnBladeS = tPhotoAlbedoOctave(uPhotoColorAtlas, rotXZ * 0.55 + vec2(0.19, 0.41), 0.0, 1.7, 0.0);
          vec4 pLawnMacroS = tPhotoAlbedoOctave(uPhotoColorAtlas, vTerrainWorldPos.xz * 0.052 + vec2(0.61, 0.23), 0.0, 7.9, 0.0);
          vec4 pRoughS = tPhotoAlbedoOctave(uPhotoColorAtlas, vTerrainWorldPos.xz * 0.075 + vec2(0.37, 0.11), 1.0, 3.1, 0.0);
          vec4 pSandS = tPhotoAlbedoOctave(uPhotoColorAtlas, vTerrainWorldPos.xz * 0.5, 2.0, 5.4, 0.0);
          vec4 pRockS = tPhotoAlbedoOctave(uPhotoColorAtlas, pRockPlanarUv, 3.0, 9.2, 0.0);
          vec3 pLawnBlade = pLawnBladeS.rgb;
          vec3 pLawnMacro = pLawnMacroS.rgb;
          vec3 pRough = pRoughS.rgb;
          vec3 pSand = pSandS.rgb;
          vec3 pRock = pRockS.rgb;
          // Packed dampness/gloss (0 = dry & matte, 1 = damp & slightly glossy)
          float pGlossTurf = pLawnBladeS.a;
          float pGlossSand = pSandS.a;
          float pGlossRock = pRockS.a;
          float pLawnH = dot(pLawnBlade, vec3(0.2126, 0.7152, 0.0722));
          float pLawnMacroLum = dot(pLawnMacro, vec3(0.2126, 0.7152, 0.0722));
          float pRoughLum = dot(pRough, vec3(0.2126, 0.7152, 0.0722));
          bladeHeight = mix(bladeHeight, mix(bladeHeight, pLawnH * 1.15, 0.65), uPhotoStrength);
          bladeThatch = mix(bladeThatch, mix(bladeThatch, 1.0 - pLawnH, 0.4), uPhotoStrength);

          // Organic blade-frayed turf encroachment along bunker lips, collars & paths
          float edgeNoise = (tFbm(vTerrainWorldPos.xz * 0.48) - 0.5) * 0.14 + (gBlade.r - 0.5) * 0.08 * nearMicro;

          float wFairway = smoothstep(0.32, 0.72, sp.r + edgeNoise * 0.55);
          float wFirstCut = smoothstep(0.10, 0.34, sp.r + edgeNoise * 0.40) * (1.0 - wFairway);
          float wGreenTotal = smoothstep(0.22, 0.85, sp.g + edgeNoise * 0.22);
          float wGreenCore = smoothstep(0.62, 0.92, sp.g);
          float wFringe = clamp(wGreenTotal - wGreenCore, 0.0, 1.0);
          float wBunker = smoothstep(0.34, 0.68, sp.b + edgeNoise * 0.72);
          float wBunkerEdge = smoothstep(0.24, 0.45, sp.b) * (1.0 - smoothstep(0.55, 0.85, sp.b));
          float wPath = smoothstep(0.26, 0.44, sp.a) * (1.0 - smoothstep(0.46, 0.58, sp.a));
          float wCliffSplat = smoothstep(0.55, 0.85, sp.a);
          float steepSlope = 1.0 - smoothstep(0.58, 0.82, vTerrainWorldNormal.y);
          float wCliff = clamp(max(wCliffSplat, steepSlope), 0.0, 1.0);

          float macroVar = tFbm(vTerrainWorldPos.xz * 0.048);
          float microVar = tFbm(vTerrainWorldPos.xz * 0.82);
          float fineBlade = tNoise(vTerrainWorldPos.xz * 8.5);
          float ultraBlade = tNoise(vTerrainWorldPos.xz * 26.0);

          // View-dependent directional mower-lay physics (grass leaning away shows sunlit glossy cuticle; toward shows deep shaded undersides)
          vec2 viewDirXZ = normalize(cameraPosition.xz - vTerrainWorldPos.xz + vec2(1e-5));
          vec2 mowPassAxis = vec2(cH, sH);
          float viewAlongMow = dot(viewDirXZ, mowPassAxis);

          // 1. Coastal Rough, Golden Fescue & First-Cut Semi-Rough Collar
          float roughCavity = smoothstep(0.08, 0.78, bladeHeight);
          vec3 roughBase = mix(vec3(0.068, 0.148, 0.042), vec3(0.145, 0.224, 0.075), macroVar);
          vec3 roughTips = mix(roughBase * 1.24, vec3(0.275, 0.258, 0.116), smoothstep(0.54, 0.88, microVar + bladeThatch * 0.26));
          vec3 roughSoil = vec3(0.048, 0.046, 0.028);
          vec3 roughCol = mix(roughSoil, mix(roughBase, roughTips, bladePigment), roughCavity);
          roughCol *= 0.88 + 0.20 * fineBlade;
          // Photographic meadow fescue: real photo hue + luminance structure, green-shifted to coastal rough
          vec3 roughPhotoCol = pRough * vec3(0.60, 0.72, 0.46) * (0.72 + 0.56 * macroVar);
          roughCol = mix(roughCol, roughPhotoCol, uPhotoStrength * 0.85);

          vec3 fcSoil = vec3(0.046, 0.072, 0.030);
          vec3 fcBlade = mix(vec3(0.078, 0.202, 0.056), vec3(0.128, 0.278, 0.084), bladePigment) * (0.90 + 0.14 * microVar);
          vec3 firstCutCol = mix(fcSoil, fcBlade, smoothstep(0.06, 0.65, bladeHeight));

          // 2. Fairway (8K directional coastal bentgrass + view-dependent anisotropic mowing stripes + root thatch depth)
          float mowWave = sin(rotX * 0.92);
          float mowStripe = smoothstep(-0.35, 0.35, mowWave);
          float crossStripe = smoothstep(-0.40, 0.40, sin(rotZ * 0.55));
          // Subtle real-world view shift so stripes feel physically directional as camera moves
          float stripeContrast = clamp(mowStripe * 0.78 + crossStripe * 0.22 + (mowWave * viewAlongMow) * 0.10, 0.0, 1.0);
          float bladeStreak = 0.94 + 0.10 * sin(rotZ * 28.0 + microVar * 4.5) * (0.4 + 0.6 * gBlade.r);

          vec3 fwThatch = vec3(0.048, 0.095, 0.034);
          vec3 fwDark = vec3(0.072, 0.228, 0.058) * (0.86 + 0.28 * bladePigment);
          vec3 fwLight = vec3(0.128, 0.326, 0.088) * (0.88 + 0.26 * bladePigment);
          vec3 fwBladeCol = mix(fwDark, fwLight, stripeContrast);
          fwBladeCol = mix(fwBladeCol, vec3(0.165, 0.335, 0.102), bladeThatch * 0.14);
          vec3 fwCol = mix(fwThatch, fwBladeCol, smoothstep(0.04, 0.56, mix(0.65, bladeHeight, 0.78 + 0.22 * nearMicro)));
          fwCol *= (0.92 + 0.14 * microVar) * bladeStreak;
          // Photographic lawn hue + real luminance patchiness; mowing stripes stay layered on top
          vec3 fwPhotoCol = fwCol * tPhotoHue(pLawnBlade) * (0.40 + pLawnH * 1.72) * (0.84 + pLawnMacroLum * 0.45);
          fwCol = mix(fwCol, fwPhotoCol, uPhotoStrength * 0.8);

          // 3. Putting Green (tightly rolled coastal Poa annua & creeping bentgrass micro-checkerboard) + Fringe
          float gCheckX = smoothstep(-0.25, 0.25, sin((rotX + rotZ * 0.35) * 2.1));
          float gCheckZ = smoothstep(-0.25, 0.25, sin((rotZ - rotX * 0.35) * 2.1));
          float gPattern = mix(gCheckX, 1.0 - gCheckX, gCheckZ * 0.45);
          float poaSpeck = smoothstep(0.74, 0.96, gMicro.g * 0.65 + microVar * 0.35) * 0.14;
          vec3 greenDark = vec3(0.098, 0.312, 0.078) * (0.91 + 0.18 * gMicro.g);
          vec3 greenLight = vec3(0.146, 0.398, 0.108) * (0.92 + 0.18 * gMicro.g);
          vec3 greenCol = mix(greenDark, greenLight, gPattern);
          greenCol = mix(greenCol, vec3(0.205, 0.415, 0.132), poaSpeck * nearMicro);
          greenCol = mix(greenCol * 0.72, greenCol, smoothstep(0.0, 0.36, mix(0.75, gMicro.r, nearMicro)));
          // Photographic bentgrass hue for the putting surface (subtle — checkerboard stays dominant)
          greenCol = mix(greenCol, greenCol * tPhotoHue(pLawnBlade) * (0.52 + pLawnH * 1.42), uPhotoStrength * 0.7);
          vec3 fringeCol = mix(vec3(0.080, 0.255, 0.066) * (0.90 + 0.20 * bladePigment), greenCol, 0.42);

          // 4. Coastal White-Gold Silica Bunker Sand + damp wall margin + micro quartz sparkle
          vec3 sandDry = vec3(0.79, 0.73, 0.58);
          vec3 sandDamp = vec3(0.56, 0.49, 0.36);
          float rakeGroove = 0.5 + 0.5 * sin((vTerrainWorldPos.x + vTerrainWorldPos.z) * 5.6 + microVar * 2.2);
          float silicaGlint = smoothstep(0.91, 0.99, ultraBlade) * 0.14;
          vec3 bunkerCol = mix(sandDamp, sandDry, 0.45 + 0.45 * microVar - wBunkerEdge * 0.38);
          bunkerCol = bunkerCol * (0.91 + 0.11 * rakeGroove) + vec3(silicaGlint);
          // Real coastal bunker sand albedo (lumpy unraked texture), rake grooves preserved
          vec3 sandPhotoCol = pSand * vec3(1.30, 1.20, 1.02) * (0.80 + 0.20 * rakeGroove);
          bunkerCol = mix(bunkerCol, sandPhotoCol, uPhotoStrength * 0.9);

          // 5. Gravel / Stone Maintenance Path
          vec3 pathCol = mix(vec3(0.35, 0.32, 0.27), vec3(0.47, 0.43, 0.37), fineBlade);

          // 6. Stratified Monterey Sandstone / Granite Cliffs + 4-Step Parallax Relief AO + Tidal Wet Zone
          vec2 pCliffUv = vTerrainWorldNormal.y < 0.7
            ? vec2(vTerrainWorldPos.x + vTerrainWorldPos.z, vTerrainWorldPos.y) * 0.16
            : vTerrainWorldPos.xz * 0.16;
          float rockRelief = 0.5;
          if (wCliff > 0.08) {
            // Step the parallax UV along the view ray, advancing only while the sampled
            // height is still below the layer we are testing. Each occlusion test now reads
            // the *real* photographic relief height from the KTX2 normal atlas' blue
            // channel instead of the procedural normal map's alpha, which was only a rough
            // baked height and drifted out of sync with the albedo.
            vec3 pView = normalize(cameraPosition - vTerrainWorldPos);
            vec2 pStep = (vTerrainWorldNormal.y < 0.7 ? vec2(pView.x + pView.z, pView.y) : pView.xz) * 0.016;
            float layerH = 1.0;
            vec2 curUv = pCliffUv;
            float hSample = texture2D(uRockNorm, curUv).a;
            if (uPhotoStrength > 0.001) {
              hSample = tPhotoSample(uPhotoNormalAtlas, curUv * 0.64, 3.0, 0.0).b;
            }
            for (int ps = 0; ps < 3; ps++) {
              if (hSample < layerH) {
                curUv -= pStep;
                layerH -= 0.25;
                hSample = uPhotoStrength > 0.001
                  ? tPhotoSample(uPhotoNormalAtlas, curUv * 0.64, 3.0, 0.0).b
                  : texture2D(uRockNorm, curUv).a;
              }
            }
            rockRelief = clamp(hSample, 0.0, 1.0);
          }
          float strata = tFbm(vec2(vTerrainWorldPos.x * 0.18 + vTerrainWorldPos.z * 0.18, vTerrainWorldPos.y * 0.95));
          float strataCracks = smoothstep(0.42, 0.54, abs(sin(vTerrainWorldPos.y * 2.4 + strata * 3.5)));
          vec3 rockBase = mix(vec3(0.20, 0.18, 0.15), vec3(0.49, 0.42, 0.35), strata * 0.65 + rockRelief * 0.35);
          rockBase *= (0.74 + 0.28 * strataCracks) * mix(0.68, 1.12, rockRelief);
          rockBase = mix(rockBase, vec3(0.18, 0.23, 0.13), smoothstep(0.68, 0.95, vTerrainWorldNormal.y) * 0.58);
          // Photographic warm Monterey sandstone albedo with real fissure structure
          vec3 rockPhotoCol = pRock * vec3(1.18, 1.04, 0.86) * (0.70 + 0.30 * strataCracks);
          rockBase = mix(rockBase, rockPhotoCol, uPhotoStrength * 0.85);
          float tidalWet = 1.0 - smoothstep(0.6, 3.6, vTerrainWorldPos.y + microVar * 0.8);
          float saltCrust = smoothstep(3.2, 4.4, vTerrainWorldPos.y) * (1.0 - smoothstep(4.4, 6.2, vTerrainWorldPos.y)) * smoothstep(0.55, 0.85, microVar);
          rockBase = mix(rockBase, rockBase * 1.18 + vec3(0.05), saltCrust * 0.45);
          rockBase *= mix(1.0, 0.36, tidalWet);

          // Composite layers cleanly + apply baked terrain concavity/slope micro-AO
          vec3 col = roughCol;
          col = mix(col, firstCutCol, wFirstCut);
          col = mix(col, fwCol, wFairway);
          col = mix(col, pathCol, wPath * (1.0 - wFairway));
          col = mix(col, fringeCol, wFringe);
          col = mix(col, greenCol, wGreenCore);
          col = mix(col, bunkerCol, wBunker);
          col = mix(col, rockBase, wCliff);
          // Note: vTerrainAO is baked from fine/broad concavity, ridge convexity, slope and
          // tree-canopy ground shade, so binding it to diffuse alone left specular highlights
          // floating over what should be dark, occluded crevices.
          col *= mix(0.62, 1.03, vTerrainAO);

          // Optional Green Break Slope Grid & Animated Flow Chevrons (Crisp thin broadcast hairlines)
          if (uShowGreenGrid > 0.5 && wGreenCore > 0.25) {
            vec2 gUv = vec2(
              (vTerrainWorldPos.x - uGreenRegion.x) / (uGreenRegion.z * 2.0) + 0.5,
              (vTerrainWorldPos.z - uGreenRegion.y) / (uGreenRegion.z * 2.0) + 0.5
            );
            vec4 slopeSample = texture2D(uGreenSlopeMap, clamp(gUv, 0.0, 1.0));
            vec2 downDir = (slopeSample.rg - 0.5) * 2.0;
            float slopeMag = slopeSample.b;

            float gridSpacing = 1.25;
            vec2 gCoord = vTerrainWorldPos.xz / gridSpacing;
            vec2 cellUv = fract(gCoord) - 0.5;
            float lineX = 1.0 - smoothstep(0.005, 0.015, abs(cellUv.x));
            float lineZ = 1.0 - smoothstep(0.005, 0.015, abs(cellUv.y));
            float gridMask = max(lineX, lineZ);

            vec2 sDir = length(downDir) > 0.04 ? normalize(downDir) : vec2(0.0, 0.0);
            float flowPhase = fract(dot(cellUv, sDir) - uTime * (0.40 + slopeMag * 1.35));
            float along = dot(cellUv, sDir);
            float across = abs(dot(cellUv, vec2(-sDir.y, sDir.x)));
            float chevron = smoothstep(0.14, 0.02, abs(flowPhase - 0.5 - across * 1.45)) * smoothstep(0.24, 0.06, across);
            float centerDot = smoothstep(0.075, 0.015, across) * smoothstep(0.28, 0.03, abs(flowPhase - 0.5));
            float arrowBead = max(chevron * 0.85, centerDot) * smoothstep(0.05, 0.35, slopeMag);
            float edgeFade = 1.0 - smoothstep(0.32, 0.48, max(abs(cellUv.x), abs(cellUv.y)));
            arrowBead *= edgeFade;

            vec3 flatTint = vec3(0.24, 0.90, 0.74);
            vec3 medTint = vec3(0.95, 0.78, 0.24);
            vec3 steepTint = vec3(0.96, 0.36, 0.26);
            vec3 heatCol = slopeMag < 0.45
              ? mix(flatTint, medTint, slopeMag / 0.45)
              : mix(medTint, steepTint, (slopeMag - 0.45) / 0.55);

            float overlayAlpha = clamp(gridMask * 0.20 + arrowBead * 0.62, 0.0, 0.58) * wGreenCore;
            col = mix(col, heatCol, overlayAlpha);
          }

          // Darken exact cup interior circle (5.4 cm radius) so cup silhouette pops even from afar
          float dCup = length(vTerrainWorldPos.xz - uCupPos.xz);
          col = mix(col, vec3(0.02, 0.02, 0.02), 1.0 - smoothstep(0.045, 0.058, dCup));

          diffuseColor.rgb = col;
        `
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `
          #include <roughnessmap_fragment>
          vec2 rSplatUv = vec2(
            (vTerrainWorldPos.x - uBounds.x) / (uBounds.y - uBounds.x),
            (vTerrainWorldPos.z - uBounds.z) / (uBounds.w - uBounds.z)
          );
          vec4 rsp = texture2D(uSplatMap, clamp(rSplatUv, 0.0, 1.0));
          float rCamDist = length(cameraPosition - vTerrainWorldPos);
          float rNear = 1.0 - smoothstep(10.0, 42.0, rCamDist);
          float rcH = cos(uHoleYaw);
          float rsH = sin(uHoleYaw);
          vec2 rRot = vec2(vTerrainWorldPos.x * rcH + vTerrainWorldPos.z * rsH, -vTerrainWorldPos.x * rsH + vTerrainWorldPos.z * rcH);
          float rBladeH = texture2D(uGrassDetail, rRot * 1.45 + vec2(0.19, 0.41)).r;
          float rMowWave = smoothstep(-0.35, 0.35, sin(rRot.x * 0.92));

          float rwGreen = smoothstep(0.55, 0.90, rsp.g);
          float rwBunk = smoothstep(0.35, 0.65, rsp.b);
          float rwCliff = clamp(max(smoothstep(0.55, 0.85, rsp.a), 1.0 - smoothstep(0.58, 0.82, vTerrainWorldNormal.y)), 0.0, 1.0);
          float tidalR = 1.0 - smoothstep(0.6, 3.6, vTerrainWorldPos.y);

          // Waxy blade tips catch coastal light (0.42..0.58) while shaded root thatch stays matte (0.90)
          float fwRough = mix(0.88, mix(0.68, 0.46, rMowWave), smoothstep(0.15, 0.82, mix(0.6, rBladeH, rNear)));
          float baseRough = mix(mix(0.92, 0.72, rBladeH * rNear), fwRough, smoothstep(0.30, 0.70, rsp.r));
          baseRough = mix(baseRough, mix(0.56, 0.38, rBladeH * rNear), rwGreen);
          baseRough = mix(baseRough, 0.90, rwBunk);
          baseRough = mix(baseRough, mix(0.80, 0.16, tidalR), rwCliff);

          // Per-material photographic gloss from the albedo atlas' packed alpha.
          // Damp hollows read glossier than dry crests, which is what sells the difference
          // between waxy bentgrass, matte fescue, dry silica and damp sandstone without
          // spending another texture unit. Re-sampled at the same rotated UV as the albedo
          // pass so the pattern lines up with what the eye sees.
          if (uPhotoStrength > 0.001) {
            float rGlossTurf = tPhotoAlbedoOctave(uPhotoColorAtlas, rRot * 0.55 + vec2(0.19, 0.41), 0.0, 1.7, 0.0).a;
            float rGlossSand = tPhotoAlbedoOctave(uPhotoColorAtlas, vTerrainWorldPos.xz * 0.5, 2.0, 5.4, 0.0).a;
            float rGlossRock = tPhotoAlbedoOctave(uPhotoColorAtlas, (vTerrainWorldNormal.y < 0.7
              ? vec2(vTerrainWorldPos.x + vTerrainWorldPos.z, vTerrainWorldPos.y)
              : vTerrainWorldPos.xz) * 0.22, 3.0, 9.2, 0.0).a;
            // Damp -> lower roughness. Turf barely moves; sand and stone respond strongly.
            // rGloss* already carry the per-material base roughness, remapped by dampness.
            float photoRough = baseRough;
            photoRough = mix(photoRough, mix(0.74, 0.44, rGlossTurf), rwGreen);
            photoRough = mix(photoRough, mix(0.95, 0.70, rGlossSand), rwBunk);
            photoRough = mix(photoRough, mix(0.90, 0.30, rGlossRock), rwCliff);
            baseRough = mix(baseRough, photoRough, uPhotoStrength * 0.7);
          }

          roughnessFactor = baseRough;
        `
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `
          #include <normal_fragment_maps>
          vec2 nSplatUv = vec2(
            (vTerrainWorldPos.x - uBounds.x) / (uBounds.y - uBounds.x),
            (vTerrainWorldPos.z - uBounds.z) / (uBounds.w - uBounds.z)
          );
          vec4 nsp = texture2D(uSplatMap, clamp(nSplatUv, 0.0, 1.0));
          float nwBunk = smoothstep(0.32, 0.68, nsp.b);
          float nwCliff = clamp(max(smoothstep(0.55, 0.85, nsp.a), 1.0 - smoothstep(0.58, 0.82, vTerrainWorldNormal.y)), 0.0, 1.0);
          float nwGreen = smoothstep(0.55, 0.90, nsp.g);
          float nCamDist = length(cameraPosition - vTerrainWorldPos);
          float nNear = 1.0 - smoothstep(10.0, 44.0, nCamDist);
          float ncH = cos(uHoleYaw);
          float nsH = sin(uHoleYaw);
          vec2 nRot = vec2(vTerrainWorldPos.x * ncH + vTerrainWorldPos.z * nsH, -vTerrainWorldPos.x * nsH + vTerrainWorldPos.z * ncH);

          // Dual-scale 1024px blade normal relief: macro turf crown + sub-centimeter blade midrib edges
          vec3 gNormMacro = texture2D(uGrassNorm, vTerrainWorldPos.xz * 0.36).xyz * 2.0 - 1.0;
          vec3 gNormBlade = texture2D(uGrassNorm, nRot * 1.45 + vec2(0.19, 0.41)).xyz * 2.0 - 1.0;
          vec3 gNormMicro = texture2D(uGrassNorm, nRot * 3.65 + vec2(0.53, 0.27)).xyz * 2.0 - 1.0;
          vec3 gNorm = normalize(gNormMacro * 0.45 + gNormBlade * mix(0.45, 0.88, nNear) + gNormMicro * (0.48 * nNear));

          vec3 sNorm = texture2D(uSandNorm, vTerrainWorldPos.xz * 0.42).xyz * 2.0 - 1.0;
          vec2 cliffUv = vTerrainWorldNormal.y < 0.7
            ? vec2(vTerrainWorldPos.x + vTerrainWorldPos.z, vTerrainWorldPos.y) * 0.16
            : vTerrainWorldPos.xz * 0.16;
          if (nwCliff > 0.12 && nCamDist < 120.0) {
            vec3 nView = normalize(cameraPosition - vTerrainWorldPos);
            vec2 pOff = (vTerrainWorldNormal.y < 0.7 ? vec2(nView.x + nView.z, nView.y) : nView.xz) * 0.022;
            float h0 = uPhotoStrength > 0.001
              ? tPhotoSample(uPhotoNormalAtlas, cliffUv * 1.4, 3.0, 0.0).b
              : texture2D(uRockNorm, cliffUv).a;
            cliffUv -= pOff * (1.0 - h0);
            float h1 = uPhotoStrength > 0.001
              ? tPhotoSample(uPhotoNormalAtlas, cliffUv * 1.4, 3.0, 0.0).b
              : texture2D(uRockNorm, cliffUv).a;
            cliffUv -= pOff * (0.5 - h1 * 0.5);
          }
          vec3 rNorm = texture2D(uRockNorm, cliffUv).xyz * 2.0 - 1.0;

          // Photographic PBR normal maps (real lawn fiber, lumpy sand, sandstone fissures).
          // The atlas packs RG = normal.xy (z is reconstructed) so a whole extra octave fits
          // in the channel the old JPEG wasted. Sampling stays un-rotated: rotating a stored
          // vector field would rotate the lighting response, not just the detail.
          if (uPhotoStrength > 0.001) {
            vec3 gNormPhoto = tPhotoSample(uPhotoNormalAtlas, nRot * 0.55 + vec2(0.19, 0.41), 0.0, 0.0).xyz * 2.0 - 1.0;
            vec3 gNormPhotoFar = tPhotoSample(uPhotoNormalAtlas, vTerrainWorldPos.xz * 0.052 + vec2(0.61, 0.23), 0.0, 1.0).xyz * 2.0 - 1.0;
            vec3 sNormPhoto = tPhotoSample(uPhotoNormalAtlas, vTerrainWorldPos.xz * 0.5, 2.0, 0.0).xyz * 2.0 - 1.0;
            vec3 rNormPhoto = tPhotoSample(uPhotoNormalAtlas, cliffUv * 1.4, 3.0, 0.0).xyz * 2.0 - 1.0;
            // Rebuild z from xy (packed as B = height, not the vector z)
            gNormPhoto.z = sqrt(max(0.0, 1.0 - dot(gNormPhoto.xy, gNormPhoto.xy)));
            gNormPhotoFar.z = sqrt(max(0.0, 1.0 - dot(gNormPhotoFar.xy, gNormPhotoFar.xy)));
            sNormPhoto.z = sqrt(max(0.0, 1.0 - dot(sNormPhoto.xy, sNormPhoto.xy)));
            rNormPhoto.z = sqrt(max(0.0, 1.0 - dot(rNormPhoto.xy, rNormPhoto.xy)));
            vec3 gPhotoMixed = normalize(gNormPhoto + gNormPhotoFar * 0.55);
            gNorm = normalize(mix(gNorm, gPhotoMixed, uPhotoStrength * 0.80));
            sNorm = normalize(mix(sNorm, sNormPhoto, uPhotoStrength * 0.85));
            rNorm = normalize(mix(rNorm, rNormPhoto, uPhotoStrength * 0.90));
          }

          vec2 detailXY = mix(gNorm.xy * mix(0.68, 0.26, nwGreen), sNorm.xy * 0.62, nwBunk);
          detailXY = mix(detailXY, rNorm.xy * 0.95, nwCliff);
          vec3 worldPerturb = vTerrainWorldNormal.y < 0.7 && nwCliff > 0.4
            ? vec3(detailXY.x * 0.5, detailXY.y, detailXY.x * 0.5) * 0.48
            : vec3(detailXY.x, 0.0, detailXY.y) * 0.48;
          vec3 viewPerturb = (viewMatrix * vec4(worldPerturb, 0.0)).xyz;
          normal = normalize(normal + viewPerturb);
        `
        )
        .replace(
          '#include <lights_fragment_end>',
          /* glsl */ `
          #include <lights_fragment_end>
          // Projected moving cloud shadows modulate direct sun while preserving cool ambient sky fill!
          vec2 cloudGroundUv = vTerrainWorldPos.xz * 0.0042 + uCloudOffset * 1.15 - (uSunDir.xz / max(uSunDir.y + 0.18, 0.25)) * 0.28;
          float cloudDensity = tFbm(cloudGroundUv * 1.15) * 0.78 + tNoise(cloudGroundUv * 2.6) * 0.22;
          float cloudShadow = 1.0 - smoothstep(uCloudCoverage - 0.03, uCloudCoverage + 0.28, cloudDensity) * 0.54;
          reflectedLight.directDiffuse *= cloudShadow;
          reflectedLight.directSpecular *= cloudShadow;

          // Coastal morning dew & waxy grass-blade cuticle micro-sparkles + bunker silica quartz glitter
          float lDist = length(cameraPosition - vTerrainWorldPos);
          float lNear = 1.0 - smoothstep(6.0, 28.0, lDist);
          if (lNear > 0.01) {
            float lcH = cos(uHoleYaw);
            float lsH = sin(uHoleYaw);
            vec2 lRot = vec2(vTerrainWorldPos.x * lcH + vTerrainWorldPos.z * lsH, -vTerrainWorldPos.x * lsH + vTerrainWorldPos.z * lcH);
            vec3 lDetail = texture2D(uGrassDetail, lRot * 3.65 + vec2(0.53, 0.27)).rgb;
            vec2 lSplatUv = vec2(
              (vTerrainWorldPos.x - uBounds.x) / (uBounds.y - uBounds.x),
              (vTerrainWorldPos.z - uBounds.z) / (uBounds.w - uBounds.z)
            );
            vec4 lsp = texture2D(uSplatMap, clamp(lSplatUv, 0.0, 1.0));
            float onTurf = (1.0 - smoothstep(0.25, 0.55, lsp.b)) * smoothstep(0.65, 0.88, vTerrainWorldNormal.y);
            vec3 lHalf = normalize(uSunDir + geometryViewDir);
            float specBlade = pow(clamp(dot(geometryNormal, lHalf), 0.0, 1.0), 38.0);
            float dewBead = smoothstep(0.84, 0.98, lDetail.r) * smoothstep(0.76, 0.96, lDetail.g);
            reflectedLight.directSpecular += vec3(0.85, 0.96, 0.78) * specBlade * dewBead * cloudShadow * onTurf * lNear * 0.34;

            // Crystalline quartz sand micro-glitter inside bunkers
            float onSand = smoothstep(0.35, 0.68, lsp.b);
            if (onSand > 0.05) {
              vec2 qCell = floor(vTerrainWorldPos.xz * 48.0);
              float qHash = tNoise(qCell * 0.37);
              float qHash2 = tNoise(qCell * 0.71 + vec2(5.3, 9.1));
              vec3 grainN = normalize(vec3((qHash - 0.5) * 1.15, 1.0, (qHash2 - 0.5) * 1.15));
              float quartzGlint = pow(clamp(dot(grainN, lHalf), 0.0, 1.0), 150.0) * smoothstep(0.64, 0.94, qHash);
              reflectedLight.directSpecular += vec3(1.0, 0.96, 0.88) * quartzGlint * cloudShadow * onSand * lNear * 1.45;
            }
          }
          // Grazing-angle sunlit grass velvet sheen across rolling fairways & mounds
          float turfFresnel = pow(1.0 - clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0), 3.4);
          float forwardScatter = 0.35 + 0.65 * max(dot(-uSunDir, geometryViewDir), 0.0);
          reflectedLight.directDiffuse += vec3(0.11, 0.16, 0.04) * turfFresnel * forwardScatter * cloudShadow * smoothstep(0.65, 0.92, vTerrainWorldNormal.y) * 0.32;
        `
        )
        .replace(
          '#include <fog_fragment>',
          /* glsl */ `
          #include <fog_fragment>
          // Height-layered coastal marine mist + warm sun in-scatter
          vec3 mViewDir = normalize(vTerrainWorldPos - cameraPosition);
          float sunScatter = pow(max(dot(mViewDir, uSunDir), 0.0), 4.0);
          float mistDist = length(cameraPosition - vTerrainWorldPos);
          float mistElev = exp(-max(0.0, vTerrainWorldPos.y - 1.5) * 0.14);
          float mistAmount = clamp((1.0 - exp(-mistDist * uMistDensity * 1.55)) * mistElev, 0.0, 0.58);
          vec3 aerialCol = mix(uMistColor, uMistColor * vec3(1.12, 1.02, 0.88), sunScatter * 0.35);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, aerialCol, mistAmount);
        `
        );
    };

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.scene.add(this.mesh);

    // 5. Build Physical USGA Recessed Cup Liner Ring + Bottom
    this.buildCupGeometry(sampler.cupPosition);

    // 6. Build Hole 3 Coastal Stone Sea-Wall if present
    if (hole.seawallSegments) {
      this.buildSeawall(hole.seawallSegments);
    }
  }

  private buildCupGeometry(cupPos: { x: number; y: number; z: number }): void {
    const group = new THREE.Group();
    group.position.set(cupPos.x, cupPos.y, cupPos.z);

    // Dark recessed interior cylinder
    const innerGeo = new THREE.CylinderGeometry(0.053, 0.053, 0.11, 28, 1, true);
    const innerMat = new THREE.MeshStandardMaterial({
      color: 0x111111,
      roughness: 0.9,
      side: THREE.BackSide,
    });
    const inner = new THREE.Mesh(innerGeo, innerMat);
    inner.position.y = -0.052;
    group.add(inner);

    // White regulation USGA plastic liner collar (2.5 cm below turf lip)
    const linerGeo = new THREE.CylinderGeometry(0.052, 0.052, 0.075, 28, 1, true);
    const linerMat = new THREE.MeshStandardMaterial({
      color: 0xf4f4ef,
      roughness: 0.35,
      side: THREE.BackSide,
    });
    const liner = new THREE.Mesh(linerGeo, linerMat);
    liner.position.y = -0.062;
    group.add(liner);

    // Cup bottom disc
    const baseGeo = new THREE.CircleGeometry(0.054, 24);
    baseGeo.rotateX(-Math.PI / 2);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = -0.102;
    group.add(base);

    // Crisp rim shadow ring sitting flush on green
    const rimGeo = new THREE.RingGeometry(0.052, 0.057, 32);
    rimGeo.rotateX(-Math.PI / 2);
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0x3b3528,
      roughness: 0.9,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.y = 0.002;
    group.add(rim);

    this.cupGroup = group;
    this.scene.add(group);
  }

  private buildSeawall(
    segments: Array<{ x1: number; z1: number; x2: number; z2: number; topElevation: number }>
  ): void {
    const group = new THREE.Group();
    const stoneMat = new THREE.MeshStandardMaterial({
      color: 0x6f685b,
      normalMap: this.textures.rockNormal,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughness: 0.88,
    });

    for (const seg of segments) {
      const dx = seg.x2 - seg.x1;
      const dz = seg.z2 - seg.z1;
      const len = Math.hypot(dx, dz);
      const count = Math.max(4, Math.ceil(len / 2.2));
      const yaw = Math.atan2(dx, dz);

      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count;
        const px = seg.x1 + dx * t;
        const pz = seg.z1 + dz * t;
        const block = new THREE.Mesh(new THREE.BoxGeometry(1.35, 3.8, len / count + 0.15), stoneMat);
        block.position.set(px, seg.topElevation - 1.35, pz);
        block.rotation.y = yaw;
        block.castShadow = true;
        block.receiveShadow = true;
        group.add(block);
      }
    }

    this.seawallGroup = group;
    this.scene.add(group);
  }

  /**
   * Builds a strictly monotonic warped 1D coordinate array concentrating spacing near focusCoord.
   */
  private buildWarpedAxis(
    minVal: number,
    maxVal: number,
    focusCoord: number,
    focusWidth: number,
    segments: number
  ): Float32Array {
    // Integrate density rho(x) = 1 + 2.8 * exp(-((x - focus)/focusWidth)^2) across [minVal, maxVal]
    const samples = 1024;
    const step = (maxVal - minVal) / samples;
    const cdf = new Float64Array(samples + 1);
    for (let i = 0; i < samples; i++) {
      const xMid = minVal + (i + 0.5) * step;
      const d = (xMid - focusCoord) / focusWidth;
      const density = 1.0 + 3.0 * Math.exp(-d * d);
      cdf[i + 1] = cdf[i] + density;
    }
    const total = cdf[samples];

    const coords = new Float32Array(segments + 1);
    let j = 0;
    for (let k = 0; k <= segments; k++) {
      const target = (k / segments) * total;
      while (j < samples - 1 && cdf[j + 1] < target) j++;
      const frac = (target - cdf[j]) / Math.max(1e-9, cdf[j + 1] - cdf[j]);
      coords[k] = minVal + (j + frac) * step;
    }
    coords[0] = minVal;
    coords[segments] = maxVal;
    return coords;
  }

  public setGreenGridVisible(visible: boolean): void {
    this.showGreenGrid = visible;
    if (this.shaderUniforms) {
      this.shaderUniforms.uShowGreenGrid.value = visible ? 1.0 : 0.0;
    }
  }

  public update(
    timeS: number,
    sunDir?: THREE.Vector3,
    cloudOffset?: THREE.Vector2,
    cloudCoverage?: number,
    mistColor?: THREE.Color,
    mistDensity?: number
  ): void {
    if (this.shaderUniforms) {
      this.shaderUniforms.uTime.value = timeS;
      if (sunDir) this.shaderUniforms.uSunDir.value.copy(sunDir).normalize();
      if (cloudOffset) this.shaderUniforms.uCloudOffset.value.copy(cloudOffset);
      if (cloudCoverage !== undefined) this.shaderUniforms.uCloudCoverage.value = cloudCoverage;
      if (mistColor) this.shaderUniforms.uMistColor.value.copy(mistColor);
      if (mistDensity !== undefined) this.shaderUniforms.uMistDensity.value = mistDensity;
    }
  }

  public clearCurrent(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
    if (this.cupGroup) {
      this.scene.remove(this.cupGroup);
      this.cupGroup.traverse((o) => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
        if ((o as THREE.Mesh).material) ((o as THREE.Mesh).material as THREE.Material).dispose();
      });
      this.cupGroup = null;
    }
    if (this.seawallGroup) {
      this.scene.remove(this.seawallGroup);
      this.seawallGroup.traverse((o) => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
        if ((o as THREE.Mesh).material) ((o as THREE.Mesh).material as THREE.Material).dispose();
      });
      this.seawallGroup = null;
    }
    if (this.splatTexture) {
      this.splatTexture.dispose();
      this.splatTexture = null;
    }
    if (this.greenSlopeTexture) {
      this.greenSlopeTexture.dispose();
      this.greenSlopeTexture = null;
    }
    this.shaderUniforms = null;
    this.gridXCoords = null;
    this.gridZCoords = null;
    this.gridPositions = null;
    this.gridSegX = 0;
  }

  /**
   * Returns exact interpolated Y on the rendered GPU terrain triangle at world (x, z) in O(log N) time,
   * eliminating discrepancies on bunker lips or ridge chords between analytic height and grid triangles.
   */
  public getMeshHeightAt(x: number, z: number): number | null {
    const pos = this.gridPositions;
    const xs = this.gridXCoords;
    const zs = this.gridZCoords;
    if (!pos || !xs || !zs || xs.length < 2 || zs.length < 2) return null;

    let loX = 0;
    let hiX = xs.length - 2;
    while (loX < hiX) {
      const mid = (loX + hiX + 1) >> 1;
      if (xs[mid] <= x) loX = mid;
      else hiX = mid - 1;
    }
    const ix = loX;

    let loZ = 0;
    let hiZ = zs.length - 2;
    while (loZ < hiZ) {
      const mid = (loZ + hiZ + 1) >> 1;
      if (zs[mid] <= z) loZ = mid;
      else hiZ = mid - 1;
    }
    const iz = loZ;

    const stride = this.gridSegX + 1;
    const a = iz * stride + ix;
    const b = a + 1;
    const c = a + stride;
    const d = c + 1;

    const fx = clamp((x - xs[ix]) / Math.max(1e-6, xs[ix + 1] - xs[ix]), 0, 1);
    const fz = clamp((z - zs[iz]) / Math.max(1e-6, zs[iz + 1] - zs[iz]), 0, 1);

    const yA = pos[a * 3 + 1];
    const yB = pos[b * 3 + 1];
    const yC = pos[c * 3 + 1];
    const yD = pos[d * 3 + 1];

    if (fx + fz <= 1) {
      return yA + fx * (yB - yA) + fz * (yC - yA);
    }
    return yD + (1 - fx) * (yC - yD) + (1 - fz) * (yB - yD);
  }

  public updateCupPosition(cupPos: { x: number; y: number; z: number }): void {
    if (this.cupGroup) {
      this.cupGroup.position.set(cupPos.x, cupPos.y, cupPos.z);
    }
    if (this.shaderUniforms?.uCupPos) {
      (this.shaderUniforms.uCupPos.value as THREE.Vector3).set(cupPos.x, cupPos.y, cupPos.z);
    }
  }

  public dispose(): void {
    this.clearCurrent();
  }
}
