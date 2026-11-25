import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ClubCategory, ClubSpec } from '../physics/clubs';
import { BALL_RADIUS_M } from '../physics/constants';
import { GolferRig, type SwingAnimPhase } from './GolferRig';
import type { CourseTextureSet } from './ProceduralTextures';

interface BoneRestState {
  bone: THREE.Object3D;
  restLocalPos: THREE.Vector3;
  restLocalQuat: THREE.Quaternion;
  restWorldPos: THREE.Vector3;
  restWorldQuat: THREE.Quaternion;
  restDirWorld: THREE.Vector3;
  restTwistRefWorld: THREE.Vector3;
  length: number;
}

const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const;

const ARKIT_CONFIDENT: Record<string, number> = {
  mouthSmileLeft: 0.14,
  mouthSmileRight: 0.14,
  browDownLeft: 0.12,
  browDownRight: 0.12,
  eyeSquintLeft: 0.14,
  eyeSquintRight: 0.14,
};

/**
 * Generates a fine procedural dermal pore tangent-space normal map for high-res skin close-ups.
 */
function createDermalPoreNormalMap(): THREE.DataTexture {
  const N = 256;
  const h = new Float32Array(N * N);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2400; i++) {
    const cx = rand() * N;
    const cy = rand() * N;
    const r = 0.8 + rand() * 1.5;
    const d = 0.4 + rand() * 0.6;
    for (let y = -3; y <= 3; y++) {
      for (let x = -3; x <= 3; x++) {
        const px = (Math.floor(cx) + x + N) % N;
        const py = (Math.floor(cy) + y + N) % N;
        const dist = Math.hypot(x + (cx % 1) - 0.5, y + (cy % 1) - 0.5);
        if (dist < r * 2) h[py * N + px] -= d * Math.exp(-(dist * dist) / (r * r));
      }
    }
  }
  for (let i = 0; i < N * N; i++) h[i] += (rand() - 0.5) * 0.22;

  const img = new Uint8ClampedArray(N * N * 4);
  const at = (xx: number, yy: number) => h[((yy + N) % N) * N + ((xx + N) % N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = at(x + 1, y) - at(x - 1, y);
      const dy = at(x, y + 1) - at(x, y - 1);
      const n = new THREE.Vector3(-dx, -dy, 2).normalize();
      const idx = (y * N + x) * 4;
      img[idx] = Math.round((n.x * 0.5 + 0.5) * 255);
      img[idx + 1] = Math.round((n.y * 0.5 + 0.5) * 255);
      img[idx + 2] = Math.round((n.z * 0.5 + 0.5) * 255);
      img[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(img, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(20, 20);
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a fine 2/2 diagonal twill fabric weave normal map for realistic golf shirt & trousers.
 */
function createTwillWeaveNormalMap(): THREE.DataTexture {
  const N = 128;
  const T = 16;
  const W = N / T;
  const h = new Float32Array(N * N);
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const jitter = Array.from({ length: T * 2 }, () => 0.78 + rand() * 0.44);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const tx = Math.floor(x / W);
      const ty = Math.floor(y / W);
      const fx = ((x % W) + 0.5) / W;
      const fy = ((y % W) + 0.5) / W;
      const warpUp = (tx + ty) % 4 < 2;
      const warp = Math.sin(Math.PI * fx) * jitter[tx];
      const weft = Math.sin(Math.PI * fy) * jitter[T + ty];
      h[y * N + x] =
        (warpUp ? warp * (0.6 + 0.4 * Math.sin(Math.PI * fy)) : weft * (0.6 + 0.4 * Math.sin(Math.PI * fx))) +
        (rand() - 0.5) * 0.14;
    }
  }
  const img = new Uint8ClampedArray(N * N * 4);
  const at = (xx: number, yy: number) => h[((yy + N) % N) * N + ((xx + N) % N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 1.25;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 1.25;
      const n = new THREE.Vector3(-dx, -dy, 2).normalize();
      const idx = (y * N + x) * 4;
      img[idx] = Math.round((n.x * 0.5 + 0.5) * 255);
      img[idx + 1] = Math.round((n.y * 0.5 + 0.5) * 255);
      img[idx + 2] = Math.round((n.z * 0.5 + 0.5) * 255);
      img[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(img, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(55, 55);
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Exact 2-bone analytical IK solver in wrapper/rig-local space.
 */
function solveTwoBoneIK(
  rootPos: THREE.Vector3,
  targetPos: THREE.Vector3,
  len1: number,
  len2: number,
  poleHint: THREE.Vector3
): THREE.Vector3 {
  const diff = new THREE.Vector3().subVectors(targetPos, rootPos);
  const rawDist = diff.length();
  const maxReach = (len1 + len2) * 0.996;
  const minReach = Math.abs(len1 - len2) + 0.025;
  const dist = THREE.MathUtils.clamp(rawDist, minReach, maxReach);
  const dir = rawDist > 1e-5 ? diff.divideScalar(rawDist) : new THREE.Vector3(0, -1, 0);

  const bendPlane = new THREE.Vector3().copy(poleHint).sub(
    new THREE.Vector3().copy(dir).multiplyScalar(poleHint.dot(dir))
  );
  if (bendPlane.lengthSq() < 1e-6) {
    bendPlane.set(-1, 0, 0);
  } else {
    bendPlane.normalize();
  }

  const cosA = THREE.MathUtils.clamp(
    (len1 * len1 + dist * dist - len2 * len2) / (2 * len1 * dist),
    -1,
    1
  );
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  return new THREE.Vector3()
    .copy(rootPos)
    .addScaledVector(dir, len1 * cosA)
    .addScaledVector(bendPlane, len1 * sinA);
}

/**
 * Photorealistic rigged 3D Golf Athlete driven by a studio-scanned human skeleton
 * (`public/models/golfer.glb`, Microsoft Rocketbox MIT) with real-time 2-bone IK,
 * PGA Tour biomechanics, 5-finger grip articulation, facial micro-expressions, blinking,
 * and ball-tracking eye bones — falling back cleanly to `GolferRig` during initial load.
 */
export class SkinnedGolferRig {
  public readonly root = new THREE.Group();

  private readonly fallbackRig: GolferRig;
  private modelWrapper: THREE.Group | null = null;
  private clubMount = new THREE.Group();
  private activeClubGroup: THREE.Group | null = null;
  private currentClubCategory: ClubCategory = 'wood';
  private currentClubLoft = 10.5;
  private readonly textures: CourseTextureSet;

  private bones = new Map<string, BoneRestState>();
  private allBones: BoneRestState[] = [];
  private morphMeshes: THREE.Mesh[] = [];
  private leftEyeBone: THREE.Object3D | null = null;
  private rightEyeBone: THREE.Object3D | null = null;
  private leftEyeRestQ = new THREE.Quaternion();
  private rightEyeRestQ = new THREE.Quaternion();
  private headBone: THREE.Object3D | null = null;
  private rightForeArmBone: THREE.Object3D | null = null;
  private rightHandBone: THREE.Object3D | null = null;

  private extraMaps: THREE.Texture[] = [];
  private leadShoeShadow: THREE.Mesh;
  private trailShoeShadow: THREE.Mesh;
  private shoeShadowMat: THREE.MeshBasicMaterial;
  private loaded = false;
  private disposed = false;
  public meshVersion = 0;

  public get isLoaded(): boolean {
    return this.loaded;
  }

  // Blink & micro-life state
  private simTimeS = 0;
  private nextBlinkS = 2.0;

  // Cached last pose args
  private lastBallPos = { x: 0, y: BALL_RADIUS_M, z: 0 };
  private lastAimYaw = 0;
  private lastClub: ClubSpec | null = null;
  private lastVisible = true;
  private lastPhase: SwingAnimPhase = 'address';
  private lastPhaseT = 0;
  private lastClubPath = 0;
  private lastGroundHeightAt?: (x: number, z: number) => number;

  constructor(textures: CourseTextureSet, autoLoad = typeof window !== 'undefined') {
    this.textures = textures;
    this.fallbackRig = new GolferRig(textures);
    // Keep procedural fallback hidden while golfer.glb loads so no dummy figure flashes on startup
    this.fallbackRig.root.visible = false;
    this.root.add(this.fallbackRig.root);
    this.root.add(this.clubMount);
    this.clubMount.visible = false;

    const shadowTex = this.createShoeContactShadowTexture();
    this.extraMaps.push(shadowTex);
    this.shoeShadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      opacity: 0.44,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    const shadowGeo = new THREE.PlaneGeometry(0.32, 0.16);
    shadowGeo.rotateX(-Math.PI / 2);
    this.leadShoeShadow = new THREE.Mesh(shadowGeo, this.shoeShadowMat);
    this.trailShoeShadow = new THREE.Mesh(shadowGeo.clone(), this.shoeShadowMat.clone());
    this.leadShoeShadow.position.set(0.08, 0.008, -0.26);
    this.trailShoeShadow.position.set(0.10, 0.008, 0.26);
    this.leadShoeShadow.renderOrder = 1;
    this.trailShoeShadow.renderOrder = 1;
    this.root.add(this.leadShoeShadow, this.trailShoeShadow);

    this.setClubModel('wood', 10.5);
    if (autoLoad) {
      this.loadGlbCharacter('/models/golfer.glb');
    }
  }

  private createShoeContactShadowTexture(): THREE.DataTexture {
    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      const ny = (y / (size - 1)) * 2 - 1;
      for (let x = 0; x < size; x++) {
        const nx = (x / (size - 1)) * 2 - 1;
        const r2 = nx * nx * 1.05 + ny * ny * 1.25;
        const alpha = Math.max(0, Math.exp(-r2 * 3.1) - 0.04) * 255;
        const idx = (y * size + x) * 4;
        data[idx] = 8;
        data[idx + 1] = 14;
        data[idx + 2] = 10;
        data[idx + 3] = Math.round(Math.min(255, alpha));
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  private loadGlbCharacter(url: string): void {
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        if (this.disposed) return;
        this.attachLoadedCharacter(gltf.scene);
      },
      undefined,
      (err) => {
        console.warn('Could not load hyper-realistic golfer.glb, using procedural rig fallback:', err);
        this.fallbackRig.root.visible = true;
      }
    );
  }

  /**
   * Attaches and initializes a parsed GLTF scene (usable both by GLTFLoader in browser and tests).
   */
  public attachLoadedCharacter(gltfScene: THREE.Object3D): void {
    const wrapper = new THREE.Group();
    // Rocketbox native rig faces +Z with Left=+X, Right=-X.
    // Rotating +PI/2 around Y maps face (+Z) -> +X (toward golf ball) and Left (+X) -> -Z (toward target)!
    gltfScene.rotation.y = Math.PI / 2;
    wrapper.add(gltfScene);

    this.configureOutfitAndMaterials(gltfScene);

    // Measure rest poses in `wrapper` local space (which shares identity with `this.root`!)
    wrapper.updateMatrixWorld(true);
    this.captureRestSkeleton(gltfScene);
    this.attachTourGolfCap();
    this.attachRightWristWatch(gltfScene);

    this.modelWrapper = wrapper;
    this.root.add(wrapper);
    this.fallbackRig.root.visible = false;
    this.clubMount.visible = true;
    this.loaded = true;
    this.meshVersion++;

    if (this.lastClub) {
      this.updatePose(
        this.lastBallPos,
        this.lastAimYaw,
        this.lastClub,
        this.lastVisible,
        this.lastPhase,
        this.lastPhaseT,
        this.lastClubPath,
        0,
        this.lastGroundHeightAt
      );
    }
  }

  private configureOutfitAndMaterials(sceneRoot: THREE.Object3D): void {
    const aniso = Math.max(4, this.textures?.maxAnisotropy ?? 8);
    const poreMap = this.textures?.skinNormal ?? createDermalPoreNormalMap();
    const twillMap = this.textures?.fabricNormal ?? createTwillWeaveNormalMap();
    const leatherMap = this.textures?.leatherNormal ?? twillMap;
    if (!this.textures?.skinNormal) this.extraMaps.push(poreMap);
    if (!this.textures?.fabricNormal) this.extraMaps.push(twillMap);

    // Athletic Tour Golf attire from the modular Rocketbox meshes inside golfer.glb
    // Top 'Hair' cards sit completely underneath the fitted TourGolfCap (sideburns/nape remain on Body)
    const visibleMeshes = new Set([
      'Body',
      'Top_tee',
      'Skin_tee',
      'Trousers',
      'Shoes',
    ]);
    const toggleMeshes = new Set([
      'Hair',
      'Outfit_formal',
      'Outfit_original',
      'Skin_formal',
      'Skin_original',
      'Skin_shirt',
      'Skin_tee',
      'Top_shirt',
      'Top_tee',
      'Trousers',
      'Shoes',
    ]);

    this.morphMeshes = [];

    sceneRoot.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;

      const label = mesh.name && !/^mesh_\d|_\d+$/.test(mesh.name)
        ? mesh.name
        : mesh.parent?.name ?? mesh.name;

      if (toggleMeshes.has(label)) {
        mesh.visible = visibleMeshes.has(label);
      }

      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;

      if (mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
        this.morphMeshes.push(mesh);
      }

      const src = mesh.material as THREE.MeshStandardMaterial;
      if (!src) return;

      // Boost texture filtering anisotropy across ALL embedded 2048x2048 maps so grazing angles never blur!
      for (const tex of [src.map, src.normalMap, src.roughnessMap, src.aoMap]) {
        if (tex) {
          tex.anisotropy = aniso;
          tex.needsUpdate = true;
        }
      }

      const mat = new THREE.MeshPhysicalMaterial({
        name: src.name,
        map: src.map,
        normalMap: src.normalMap,
        normalScale: src.normalScale ? src.normalScale.clone() : new THREE.Vector2(1, 1),
        color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
        roughness: src.roughness ?? 0.65,
        metalness: 0,
        roughnessMap: src.roughnessMap,
        aoMap: src.aoMap,
        aoMapIntensity: 1.0,
        side: src.side,
      });

      if (label === 'Hair') {
        // Crisp single-pass alphaToCoverage hair without soft transparent halo
        Object.assign(mat, {
          alphaTest: 0.48,
          alphaToCoverage: true,
          side: THREE.DoubleSide,
          roughness: 0.70,
          sheen: 0.14,
          sheenRoughness: 0.45,
          specularIntensity: 0.30,
        });
        mat.color.set(0xebe4da);
        mat.sheenColor.set(0x4a392c);
        this.applyCoastalRimShader(mat, 0.14, 'hair-rim-v2');
      } else if (label === 'Body' || label.startsWith('Skin')) {
        // High-definition dual-lobe skin: 2048 macro scan + 512 dermal micro-pore normal + wet cornea eyes
        const hasOwnNormal = !!src.normalMap;
        Object.assign(mat, {
          roughness: label === 'Body' ? 0.50 : 0.46,
          sheen: label === 'Body' ? 0.14 : 0.20,
          sheenRoughness: 0.68,
          specularIntensity: 0.52,
          normalMap: hasOwnNormal ? src.normalMap : poreMap,
          clearcoat: label === 'Body' ? 0.16 : 0.10,
          clearcoatRoughness: 0.36,
        });
        if (hasOwnNormal) mat.normalScale.set(1.20, 1.20);
        else mat.normalScale.set(0.45, 0.45);
        mat.color.set(0xffffff);
        mat.sheenColor.set(0xf59e85);

        if (label === 'Skin_tee' && (mesh as THREE.SkinnedMesh).isSkinnedMesh) {
          this.applyCabrettaGloveShader(mesh as THREE.SkinnedMesh, mat, poreMap, leatherMap);
        } else {
          this.applyHighDefHeadSkinShader(mat, poreMap);
        }
      } else if (label === 'Shoes') {
        // Crisp Pebble-Grain Tour White Saddle Golf Shoes with Navy Saddle Trim & Cleated Soles
        mat.color.set(0xffffff);
        mat.roughness = 0.34;
        mat.roughnessMap = null;
        mat.clearcoat = 0.42;
        mat.clearcoatRoughness = 0.28;
        mat.specularIntensity = 0.70;
        this.applyTourGolfShoeShader(mat, leatherMap);
      } else if (label === 'Top_tee') {
        // Tailored Tucked-In Coastal Navy Piqué Tour Golf Polo with micro-fiber cotton sheen
        mat.color.set(0xffffff);
        mat.roughness = 0.82;
        mat.roughnessMap = null;
        mat.sheen = 0.32;
        mat.sheenRoughness = 0.70;
        mat.sheenColor.set(0x5e89bd);
        mat.specularIntensity = 0.26;
        if (src.normalMap) mat.normalScale.set(0.95, 0.95);
        this.applyTourPoloShader(mat, this.textures?.poloAlbedo ?? null, twillMap);
      } else if (label === 'Trousers') {
        // Tailored Pebble Stone-Khaki Chino Trousers with micro-fiber gabardine sheen
        mat.color.set(0xffffff);
        mat.roughness = 0.82;
        mat.roughnessMap = null;
        mat.sheen = 0.26;
        mat.sheenRoughness = 0.78;
        mat.sheenColor.set(0xf5efe2);
        mat.specularIntensity = 0.22;
        if (src.normalMap) mat.normalScale.set(0.85, 0.85);
        this.applyTailoredChinosShader(mat, this.textures?.trouserAlbedo ?? null, twillMap);
      }

      src.dispose();
      mesh.material = mat;
    });
  }

  private applyCoastalRimShader(
    mat: THREE.MeshPhysicalMaterial,
    strength: number,
    cacheKey: string
  ): void {
    mat.customProgramCacheKey = () => cacheKey;
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
         float rim = pow(1.0 - clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0), 3.4);
         reflectedLight.indirectSpecular += vec3(0.42, 0.56, 0.72) * rim * ${strength.toFixed(2)};`
      );
    };
  }

  /**
   * Remaps the dark oxford leather texture on `Shoes` into crisp Tour White pebble-grain golf shoes
   * with dark navy spiked rubber outsoles (`position.y < 0.022`) + fine leather grain micro-normal.
   */
  private applyTourGolfShoeShader(
    mat: THREE.MeshPhysicalMaterial,
    leatherMap: THREE.Texture
  ): void {
    mat.customProgramCacheKey = () => 'tour-golf-shoes-v4';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uLeatherNorm = { value: leatherMap };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vShoeBindY;\nvarying vec2 vShoeUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShoeBindY = position.y;\nvShoeUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uLeatherNorm;\nvarying float vShoeBindY;\nvarying vec2 vShoeUv;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float shoeLuma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          vec3 tourWhite = vec3(0.92, 0.91, 0.88) * (0.72 + clamp(shoeLuma * 2.1, 0.0, 0.34));
          vec3 navyTrim = vec3(0.13, 0.21, 0.35) * (0.85 + shoeLuma);
          vec3 soleRubber = vec3(0.10, 0.13, 0.17);
          float soleMask = smoothstep(0.024, 0.015, vShoeBindY);
          float tongueTrim = smoothstep(0.088, 0.098, vShoeBindY) * 0.45;
          diffuseColor.rgb = mix(mix(tourWhite, navyTrim, tongueTrim), soleRubber, soleMask);`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          #ifdef USE_NORMALMAP_TANGENTSPACE
            vec3 shN = texture2D(uLeatherNorm, vShoeUv * 14.0).xyz * 2.0 - 1.0;
            normal = normalize(normal + (tbn * vec3(shN.xy * 0.38, 0.0)));
          #endif`
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
           // Natural green turf bounce onto lower shoes and cleats
           float turfZone = smoothstep(0.14, 0.01, vShoeBindY);
           float downwardN = clamp(-geometryNormal.y * 0.5 + 0.5, 0.0, 1.0);
           reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.08, 0.16, 0.045) * turfZone * (0.45 + 0.55 * downwardN);
           float shoeRim = pow(1.0 - clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0), 3.6);
           reflectedLight.indirectSpecular += vec3(0.45, 0.58, 0.72) * shoeRim * 0.22;`
        );
    };
  }

  private applyHighDefHeadSkinShader(
    mat: THREE.MeshPhysicalMaterial,
    poreMap: THREE.Texture
  ): void {
    mat.customProgramCacheKey = () => 'head-skin-hd-v5';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uDermalNorm = { value: poreMap };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vHeadUv;\nvarying vec3 vHeadLocalPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeadUv = uv;\nvHeadLocalPos = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uDermalNorm;\nvarying vec2 vHeadUv;\nvarying vec3 vHeadLocalPos;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float eyeRegion = step(vHeadUv.x, 0.34) * step(0.87, vHeadUv.y);
          // Subtle upper-eyelid ambient shadow gradient on eye sockets for natural depth
          float upperLidAO = 1.0 - eyeRegion * smoothstep(0.952, 0.996, vHeadUv.y) * 0.34;
          vec3 poreSample = texture2D(uDermalNorm, vHeadUv * 34.0).xyz;
          diffuseColor.rgb *= (mix(0.955, 1.045, poreSample.y) * (1.0 - eyeRegion) + eyeRegion) * upperLidAO;`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          #ifdef USE_NORMALMAP_TANGENTSPACE
            float nEye = step(vHeadUv.x, 0.34) * step(0.87, vHeadUv.y);
            vec3 microPore = texture2D(uDermalNorm, vHeadUv * 34.0).xyz * 2.0 - 1.0;
            normal = normalize(normal + (tbn * vec3(microPore.xy * 0.38 * (1.0 - nEye), 0.0)));
          #endif`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          float rEye = step(vHeadUv.x, 0.34) * step(0.87, vHeadUv.y);
          float tZone = smoothstep(0.055, 0.0, abs(vHeadLocalPos.x)) * smoothstep(1.62, 1.72, vHeadLocalPos.y);
          float skinRough = clamp(roughnessFactor, 0.32, 0.58) - tZone * 0.07;
          roughnessFactor = mix(skinRough, 0.025, rEye);`
        )
        .replace(
          '#include <lights_physical_fragment>',
          `#include <lights_physical_fragment>
          #ifdef USE_CLEARCOAT
            float ccEye = step(vHeadUv.x, 0.34) * step(0.87, vHeadUv.y);
            float ccTZone = smoothstep(0.055, 0.0, abs(vHeadLocalPos.x)) * smoothstep(1.62, 1.72, vHeadLocalPos.y);
            material.clearcoat = mix(0.14 + ccTZone * 0.16, 0.96, ccEye);
            material.clearcoatRoughness = mix(0.36, 0.0525, ccEye);
          #endif`
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
           float lEye = step(vHeadUv.x, 0.34) * step(0.87, vHeadUv.y);
           // Pre-integrated wrapped hemoglobin subsurface scatter on skin terminators
           float NdotV_skin = clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0);
           float sssWrap = pow(1.0 - NdotV_skin, 1.55) * 0.45 + 0.55;
           vec3 dermalScatter = diffuseColor.rgb * vec3(0.22, 0.058, 0.024) * sssWrap;
           reflectedLight.indirectDiffuse += dermalScatter * (1.0 - lEye);
           float skinRim = pow(1.0 - NdotV_skin, 3.6);
           reflectedLight.indirectSpecular += vec3(0.46, 0.60, 0.76) * skinRim * mix(0.20, 0.46, lEye);`
        );
    };
  }

  private applyTourPoloShader(
    mat: THREE.MeshPhysicalMaterial,
    poloTex: THREE.Texture | null,
    fabricNorm: THREE.Texture
  ): void {
    mat.customProgramCacheKey = () => 'tour-polo-hd-v2';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uPoloDetail = { value: poloTex };
      shader.uniforms.uFabricNorm = { value: fabricNorm };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vPoloUv;\nvarying vec3 vPoloBind;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vPoloUv = uv;
          // Preserve Top_tee natural tailored hem outside trousers so it never Z-fights the waistband
          vPoloBind = position;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\nuniform sampler2D uPoloDetail;\nuniform sampler2D uFabricNorm;\nvarying vec2 vPoloUv;\nvarying vec3 vPoloBind;`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float foldLuma = clamp(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)), 0.35, 1.10);
          vec3 pique = texture2D(uPoloDetail, vPoloUv * 8.0).rgb;
          vec3 poloCol = pique * mix(1.0, foldLuma, 0.42);

          // Tailored 3D-shaded coastal polo collar rib & 2-button chest placket mapped directly onto skinned mesh!
          float collarBand = smoothstep(1.505, 1.528, vPoloBind.y) * (1.0 - smoothstep(1.548, 1.568, vPoloBind.y));
          float chestPlacket = (1.0 - smoothstep(0.011, 0.015, abs(vPoloBind.x))) *
                               smoothstep(1.372, 1.382, vPoloBind.y) * (1.0 - smoothstep(1.505, 1.518, vPoloBind.y)) *
                               smoothstep(0.030, 0.060, vPoloBind.z);
          float placketSeam = smoothstep(0.009, 0.012, abs(vPoloBind.x)) * chestPlacket;
          poloCol = mix(poloCol, poloCol * 0.85, collarBand * 0.65);
          poloCol = mix(poloCol, poloCol * 0.84, chestPlacket * 0.55 + placketSeam * 0.35);

          // 2 pearlescent golf polo buttons along chest placket
          for (int bi = 0; bi < 2; bi++) {
            float by = bi == 0 ? 1.468 : 1.416;
            float bd = length(vec2(vPoloBind.x, (vPoloBind.y - by) * 1.1));
            float btn = (1.0 - smoothstep(0.0042, 0.0058, bd)) * smoothstep(0.030, 0.060, vPoloBind.z);
            poloCol = mix(poloCol, vec3(0.92, 0.91, 0.87), btn * 0.92);
          }

          diffuseColor.rgb = poloCol;`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          #ifdef USE_NORMALMAP_TANGENTSPACE
            vec3 wN = texture2D(uFabricNorm, vPoloUv * 12.0).xyz * 2.0 - 1.0;
            normal = normalize(normal + (tbn * vec3(wN.xy * 0.62, 0.0)));
          #endif`
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
           float poloRim = pow(1.0 - clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0), 3.4);
           reflectedLight.indirectSpecular += vec3(0.42, 0.56, 0.72) * poloRim * 0.22;`
        );
    };
  }

  private applyTailoredChinosShader(
    mat: THREE.MeshPhysicalMaterial,
    trouserTex: THREE.Texture | null,
    fabricNorm: THREE.Texture
  ): void {
    mat.customProgramCacheKey = () => 'tailored-chinos-hd-v2';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uChinoDetail = { value: trouserTex };
      shader.uniforms.uFabricNorm = { value: fabricNorm };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vChinoUv;\nvarying vec3 vChinoBind;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvChinoUv = uv;\nvChinoBind = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\nuniform sampler2D uChinoDetail;\nuniform sampler2D uFabricNorm;\nvarying vec2 vChinoUv;\nvarying vec3 vChinoBind;`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          // Keep only subtle 20% macro crease shading from baked map to erase blurry thigh blotches completely
          float foldLuma = clamp(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)), 0.55, 1.08);
          vec3 chino = texture2D(uChinoDetail, vChinoUv * 9.0).rgb;
          diffuseColor.rgb = chino * mix(1.0, foldLuma, 0.22);`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          #ifdef USE_NORMALMAP_TANGENTSPACE
            vec3 cN = texture2D(uFabricNorm, vChinoUv * 13.0).xyz * 2.0 - 1.0;
            normal = normalize(normal + (tbn * vec3(cN.xy * 0.58, 0.0)));
          #endif`
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
           // Subtle sunlit green grass bounce onto lower trouser cuffs
           float cuffTurf = smoothstep(0.55, 0.08, vChinoBind.y);
           reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.065, 0.135, 0.038) * cuffTurf;
           float chinoRim = pow(1.0 - clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0), 3.4);
           reflectedLight.indirectSpecular += vec3(0.42, 0.56, 0.72) * chinoRim * 0.18;`
        );
    };
  }

  /**
   * Uses `skinIndex` / `skinWeight` vertex attributes on `Skin_tee` to render the lead (left) hand
   * in realistic warm pearl-ivory Cabretta leather golf glove material, clean forearm skin without
   * low-res tattoo smudge, and 512px dermal pore micro-detail.
   */
  private applyCabrettaGloveShader(
    skinnedMesh: THREE.SkinnedMesh,
    mat: THREE.MeshPhysicalMaterial,
    poreMap: THREE.Texture,
    leatherMap: THREE.Texture
  ): void {
    const geom = skinnedMesh.geometry;
    const skinIndex = geom.attributes.skinIndex;
    const skinWeight = geom.attributes.skinWeight;
    if (!skinIndex || !skinWeight || !skinnedMesh.skeleton) return;

    const gloveBoneIndices = new Set<number>();
    skinnedMesh.skeleton.bones.forEach((b, idx) => {
      if (b.name.includes('LeftHand')) {
        gloveBoneIndices.add(idx);
      }
    });
    if (gloveBoneIndices.size === 0) return;

    const count = geom.attributes.position.count;
    const gloveMask = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let wSum = 0;
      const idx4 = [skinIndex.getX(i), skinIndex.getY(i), skinIndex.getZ(i), skinIndex.getW(i)];
      const w4 = [skinWeight.getX(i), skinWeight.getY(i), skinWeight.getZ(i), skinWeight.getW(i)];
      for (let k = 0; k < 4; k++) {
        if (gloveBoneIndices.has(idx4[k])) wSum += w4[k];
      }
      gloveMask[i] = THREE.MathUtils.smoothstep(wSum, 0.28, 0.56);
    }
    geom.setAttribute('aGloveMask', new THREE.BufferAttribute(gloveMask, 1));

    mat.customProgramCacheKey = () => 'cabretta-glove-hd-v7';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uDermalNorm = { value: poreMap };
      shader.uniforms.uLeatherNorm = { value: leatherMap };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>\nattribute float aGloveMask;\nvarying float vGloveMask;\nvarying vec2 vSkinUv;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\nvGloveMask = aGloveMask;\nvSkinUv = uv;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\nuniform sampler2D uDermalNorm;\nuniform sampler2D uLeatherNorm;\nvarying float vGloveMask;\nvarying vec2 vSkinUv;`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          // Smoothly blend out blurry forearm tattoo smudge (u=[0.088..0.132], v=[0.732..0.836]) using neighboring skin
          float tatU = smoothstep(0.084, 0.094, vSkinUv.x) * (1.0 - smoothstep(0.124, 0.134, vSkinUv.x));
          float tatV = smoothstep(0.728, 0.740, vSkinUv.y) * (1.0 - smoothstep(0.826, 0.838, vSkinUv.y));
          float tatMask = tatU * tatV;
          if (tatMask > 0.001) {
            vec3 cleanSkin = texture2D(map, vSkinUv + vec2(0.038, 0.0)).rgb;
            diffuseColor.rgb = mix(diffuseColor.rgb, cleanSkin, tatMask);
          }
          // Crisp pearl-ivory Cabretta leather glove + micro-perforation + clean navy cuff trim (no muddy wrist bleed)
          float gloveAlpha = smoothstep(0.36, 0.54, vGloveMask);
          float handCrease = clamp(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)) * 1.42, 0.68, 1.04);
          vec2 perfGrid = fract(vSkinUv * 195.0) - 0.5;
          float perfDot = 1.0 - smoothstep(0.13, 0.22, length(perfGrid));
          vec3 cabretta = vec3(0.92, 0.91, 0.88) * handCrease * (1.0 - perfDot * 0.05 * smoothstep(0.65, 0.95, gloveAlpha));
          float wristTrim = smoothstep(0.16, 0.30, vGloveMask) * smoothstep(0.50, 0.36, vGloveMask);
          float cuffEdge = smoothstep(0.30, 0.40, vGloveMask) * smoothstep(0.48, 0.40, vGloveMask);
          cabretta = mix(cabretta, vec3(0.11, 0.19, 0.32), wristTrim * 0.88);
          cabretta = mix(cabretta, vec3(0.94, 0.93, 0.90), cuffEdge * 0.40);
          diffuseColor.rgb = mix(diffuseColor.rgb, cabretta, max(gloveAlpha, wristTrim * 0.85));`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          #ifdef USE_NORMALMAP_TANGENTSPACE
            vec3 skN = texture2D(uDermalNorm, vSkinUv * 28.0).xyz * 2.0 - 1.0;
            vec3 glN = texture2D(uLeatherNorm, vSkinUv * 18.0).xyz * 2.0 - 1.0;
            vec3 microN = mix(skN * 0.34, glN * 0.42, vGloveMask);
            normal = normalize(normal + (tbn * vec3(microN.xy, 0.0)));
          #endif`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(clamp(roughnessFactor, 0.38, 0.56), 0.40, vGloveMask);`
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
           float NdotV_hand = clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0);
           float handWrap = pow(1.0 - NdotV_hand, 1.55) * 0.45 + 0.55;
           reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.20, 0.052, 0.022) * handWrap * (1.0 - vGloveMask);
           float gloveRim = pow(1.0 - NdotV_hand, 3.6);
           reflectedLight.indirectSpecular += vec3(0.44, 0.58, 0.74) * gloveRim * 0.19;`
        );
    };
  }

  private findBone(sceneRoot: THREE.Object3D, canonicalName: string): THREE.Object3D | undefined {
    // THREE.GLTFLoader runs PropertyBinding.sanitizeNodeName(), stripping ':' from 'mixamorig:Hips' -> 'mixamorigHips'.
    return (
      sceneRoot.getObjectByName(canonicalName) ??
      sceneRoot.getObjectByName(canonicalName.replace(':', ''))
    );
  }

  private createEmbroideredCapBadgeTexture(): THREE.CanvasTexture | null {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 160;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#1b3456';
    ctx.fillRect(0, 0, 256, 160);
    // Crisp embroidered white & gold coastal crest + CL monogram
    ctx.strokeStyle = '#f4f2eb';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(128, 76, 54, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    ctx.fillStyle = '#d4b36a';
    ctx.fillRect(58, 92, 140, 6);
    ctx.fillStyle = '#f4f2eb';
    ctx.font = 'bold 58px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText('CL', 128, 78);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = Math.max(4, this.textures?.maxAnisotropy ?? 8);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.extraMaps.push(tex);
    return tex;
  }

  /**
   * Builds a snug, solid-lined 6-panel Tour Golf Cap fitted directly over `Body`/`Hair`
   * skull bounds so there is zero hovering gap and zero hollow backface transparency.
   */
  private attachTourGolfCap(): void {
    if (!this.headBone) return;
    this.headBone.updateMatrixWorld(true);
    const headInvMat = new THREE.Matrix4().copy(this.headBone.matrixWorld).invert();

    const capGroup = new THREE.Group();
    capGroup.name = 'TourGolfCap';
    const capNorm = this.textures?.fabricNormal ?? createTwillWeaveNormalMap();
    if (!this.textures?.fabricNormal) this.extraMaps.push(capNorm);
    const navyCapMat = new THREE.MeshPhysicalMaterial({
      color: 0x162d4b,
      roughness: 0.80,
      sheen: 0.22,
      sheenRoughness: 0.82,
      sheenColor: 0x4b70a1,
      normalMap: capNorm,
      normalScale: new THREE.Vector2(0.55, 0.55),
      side: THREE.DoubleSide,
    });
    this.applyCoastalRimShader(navyCapMat, 0.24, 'cap-rim-v3');
    const sweatbandMat = new THREE.MeshStandardMaterial({
      color: 0x111824,
      roughness: 0.92,
      side: THREE.DoubleSide,
    });
    const badgeTex = this.createEmbroideredCapBadgeTexture();
    const crestMat = new THREE.MeshStandardMaterial({
      color: 0xf4f2eb,
      map: badgeTex ?? null,
      roughness: 0.52,
    });
    const crestWhiteMat = new THREE.MeshStandardMaterial({
      color: 0xf4f2eb,
      roughness: 0.55,
    });

    // Structured 6-panel Tour crown covering skull above y=1.708 cleanly with buckram front panel loft
    // (Body brow reaches X=+0.132 at y=1.71, X=+0.121 at y=1.74, X=+0.111 at y=1.78, |Z|<=0.088)
    const crownGeo = new THREE.SphereGeometry(1.0, 36, 20, 0, Math.PI * 2, 0, Math.PI * 0.53);
    const cPos = crownGeo.attributes.position;
    for (let i = 0; i < cPos.count; i++) {
      let cx = cPos.getX(i);
      let cy = cPos.getY(i);
      let cz = cPos.getZ(i);
      // Fuller structured front buckram profile (+X) so crown never slopes inward into forehead/temple
      if (cx > 0 && cy > 0) {
        const frontLift = Math.pow(cx, 1.3) * 0.095 * (1.0 - cy * 0.55);
        cx += frontLift;
        cy = Math.min(1.0, cy + Math.pow(cx, 1.5) * 0.10 * (1.0 - cy));
      }
      cPos.setXYZ(i, cx * 0.114, cy * 0.114, cz * 0.095);
    }
    crownGeo.computeVertexNormals();
    crownGeo.translate(0.024, 1.712, 0.0);
    crownGeo.applyMatrix4(headInvMat);
    const crown = new THREE.Mesh(crownGeo, navyCapMat);
    crown.castShadow = true;
    crown.receiveShadow = true;
    capGroup.add(crown);

    // Snug dark sweatband lining inside the lower crown rim
    const bandGeo = new THREE.CylinderGeometry(0.97, 0.985, 0.024, 28, 1, true);
    bandGeo.scale(0.110, 1.0, 0.093);
    bandGeo.translate(0.024, 1.720, 0.0);
    bandGeo.applyMatrix4(headInvMat);
    capGroup.add(new THREE.Mesh(bandGeo, sweatbandMat));

    // Top squatchee button seated flush on crown apex
    const btnGeo = new THREE.SphereGeometry(0.0085, 12, 8);
    btnGeo.scale(1, 0.48, 1);
    btnGeo.translate(0.024, 1.826, 0.0);
    btnGeo.applyMatrix4(headInvMat);
    capGroup.add(new THREE.Mesh(btnGeo, crestWhiteMat));

    // Sculpted Tour visor whose inner edge anchors 22mm INSIDE the front crown at y=1.716 (zero forehead skin gap!)
    const buildVisorMesh = (rInner: number, rOuter: number, thick: number, yOffset: number, mat: THREE.Material, castShadow = false) => {
      const segs = 28;
      const halfAng = Math.PI * 0.40;
      const positions: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];
      for (let i = 0; i <= segs; i++) {
        const u = i / segs;
        const ang = -halfAng + u * halfAng * 2;
        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);
        for (let r = 0; r <= 3; r++) {
          const v = r / 3;
          const rad = THREE.MathUtils.lerp(rInner, rOuter, v);
          const bx = cosA * rad;
          const bz = sinA * rad * 0.92;
          // Root (v=0) stays tucked UP inside crown rim (+0.003); tip slopes gently down & curves at edges
          const drop = (v * v) * (-0.022 - 0.014 * Math.pow(Math.abs(u * 2 - 1), 1.6));
          positions.push(bx, yOffset + drop + thick * 0.5, bz);
          uvs.push(u, v);
          positions.push(bx, yOffset + drop - thick * 0.5, bz);
          uvs.push(u, v);
        }
      }
      const stride = 8; // 4 radial steps * 2 (top/bottom)
      for (let i = 0; i < segs; i++) {
        for (let r = 0; r < 3; r++) {
          const t00 = i * stride + r * 2;
          const t10 = (i + 1) * stride + r * 2;
          const t01 = t00 + 2;
          const t11 = t10 + 2;
          // Top face
          indices.push(t00, t10, t01, t10, t11, t01);
          // Bottom face
          indices.push(t00 + 1, t01 + 1, t10 + 1, t10 + 1, t01 + 1, t11 + 1);
        }
        // Front outer edge stitch
        const f0 = i * stride + 6;
        const f1 = (i + 1) * stride + 6;
        indices.push(f0, f1, f0 + 1, f1, f1 + 1, f0 + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setIndex(indices);
      g.computeVertexNormals();
      g.translate(0.032, 1.714, 0.0);
      g.applyMatrix4(headInvMat);
      const m = new THREE.Mesh(g, mat);
      m.castShadow = castShadow;
      return m;
    };

    capGroup.add(buildVisorMesh(0.072, 0.168, 0.0045, 0.0, navyCapMat, true));
    capGroup.add(buildVisorMesh(0.074, 0.166, 0.0022, -0.0024, new THREE.MeshStandardMaterial({ color: 0x161a22, roughness: 0.92, side: THREE.DoubleSide })));

    // Crisp white sandwich trim along outer visor rim
    capGroup.add(buildVisorMesh(0.164, 0.1695, 0.0022, -0.0012, crestWhiteMat));

    // Curved embroidered CL Tour crest contoured flush onto front cap panel
    const crestGeo = new THREE.CylinderGeometry(0.119, 0.121, 0.022, 12, 1, true, -0.17, 0.34);
    crestGeo.rotateY(Math.PI / 2);
    crestGeo.scale(1.0, 1.0, 0.92);
    crestGeo.rotateZ(-0.20);
    crestGeo.translate(0.026, 1.748, 0.0);
    crestGeo.applyMatrix4(headInvMat);
    capGroup.add(new THREE.Mesh(crestGeo, crestMat));

    this.headBone.add(capGroup);
  }

  /**
   * Mounts the Coastal GPS Golf Watch as a true `SkinnedMesh` sharing `Skin_tee.skeleton` and
   * interpolated forearm/wrist bone weights at the exact wrist skin cross-section so it hugs
   * the wrist flush (`0 mm` floating gap) in every walk, address, and swing pose.
   */
  private attachRightWristWatch(sceneRoot: THREE.Object3D): void {
    if (!this.rightForeArmBone || !this.rightHandBone) return;
    this.rightForeArmBone.updateMatrixWorld(true);
    this.rightHandBone.updateMatrixWorld(true);

    const skinMesh = sceneRoot.getObjectByName('Skin_tee') as THREE.SkinnedMesh | undefined;
    if (!skinMesh?.geometry?.attributes?.position || !skinMesh.skeleton) return;
    skinMesh.updateMatrixWorld(true);

    const pFore = this.rightForeArmBone.getWorldPosition(new THREE.Vector3());
    const pHand = this.rightHandBone.getWorldPosition(new THREE.Vector3());
    const foreDir = pHand.clone().sub(pFore).normalize();
    const boneWatchCenter = pHand.clone().addScaledVector(foreDir, -0.022);

    const handWorldQ = this.rightHandBone.getWorldQuaternion(new THREE.Quaternion());
    // Dorsal back-of-wrist (-Y) angled slightly (+24°) toward radial thumb edge (+Z) so dial faces naturally upward
    const backDir = new THREE.Vector3(0, -1, 0).applyQuaternion(handWorldQ);
    const thumbDir = new THREE.Vector3(0, 0, 1).applyQuaternion(handWorldQ);
    const dorsal = backDir.clone().addScaledVector(thumbDir, 0.42);
    dorsal.addScaledVector(foreDir, -dorsal.dot(foreDir)).normalize();
    const lateral = new THREE.Vector3().crossVectors(foreDir, dorsal).normalize();

    const posAttr = skinMesh.geometry.attributes.position;
    const idxAttr = skinMesh.geometry.attributes.skinIndex;
    const wAttr = skinMesh.geometry.attributes.skinWeight;
    const rForeIdx = skinMesh.skeleton.bones.findIndex((b) => b.name.includes('RightForeArm'));
    const rHandIdx = skinMesh.skeleton.bones.findIndex((b) => b.name === 'mixamorigRightHand');

    // Gather ONLY true wrist/forearm vertices (`wFore + wHand > 0.7`) to prevent hand/thumb vertices bloating the band
    const wristSamples: Array<{
      pos: THREE.Vector3;
      idx: [number, number, number, number];
      w: [number, number, number, number];
    }> = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      const idxs: [number, number, number, number] = [
        idxAttr.getX(i),
        idxAttr.getY(i),
        idxAttr.getZ(i),
        idxAttr.getW(i),
      ];
      const ws: [number, number, number, number] = [
        wAttr.getX(i),
        wAttr.getY(i),
        wAttr.getZ(i),
        wAttr.getW(i),
      ];
      let wWrist = 0;
      for (let k = 0; k < 4; k++) {
        if (idxs[k] === rForeIdx || idxs[k] === rHandIdx) wWrist += ws[k];
      }
      if (wWrist < 0.7) continue;
      v.fromBufferAttribute(posAttr, i).applyMatrix4(skinMesh.matrixWorld);
      const rel = v.clone().sub(boneWatchCenter);
      const along = rel.dot(foreDir);
      if (along > -0.008 && along < 0.008 && rel.length() < 0.038) {
        wristSamples.push({ pos: v.clone(), idx: idxs, w: ws });
      }
    }

    const wristCenter = boneWatchCenter.clone();
    const contour: Array<{ theta: number; r: number }> = [];
    if (wristSamples.length >= 6) {
      const centroid = new THREE.Vector3();
      for (const s of wristSamples) centroid.add(s.pos);
      centroid.divideScalar(wristSamples.length);
      const shift = centroid.clone().sub(boneWatchCenter);
      shift.addScaledVector(foreDir, -shift.dot(foreDir));
      wristCenter.copy(boneWatchCenter).add(shift);

      for (const s of wristSamples) {
        const r = s.pos.clone().sub(wristCenter);
        r.addScaledVector(foreDir, -r.dot(foreDir));
        contour.push({
          theta: Math.atan2(r.dot(dorsal), r.dot(lateral)),
          r: r.length(),
        });
      }
      contour.sort((a, b) => a.theta - b.theta);
    }

    const evalSkinRadiusAt = (theta: number): number => {
      if (contour.length === 0) return 0.024;
      const n = contour.length;
      for (let i = 0; i < n; i++) {
        const a = contour[i];
        const b = contour[(i + 1) % n];
        const aT = a.theta;
        let bT = b.theta;
        let t = theta;
        if (i === n - 1) {
          bT += Math.PI * 2;
          if (t < aT) t += Math.PI * 2;
        }
        if (t >= aT && t <= bT) {
          const span = Math.max(1e-4, bT - aT);
          return THREE.MathUtils.lerp(a.r, b.r, (t - aT) / span);
        }
      }
      return contour[0].r;
    };

    const radDorsal = evalSkinRadiusAt(Math.PI / 2) + 0.0016;
    const skinInv = new THREE.Matrix4().copy(skinMesh.matrixWorld).invert();
    const watchWorldM = new THREE.Matrix4().makeBasis(lateral, foreDir, dorsal).setPosition(wristCenter);
    const watchToSkinLocal = new THREE.Matrix4().multiplyMatrices(skinInv, watchWorldM);

    const bindGeoWithWristWeights = (geo: THREE.BufferGeometry): THREE.BufferGeometry => {
      const gPos = geo.attributes.position;
      const skinIndices = new Uint16Array(gPos.count * 4);
      const skinWeights = new Float32Array(gPos.count * 4);
      const pWorld = new THREE.Vector3();
      for (let i = 0; i < gPos.count; i++) {
        pWorld.fromBufferAttribute(gPos, i).applyMatrix4(skinMesh.matrixWorld);
        if (wristSamples.length > 0) {
          // Smooth inverse-distance blend across the 3 nearest wrist skin vertices (prevents 1-vertex crease jumps)
          const nearest = wristSamples
            .map((s) => ({ s, d2: pWorld.distanceToSquared(s.pos) }))
            .sort((a, b) => a.d2 - b.d2)
            .slice(0, 3);
          const boneAccum = new Map<number, number>();
          let totalInv = 0;
          for (const item of nearest) {
            const inv = 1.0 / (Math.sqrt(item.d2) + 0.002);
            totalInv += inv;
            for (let k = 0; k < 4; k++) {
              const bw = item.s.w[k] * inv;
              if (bw > 0) {
                boneAccum.set(item.s.idx[k], (boneAccum.get(item.s.idx[k]) ?? 0) + bw);
              }
            }
          }
          const top4 = [...boneAccum.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4);
          const sumW = top4.reduce((acc, [, w]) => acc + w, 0) || totalInv || 1;
          for (let k = 0; k < 4; k++) {
            skinIndices[i * 4 + k] = top4[k]?.[0] ?? 0;
            skinWeights[i * 4 + k] = top4[k] ? top4[k][1] / sumW : 0;
          }
        } else {
          skinIndices[i * 4 + 0] = Math.max(0, rForeIdx);
          skinIndices[i * 4 + 1] = Math.max(0, rHandIdx);
          skinWeights[i * 4 + 0] = 0.72;
          skinWeights[i * 4 + 1] = 0.28;
        }
      }
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
      return geo;
    };

    const makeSkinnedPart = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean) => {
      geo.applyMatrix4(watchToSkinLocal);
      bindGeoWithWristWeights(geo);
      const sm = new THREE.SkinnedMesh(geo, mat);
      sm.castShadow = shadow;
      sm.frustumCulled = false;
      sm.bind(skinMesh.skeleton, skinMesh.bindMatrix);
      return sm;
    };

    const watchGroup = new THREE.Group();
    watchGroup.name = 'TourGPSWatch';
    const strapMat = new THREE.MeshStandardMaterial({
      color: 0x1a2028,
      roughness: 0.72,
      metalness: 0.08,
      side: THREE.DoubleSide,
    });
    const bezelMat = new THREE.MeshStandardMaterial({ color: 0x9aa4b0, roughness: 0.24, metalness: 0.88 });
    const dialMat = new THREE.MeshPhysicalMaterial({ color: 0x0d151d, roughness: 0.08, clearcoat: 0.9 });

    // Open-ended slim strap band conformed directly to the measured wrist skin contour r(theta) + 1.4mm
    const strapGeo = new THREE.CylinderGeometry(1.0, 1.0, 0.012, 28, 1, true);
    const sPos = strapGeo.attributes.position;
    for (let i = 0; i < sPos.count; i++) {
      const sx = sPos.getX(i);
      const sz = sPos.getZ(i);
      const rNorm = Math.hypot(sx, sz);
      if (rNorm > 0.05) {
        const theta = Math.atan2(sz, sx);
        const targetR = evalSkinRadiusAt(theta) + 0.0014;
        sPos.setX(i, (sx / rNorm) * targetR);
        sPos.setZ(i, (sz / rNorm) * targetR);
      }
    }
    strapGeo.computeVertexNormals();
    watchGroup.add(makeSkinnedPart(strapGeo, strapMat, true));

    const bezelGeo = new THREE.CylinderGeometry(0.013, 0.0135, 0.0036, 18);
    bezelGeo.rotateX(Math.PI / 2);
    bezelGeo.translate(0, 0, radDorsal + 0.0010);
    watchGroup.add(makeSkinnedPart(bezelGeo, bezelMat, true));

    const dialGeo = new THREE.CylinderGeometry(0.0108, 0.0108, 0.0016, 18);
    dialGeo.rotateX(Math.PI / 2);
    dialGeo.translate(0, 0, radDorsal + 0.0024);
    watchGroup.add(makeSkinnedPart(dialGeo, dialMat, false));

    (skinMesh.parent ?? sceneRoot).add(watchGroup);
  }

  private captureRestSkeleton(sceneRoot: THREE.Object3D): void {
    this.bones.clear();
    this.allBones = [];

    // Specify which local bone axis serves as the anatomical twist reference:
    // '+Y' = kneecap front / instep top / outer elbow tricep; '-Z'/'+Z' = left/right thumb edge.
    type TwistSource = 'world_x' | 'local_y' | 'local_neg_z' | 'local_pos_z';
    const bonePairs: Array<[string, string | null, TwistSource]> = [
      ['mixamorig:Hips', 'mixamorig:Spine', 'world_x'],
      ['mixamorig:Spine', 'mixamorig:Spine1', 'world_x'],
      ['mixamorig:Spine1', 'mixamorig:Spine2', 'world_x'],
      ['mixamorig:Spine2', 'mixamorig:Neck', 'world_x'],
      ['mixamorig:Neck', 'mixamorig:Head', 'world_x'],
      ['mixamorig:Head', null, 'world_x'],
      ['mixamorig:LeftShoulder', 'mixamorig:LeftArm', 'local_y'],
      ['mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'local_y'],
      ['mixamorig:LeftForeArm', 'mixamorig:LeftHand', 'local_y'],
      ['mixamorig:LeftHand', 'mixamorig:LeftHandMiddle1', 'local_y'],
      ['mixamorig:RightShoulder', 'mixamorig:RightArm', 'local_y'],
      ['mixamorig:RightArm', 'mixamorig:RightForeArm', 'local_y'],
      ['mixamorig:RightForeArm', 'mixamorig:RightHand', 'local_y'],
      ['mixamorig:RightHand', 'mixamorig:RightHandMiddle1', 'local_y'],
      ['mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'local_y'],
      ['mixamorig:LeftLeg', 'mixamorig:LeftFoot', 'local_y'],
      ['mixamorig:LeftFoot', 'mixamorig:LeftToeBase', 'local_y'],
      ['mixamorig:LeftToeBase', null, 'local_y'],
      ['mixamorig:RightUpLeg', 'mixamorig:RightLeg', 'local_y'],
      ['mixamorig:RightLeg', 'mixamorig:RightFoot', 'local_y'],
      ['mixamorig:RightFoot', 'mixamorig:RightToeBase', 'local_y'],
      ['mixamorig:RightToeBase', null, 'local_y'],
    ];

    for (const side of ['Left', 'Right'] as const) {
      for (const finger of FINGER_NAMES) {
        for (let seg = 1; seg <= 3; seg++) {
          const name = `mixamorig:${side}Hand${finger}${seg}`;
          const child = seg < 3 ? `mixamorig:${side}Hand${finger}${seg + 1}` : null;
          bonePairs.push([name, child, 'local_y']);
        }
      }
    }

    for (const [name, childName, twistSrc] of bonePairs) {
      const bone = this.findBone(sceneRoot, name);
      if (!bone) continue;
      const wp = new THREE.Vector3();
      const wq = new THREE.Quaternion();
      bone.getWorldPosition(wp);
      bone.getWorldQuaternion(wq);

      const dir = new THREE.Vector3(0, 1, 0);
      let len = 0.08;
      if (childName) {
        const child = this.findBone(sceneRoot, childName);
        if (child) {
          const cp = new THREE.Vector3();
          child.getWorldPosition(cp);
          const diff = cp.sub(wp);
          len = Math.max(0.01, diff.length());
          dir.copy(diff).divideScalar(len);
        }
      }

      const restTwistRefWorld =
        twistSrc === 'local_y'
          ? new THREE.Vector3(0, 1, 0).applyQuaternion(wq).normalize()
          : twistSrc === 'local_neg_z'
            ? new THREE.Vector3(0, 0, -1).applyQuaternion(wq).normalize()
            : twistSrc === 'local_pos_z'
              ? new THREE.Vector3(0, 0, 1).applyQuaternion(wq).normalize()
              : new THREE.Vector3(1, 0, 0);

      const state: BoneRestState = {
        bone,
        restLocalPos: bone.position.clone(),
        restLocalQuat: bone.quaternion.clone(),
        restWorldPos: wp,
        restWorldQuat: wq,
        restDirWorld: dir,
        restTwistRefWorld,
        length: len,
      };
      this.bones.set(name, state);
      this.allBones.push(state);
    }

    this.headBone = this.findBone(sceneRoot, 'mixamorig:Head') ?? null;
    this.rightForeArmBone = this.findBone(sceneRoot, 'mixamorig:RightForeArm') ?? null;
    this.rightHandBone = this.findBone(sceneRoot, 'mixamorig:RightHand') ?? null;
    this.leftEyeBone = this.findBone(sceneRoot, 'mixamorig:LeftEye') ?? null;
    this.rightEyeBone = this.findBone(sceneRoot, 'mixamorig:RightEye') ?? null;
    if (this.leftEyeBone) this.leftEyeRestQ.copy(this.leftEyeBone.quaternion);
    if (this.rightEyeBone) this.rightEyeRestQ.copy(this.rightEyeBone.quaternion);
  }

  /**
   * Rest-pose-invariant bone aimer in `this.root` local space: rotates `bone` so its rest
   * direction aligns with `targetDirInRoot`, with optional twist aligned toward `twistInRoot`.
   */
  private aimBone(
    name: string,
    targetDirInRoot: THREE.Vector3,
    twistInRoot?: THREE.Vector3
  ): void {
    const st = this.bones.get(name);
    if (!st || !st.bone.parent) return;

    const dirN = targetDirInRoot.clone().normalize();
    const qAlign = new THREE.Quaternion().setFromUnitVectors(st.restDirWorld, dirN);
    let desiredRootQ = qAlign.clone().multiply(st.restWorldQuat);

    if (twistInRoot) {
      const curRef = st.restTwistRefWorld.clone().applyQuaternion(qAlign);
      const curProj = curRef.sub(dirN.clone().multiplyScalar(curRef.dot(dirN)));
      const tgtProj = twistInRoot.clone().sub(dirN.clone().multiplyScalar(twistInRoot.dot(dirN)));
      if (curProj.lengthSq() > 1e-5 && tgtProj.lengthSq() > 1e-5) {
        curProj.normalize();
        tgtProj.normalize();
        const dot = THREE.MathUtils.clamp(curProj.dot(tgtProj), -1, 1);
        const cross = new THREE.Vector3().crossVectors(curProj, tgtProj);
        const angle = Math.atan2(cross.dot(dirN), dot);
        const qTwist = new THREE.Quaternion().setFromAxisAngle(dirN, angle);
        desiredRootQ = qTwist.multiply(desiredRootQ);
      }
    }

    const rootWorldQ = this.root.getWorldQuaternion(new THREE.Quaternion());
    const desiredWorldQ = rootWorldQ.multiply(desiredRootQ);

    st.bone.parent.updateWorldMatrix(true, false);
    const parentWorldQ = st.bone.parent.getWorldQuaternion(new THREE.Quaternion());
    st.bone.quaternion.copy(parentWorldQ.invert().multiply(desiredWorldQ));
    st.bone.updateMatrixWorld(true);
  }

  /**
   * Applies an incremental `this.root`-local rotation `rootDeltaQ` on top of the bone's rest orientation.
   */
  private rotateBoneFromRest(name: string, rootDeltaQ: THREE.Quaternion): void {
    const st = this.bones.get(name);
    if (!st || !st.bone.parent) return;
    const rootWorldQ = this.root.getWorldQuaternion(new THREE.Quaternion());
    const desiredWorldQ = rootWorldQ.multiply(rootDeltaQ).multiply(st.restWorldQuat);
    st.bone.parent.updateWorldMatrix(true, false);
    const parentWorldQ = st.bone.parent.getWorldQuaternion(new THREE.Quaternion());
    st.bone.quaternion.copy(parentWorldQ.invert().multiply(desiredWorldQ));
    st.bone.updateMatrixWorld(true);
  }

  private getShaftLength(category: ClubCategory): number {
    return category === 'wood' ? 1.15 : category === 'hybrid' ? 1.07 : category === 'putter' ? 0.91 : 1.00;
  }

  public setClubModel(category: ClubCategory, loftDeg: number): void {
    this.fallbackRig.setClubModel(category, loftDeg);
    if (this.activeClubGroup && this.currentClubCategory === category && Math.abs(this.currentClubLoft - loftDeg) < 0.1) return;
    this.currentClubCategory = category;
    this.currentClubLoft = loftDeg;

    if (this.activeClubGroup) {
      this.clubMount.remove(this.activeClubGroup);
      this.activeClubGroup.traverse((o) => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
        if ((o as THREE.Mesh).material) ((o as THREE.Mesh).material as THREE.Material).dispose();
      });
    }

    const club = new THREE.Group();
    const gripMat = new THREE.MeshStandardMaterial({
      color: 0x181c22,
      normalMap: this.textures?.leatherNormal ?? null,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughness: 0.84,
      metalness: 0.04,
    });
    const gripCapMat = new THREE.MeshStandardMaterial({ color: 0xd0d6de, roughness: 0.42, metalness: 0.4 });
    const gripAccentRed = new THREE.MeshStandardMaterial({ color: 0x9b2c2c, roughness: 0.52 });
    const shaftMat = new THREE.MeshStandardMaterial({
      color: category === 'wood' || category === 'hybrid' ? 0x1f252e : 0xdbe2ea,
      metalness: category === 'wood' || category === 'hybrid' ? 0.48 : 0.94,
      roughness: category === 'wood' || category === 'hybrid' ? 0.30 : 0.14,
    });
    const chromeMat = new THREE.MeshPhysicalMaterial({
      color: 0xe4eaf0,
      metalness: 0.94,
      roughness: 0.15,
      clearcoat: 0.3,
    });
    const faceMat = new THREE.MeshStandardMaterial({
      color: 0xc2cbd4,
      metalness: 0.84,
      roughness: 0.32,
    });
    const carbonMat = new THREE.MeshPhysicalMaterial({
      map: this.textures?.carbonWeaveMap ?? null,
      color: 0x1f2630,
      metalness: 0.38,
      roughness: 0.18,
      clearcoat: 0.92,
      clearcoatRoughness: 0.10,
    });
    const whiteAccentMat = new THREE.MeshStandardMaterial({ color: 0xf6f6f2, roughness: 0.45 });
    const goldWeightMat = new THREE.MeshStandardMaterial({ color: 0xc9a349, metalness: 0.88, roughness: 0.24 });

    const shaftLen = this.getShaftLength(category);

    // Tapered Tour Pride golf grip + white end-cap + grip collar
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.0145, 0.0112, 0.27, 14), gripMat);
    grip.position.y = -0.055;
    club.add(grip);

    const buttCap = new THREE.Mesh(new THREE.SphereGeometry(0.0146, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), gripCapMat);
    buttCap.scale.y = 0.45;
    buttCap.position.y = 0.080;
    club.add(buttCap);

    const buttTrim = new THREE.Mesh(new THREE.CylinderGeometry(0.0147, 0.0147, 0.005, 14), gripAccentRed);
    buttTrim.position.y = 0.074;
    club.add(buttTrim);

    const gripBand = new THREE.Mesh(new THREE.CylinderGeometry(0.0116, 0.0116, 0.008, 12), whiteAccentMat);
    gripBand.position.y = -0.186;
    club.add(gripBand);

    // Tapered stepless steel / graphite shaft
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0062, 0.0046, shaftLen - 0.16, 12),
      shaftMat
    );
    shaft.position.y = -0.18 - (shaftLen - 0.16) * 0.5;
    shaft.castShadow = true;
    club.add(shaft);

    // Hosel & double-striped pro ferrule
    const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.0064, 0.0072, 0.028, 12), gripMat);
    ferrule.position.y = -shaftLen + 0.022;
    club.add(ferrule);
    const ferruleRing = new THREE.Mesh(new THREE.CylinderGeometry(0.0070, 0.0070, 0.004, 12), whiteAccentMat);
    ferruleRing.position.y = -shaftLen + 0.012;
    club.add(ferruleRing);

    if (category === 'wood' || category === 'hybrid') {
      const s = category === 'wood' ? 1.0 : 0.72;
      // Sculpted aerodynamic teardrop carbon crown + titanium sole
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.056 * s, 24, 16), carbonMat);
      head.scale.set(1.22, 0.52, 1.08);
      head.position.set(0.036 * s, -shaftLen - 0.004, 0.022 * s);
      head.castShadow = true;
      club.add(head);

      const solePlate = new THREE.Mesh(new THREE.SphereGeometry(0.052 * s, 18, 10, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), chromeMat);
      solePlate.scale.set(1.18, 0.46, 1.02);
      solePlate.position.set(0.036 * s, -shaftLen - 0.005, 0.022 * s);
      club.add(solePlate);

      const weightPlug = new THREE.Mesh(new THREE.CylinderGeometry(0.009 * s, 0.009 * s, 0.008, 12), goldWeightMat);
      weightPlug.position.set(0.044 * s, -shaftLen - 0.025 * s, 0.046 * s);
      club.add(weightPlug);

      // Milled titanium clubface + alignment crown sight-dot
      const face = new THREE.Mesh(new THREE.BoxGeometry(0.092 * s, 0.045 * s, 0.011), faceMat);
      face.position.set(0.036 * s, -shaftLen - 0.002, -0.031 * s);
      face.rotation.x = THREE.MathUtils.degToRad(loftDeg * 0.55);
      club.add(face);

      const alignDot = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.002, 10), whiteAccentMat);
      alignDot.position.set(0.036 * s, -shaftLen + 0.024 * s, -0.016 * s);
      club.add(alignDot);
    } else if (category === 'putter') {
      // Sculpted CNC-milled Anser blade putter with plumber's neck & white sightline
      const neck = new THREE.Mesh(new THREE.BoxGeometry(0.010, 0.024, 0.010), chromeMat);
      neck.position.set(0.002, -shaftLen + 0.002, 0.0);
      club.add(neck);

      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.104, 0.022, 0.027), chromeMat);
      blade.position.set(0.042, -shaftLen - 0.012, 0.004);
      blade.castShadow = true;
      club.add(blade);

      const insert = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.017, 0.004), faceMat);
      insert.position.set(0.042, -shaftLen - 0.012, -0.009);
      club.add(insert);

      const sightline = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.002, 0.016), whiteAccentMat);
      sightline.position.set(0.042, -shaftLen - 0.0005, 0.008);
      club.add(sightline);
    } else {
      // Forged cavity-back Tour iron / wedge with extruded silhouette & milled face grooves
      const ironShape = new THREE.Shape();
      ironShape.moveTo(0.0, 0.0);
      ironShape.lineTo(0.078, -0.004);
      ironShape.quadraticCurveTo(0.088, 0.015, 0.080, 0.046);
      ironShape.lineTo(0.012, 0.032);
      ironShape.lineTo(-0.004, 0.010);
      ironShape.closePath();

      const bladeGeo = new THREE.ExtrudeGeometry(ironShape, {
        depth: 0.011,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.002,
        bevelThickness: 0.002,
      });
      bladeGeo.translate(-0.004, -0.022, -0.0055);
      const blade = new THREE.Mesh(bladeGeo, chromeMat);
      blade.position.set(0.004, -shaftLen - 0.005, 0.002);
      blade.rotation.x = THREE.MathUtils.degToRad(loftDeg * 0.45);
      blade.castShadow = true;
      club.add(blade);

      const facePad = new THREE.Mesh(new THREE.BoxGeometry(0.064, 0.032, 0.002), faceMat);
      facePad.position.set(0.040, -shaftLen - 0.004, -0.006);
      facePad.rotation.x = THREE.MathUtils.degToRad(loftDeg * 0.45);
      club.add(facePad);
    }

    this.clubMount.add(club);
    this.activeClubGroup = club;
    this.meshVersion++;
  }

  public updatePose(
    ballPos: { x: number; y: number; z: number },
    aimYawRad: number,
    club: ClubSpec,
    visible: boolean,
    animPhase: SwingAnimPhase,
    phaseT: number,
    clubPathDeg: number,
    dt = 0.016,
    groundHeightAt?: (x: number, z: number) => number
  ): void {
    this.lastBallPos = { ...ballPos };
    this.lastAimYaw = aimYawRad;
    this.lastClub = club;
    this.lastVisible = visible;
    this.lastPhase = animPhase;
    this.lastPhaseT = phaseT;
    this.lastClubPath = clubPathDeg;
    if (groundHeightAt) this.lastGroundHeightAt = groundHeightAt;
    const heightFn = groundHeightAt ?? this.lastGroundHeightAt;

    this.root.visible = visible;
    this.setClubModel(club.category, club.loftDeg);

    if (!this.loaded || !this.modelWrapper) {
      if (this.fallbackRig.root.visible) {
        this.fallbackRig.updatePose(ballPos, aimYawRad, club, visible, animPhase, phaseT, clubPathDeg);
      }
      return;
    }

    if (!visible) return;

    this.simTimeS += dt;

    const isPutt = club.category === 'putter';
    const isWood = club.category === 'wood' || club.category === 'hybrid';
    const shaftLen = this.getShaftLength(club.category);

    const standDist = isWood ? 0.88 : club.category === 'hybrid' ? 0.80 : isPutt ? 0.54 : 0.72;
    const ballZOffset = isWood ? -0.08 : isPutt ? -0.04 : 0.0;
    const stanceHalfW = isWood ? 0.24 : isPutt ? 0.165 : 0.195;

    const isWalkIn = animPhase === 'walk_in';
    const smootherstep = (v: number, a: number, b: number) => {
      const x = THREE.MathUtils.clamp((v - a) / (b - a), 0, 1);
      return x * x * x * (x * (x * 6 - 15) + 10);
    };
    const settleU = isWalkIn ? smootherstep(phaseT, 0.34, 0.99) : 1.0;

    // World-locked 3-step Tour stroll straight towards the ball (zero ground slip, continuous pelvis flow!):
    const endX = -standDist;
    const endZ = ballZOffset;
    const walkSpanX = isPutt ? 0.48 : 0.64;
    const walkSpanZ = isPutt ? 0.13 : 0.18;
    const startX = endX - walkSpanX;
    const startZ = endZ + walkSpanZ;
    const pathLen = Math.hypot(walkSpanX, walkSpanZ) || 1;
    const pathDirX = walkSpanX / pathLen;
    const pathDirZ = -walkSpanZ / pathLen;
    const pathRightX = -pathDirZ;
    const pathRightZ = pathDirX;
    const approachYaw = Math.atan2(walkSpanZ, walkSpanX);

    let sL = 1.0;
    let sR = 1.0;
    let liftL = 0.0;
    let liftR = 0.0;
    let pitchL = 0.0;
    let pitchR = 0.0;
    let leadToAddr = isWalkIn ? 0.0 : 1.0;
    let trailToAddr = isWalkIn ? 0.0 : 1.0;
    let armSwingSignal = 0.0;
    let weightShiftRight = 0.0;
    let hipBobY = 0.0;
    let hipRollX = 0.0;
    let sBody = 1.0;

    if (isWalkIn) {
      // Smooth unbroken forward body glide (never stops & restarts between steps)
      sBody = THREE.MathUtils.smoothstep(phaseT, 0.02, 0.90);

      // Overlapping double-support footsteps starting mid-stroll (never rigid parallel-feet freeze at t=0):
      // Step 1 (L): 0.00..0.30 | Step 2 (R): 0.25..0.56 | Step 3 (L->lead): 0.51..0.79 | Step 4 (R->trail): 0.73..0.93
      const u1 = THREE.MathUtils.smoothstep(phaseT, 0.00, 0.30);
      const u2 = THREE.MathUtils.smoothstep(phaseT, 0.25, 0.56);
      const u3 = THREE.MathUtils.smoothstep(phaseT, 0.51, 0.79);
      const u4 = THREE.MathUtils.smoothstep(phaseT, 0.73, 0.93);

      const sLStart = 0.04;
      const sLMid = 0.38;
      const sRStart = -0.08;
      const sRMid = 0.74;
      sL = sLStart + (sLMid - sLStart) * u1 + (1.0 - sLMid) * u3;
      sR = sRStart + (sRMid - sRStart) * u2 + (1.0 - sRMid) * u4;
      leadToAddr = u3;
      trailToAddr = u4;

      // Subtle natural grass-skimming foot clearance (skewed peak early-mid swing, gentle heel-first touch)
      const swingLift = (u: number, maxH: number) => {
        if (u <= 0.001 || u >= 0.999) return 0;
        const skewed = Math.pow(u, 0.85);
        return Math.sin(skewed * Math.PI) * maxH;
      };
      liftL = swingLift(u1, 0.052) + swingLift(u3, 0.046);
      liftR = swingLift(u2, 0.056) + swingLift(u4, 0.030);

      // Natural ankle pitch: push-off plantarflexion -> swing clearance -> slight heel-first landing roll
      const anklePitch = (u: number, amp = 1.0) => {
        if (u <= 0.001 || u >= 0.999) return 0;
        if (u < 0.32) return -Math.sin((u / 0.32) * Math.PI) * 0.24 * amp; // toe push-off
        const su = (u - 0.32) / 0.68;
        return Math.sin(su * Math.PI) * 0.20 * amp; // heel-first approach smoothly flattening at u=1
      };
      pitchL = anklePitch(u1, 1.0) + anklePitch(u3, 0.85);
      pitchR = anklePitch(u2, 1.0) + anklePitch(u4, 0.65);

      // Continuous biomechanical torso counter-swing, inverted-pendulum hip vault & weight transfer
      const p1 = Math.sin(u1 * Math.PI);
      const p2 = Math.sin(u2 * Math.PI);
      const p3 = Math.sin(u3 * Math.PI);
      const p4 = Math.sin(u4 * Math.PI);

      armSwingSignal = -p1 + p2 - p3 * 0.65 + p4 * 0.22;
      weightShiftRight = p1 * 0.025 - p2 * 0.027 + p3 * 0.020 - p4 * 0.012;
      // Inverted-pendulum vault: straight stance knee lifts pelvis gently (~1.4cm) at mid-stance, dips softly at heel-strike
      hipBobY = (p1 + p2 + p3 * 0.85 + p4 * 0.40) * 0.014 - 0.008;
      // Coronal pelvic tilt (unsupported swing hip drops ~3° smoothly)
      hipRollX = (p1 - p2 + p3 * 0.75 - p4 * 0.35) * 0.048;
    }

    const rootAddrX = THREE.MathUtils.lerp(startX, endX, sBody);
    const rootAddrZ = THREE.MathUtils.lerp(startZ, endZ, sBody);
    const walkYawTurn = isWalkIn
      ? approachYaw * (1 - THREE.MathUtils.smoothstep(phaseT, 0.50, 0.86))
      : 0.0;

    const walkFootHalfW = 0.112;
    const lWalkAddrX = THREE.MathUtils.lerp(startX, endX, sL) - pathRightX * walkFootHalfW;
    const lWalkAddrZ = THREE.MathUtils.lerp(startZ, endZ, sL) - pathRightZ * walkFootHalfW;
    const lGoalAddrX = endX - 0.015;
    const lGoalAddrZ = endZ - stanceHalfW;
    const lAddrX = isWalkIn ? THREE.MathUtils.lerp(lWalkAddrX, lGoalAddrX, leadToAddr) : lGoalAddrX;
    const lAddrZ = isWalkIn ? THREE.MathUtils.lerp(lWalkAddrZ, lGoalAddrZ, leadToAddr) : lGoalAddrZ;

    const rWalkAddrX = THREE.MathUtils.lerp(startX, endX, sR) + pathRightX * walkFootHalfW;
    const rWalkAddrZ = THREE.MathUtils.lerp(startZ, endZ, sR) + pathRightZ * walkFootHalfW;
    const rGoalAddrX = endX + 0.010;
    const rGoalAddrZ = endZ + stanceHalfW;
    const rAddrX = isWalkIn ? THREE.MathUtils.lerp(rWalkAddrX, rGoalAddrX, trailToAddr) : rGoalAddrX;
    const rAddrZ = isWalkIn ? THREE.MathUtils.lerp(rWalkAddrZ, rGoalAddrZ, trailToAddr) : rGoalAddrZ;

    const leftX = -Math.cos(aimYawRad);
    const leftZ = -Math.sin(aimYawRad);
    const sinAim = Math.sin(aimYawRad);
    const cosAim = Math.cos(aimYawRad);
    const ballBaseY = ballPos.y - BALL_RADIUS_M;

    const lFootAngle = isWalkIn ? THREE.MathUtils.lerp(0.05, 0.26, leadToAddr) : 0.26;
    const rFootAngleBase = isWalkIn ? THREE.MathUtils.lerp(-0.05, -0.08, trailToAddr) : -0.08;

    const sampleShoeGroundY = (ax: number, az: number, footAngleLocal: number): number => {
      if (!heightFn) return ballBaseY;
      const wx = ballPos.x - leftX * ax - sinAim * az;
      const wz = ballPos.z - leftZ * ax + cosAim * az;
      const worldYaw = aimYawRad - footAngleLocal;
      const fx = Math.cos(worldYaw);
      const fz = Math.sin(worldYaw);
      const sx = -fz;
      const sz = fx;
      const hC = heightFn(wx, wz);
      const hToe = heightFn(wx + fx * 0.185, wz + fz * 0.185);
      const hMidToe = heightFn(wx + fx * 0.11, wz + fz * 0.11);
      const hHeel = heightFn(wx - fx * 0.085, wz - fz * 0.085);
      const hIn = heightFn(wx + fx * 0.055 + sx * 0.055, wz + fz * 0.055 + sz * 0.055);
      const hOut = heightFn(wx + fx * 0.055 - sx * 0.055, wz + fz * 0.055 - sz * 0.055);
      const hMax = Math.max(hC, hToe, hMidToe, hHeel, hIn, hOut);
      return THREE.MathUtils.clamp(hMax, ballBaseY - 0.65, ballBaseY + 0.90);
    };

    const lFootGroundY = sampleShoeGroundY(lAddrX, lAddrZ, lFootAngle);
    const rFootGroundY = sampleShoeGroundY(rAddrX, rAddrZ, rFootAngleBase);
    const highFootY = Math.max(lFootGroundY, rFootGroundY);
    const stanceHeightDiff = Math.abs(lFootGroundY - rFootGroundY);
    const rootGroundY = highFootY - Math.min(0.22, stanceHeightDiff * 0.5);
    const lFootRelY = THREE.MathUtils.clamp(lFootGroundY - rootGroundY, -0.22, 0.22);
    const rFootRelY = THREE.MathUtils.clamp(rFootGroundY - rootGroundY, -0.22, 0.22);
    const ballRelFeetY = THREE.MathUtils.clamp(ballBaseY - rootGroundY, -0.55, 0.40);

    this.root.position.set(
      ballPos.x - leftX * rootAddrX - sinAim * rootAddrZ,
      rootGroundY,
      ballPos.z - leftZ * rootAddrX + cosAim * rootAddrZ
    );
    this.root.rotation.y = -aimYawRad + THREE.MathUtils.degToRad(clubPathDeg * 0.45) + walkYawTurn;

    // ------------------------------------------------------------------
    // 1. PGA TOUR BIOMECHANICS + NATURAL WALK-IN + PRE-SHOT ADDRESS LIFE
    // ------------------------------------------------------------------
    let hipTurnY = 0;
    let chestTurnY = 0;
    let hipSwayZ = 0;
    let trailHeelLift = 0;
    let armSweep = 0;
    let wristCock = 0;
    let faceRoll = 0;
    let headTrackTarget = 0;
    let breathCycle = 0;
    let idleGlance = 0;

    if (animPhase === 'walk_in') {
      const t = this.simTimeS;
      const addrBlend = settleU * settleU;
      const microPoise = Math.sin(t * 2.4) * 0.5 + Math.sin(t * 1.1) * 0.5;
      hipTurnY = armSwingSignal * 0.095;
      chestTurnY = -armSwingSignal * 0.115;
      hipSwayZ = weightShiftRight + Math.sin(t * 0.95) * 0.0045 * addrBlend;
      breathCycle = Math.sin(t * 1.65) * THREE.MathUtils.lerp(0.5, 1.0, addrBlend);
      armSweep = (isPutt ? microPoise * 0.012 : microPoise * 0.018) * addrBlend;
      wristCock = (isPutt ? 0 : Math.sin(t * 2.4 + 0.5) * 0.028) * addrBlend;
    } else if (animPhase === 'address') {
      // Continuous athletic breathing, micro weight settle, subtle club poise, and periodic target glance
      const t = this.simTimeS;
      breathCycle = Math.sin(t * 1.65);
      const microPoise = Math.sin(t * 2.4) * 0.5 + Math.sin(t * 1.1) * 0.5;
      hipSwayZ = Math.sin(t * 0.95) * 0.0045;
      armSweep = isPutt ? microPoise * 0.012 : microPoise * 0.018;
      wristCock = isPutt ? 0 : Math.sin(t * 2.4 + 0.5) * 0.028;

      // Every 9.0s (starting with ball lock first ~4s), glance smoothly toward target (-Z) for ~1.8s, then back to ball
      const glancePeriod = 9.0;
      const gPhase = (t % glancePeriod) / glancePeriod;
      if (gPhase > 0.46 && gPhase < 0.70) {
        const u = (gPhase - 0.46) / 0.24;
        idleGlance = Math.sin(u * Math.PI);
        idleGlance = idleGlance * idleGlance * (3 - 2 * idleGlance);
      }
    } else if (animPhase === 'backswing') {
      const e = THREE.MathUtils.smoothstep(phaseT, 0, 1);
      if (isPutt) {
        armSweep = e * 0.24;
        chestTurnY = -e * 0.10;
      } else {
        hipTurnY = -e * 0.64;
        chestTurnY = -e * 1.44;
        hipSwayZ = e * 0.024;
        armSweep = e * 1.0;
        wristCock = Math.pow(e, 0.78) * 0.96;
        faceRoll = e * 0.42;
      }
    } else if (animPhase === 'downswing') {
      const e = phaseT * phaseT;
      if (isPutt) {
        armSweep = THREE.MathUtils.lerp(0.24, -0.02, e);
        chestTurnY = THREE.MathUtils.lerp(-0.10, 0.02, e);
      } else {
        const hipLead = Math.pow(phaseT, 1.32);
        const lagRelease = THREE.MathUtils.smoothstep(phaseT, 0.56, 1.0);
        hipTurnY = THREE.MathUtils.lerp(-0.64, 0.48, hipLead);
        chestTurnY = THREE.MathUtils.lerp(-1.44, 0.22, e);
        hipSwayZ = THREE.MathUtils.lerp(0.024, -0.065, hipLead);
        trailHeelLift = hipLead * 0.36;
        armSweep = THREE.MathUtils.lerp(1.0, -0.03, e);
        wristCock = THREE.MathUtils.lerp(0.96, 0.04, lagRelease);
        faceRoll = THREE.MathUtils.lerp(0.42, 0.0, lagRelease);
      }
    } else if (animPhase === 'followthrough') {
      const e = 1 - Math.pow(1 - phaseT, 2.2);
      if (isPutt) {
        armSweep = THREE.MathUtils.lerp(-0.02, -0.26, e);
        chestTurnY = THREE.MathUtils.lerp(0.02, 0.14, e);
      } else {
        hipTurnY = THREE.MathUtils.lerp(0.48, 1.28, e);
        chestTurnY = THREE.MathUtils.lerp(0.22, 1.44, e);
        hipSwayZ = THREE.MathUtils.lerp(-0.065, -0.09, e);
        trailHeelLift = THREE.MathUtils.lerp(0.36, 1.0, e);
        armSweep = THREE.MathUtils.lerp(-0.03, -1.0, e);
        wristCock = THREE.MathUtils.lerp(0.04, -1.06, Math.min(1, e * 1.4));
        faceRoll = THREE.MathUtils.lerp(0.0, -0.60, e);
        headTrackTarget = THREE.MathUtils.smoothstep(phaseT, 0.22, 0.82);
      }
    }

    // Reset skeleton cleanly back to rest pose each frame
    for (const s of this.allBones) {
      s.bone.position.copy(s.restLocalPos);
      s.bone.quaternion.copy(s.restLocalQuat);
    }
    this.root.updateMatrixWorld(true);
    const rootInvMat = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const toRootLocal = (worldPos: THREE.Vector3) => worldPos.applyMatrix4(rootInvMat);

    // ------------------------------------------------------------------
    // 2. HIPS & DISTRIBUTED 'ZXY' TILTED GOLF SPINE COIL
    // ------------------------------------------------------------------
    const hipsState = this.bones.get('mixamorig:Hips');
    const lieTiltAdjust = THREE.MathUtils.clamp(-ballRelFeetY * 0.35, -0.08, 0.14);
    const addrSpineTilt = (isPutt ? -0.56 : isWood ? -0.43 : -0.50) - lieTiltAdjust + breathCycle * 0.008;
    const forwardSpineTilt = THREE.MathUtils.lerp(-0.04, addrSpineTilt, settleU);
    const addrSideTilt = isPutt ? -0.015 : -0.085 - Math.max(0, -hipSwayZ) * 0.75;
    const sideSpineTilt = THREE.MathUtils.lerp(-hipRollX * 0.55, addrSideTilt, settleU);
    const spineTwist = chestTurnY - hipTurnY;

    if (hipsState) {
      const lowFootDrop = Math.max(0, -Math.min(lFootRelY, rFootRelY));
      const stanceSlopeDrop = Math.abs(lFootRelY - rFootRelY) * 0.26 + lowFootDrop * 0.32 + Math.max(0, -ballRelFeetY) * 0.20;
      const addrHipDropY = (isPutt ? -0.044 : -0.058) - stanceSlopeDrop + breathCycle * 0.003;
      const walkHipDropY = -0.010 - stanceSlopeDrop * 0.65 + hipBobY;
      const hipDropY = THREE.MathUtils.lerp(walkHipDropY, addrHipDropY, settleU);
      const addrHipBackX = isPutt ? -0.036 : -0.062;
      const hipBackX = THREE.MathUtils.lerp(-0.006, addrHipBackX, settleU);
      const hipsParent = hipsState.bone.parent!;
      hipsParent.updateWorldMatrix(true, false);
      const pRootLocal = hipsState.restWorldPos.clone().add(new THREE.Vector3(hipBackX, hipDropY, hipSwayZ));
      const pWorld = pRootLocal.applyMatrix4(this.root.matrixWorld);
      const pParentLocal = pWorld.applyMatrix4(new THREE.Matrix4().copy(hipsParent.matrixWorld).invert());
      hipsState.bone.position.copy(pParentLocal);

      const hipTiltZ = THREE.MathUtils.lerp(-0.02, -0.07, settleU);
      const qHipTurn = new THREE.Quaternion().setFromEuler(new THREE.Euler(hipRollX, hipTurnY, hipTiltZ, 'ZXY'));
      this.rotateBoneFromRest('mixamorig:Hips', qHipTurn);
    }

    // Distribute forward hip hinge, secondary tilt & X-factor twist smoothly across Spine -> Spine1 -> Spine2
    // 'ZXY' tilts the spine axis forward toward the ball FIRST, then coils around the tilted spine axis!
    const spineWeights: Array<[string, number]> = [
      ['mixamorig:Spine', 0.38],
      ['mixamorig:Spine1', 0.34],
      ['mixamorig:Spine2', 0.28],
    ];
    let accumEulerY = hipTurnY;
    let accumEulerZ = THREE.MathUtils.lerp(-0.02, -0.07, settleU);
    let accumEulerX = hipRollX * 0.4;
    for (const [bName, w] of spineWeights) {
      accumEulerY += spineTwist * w;
      accumEulerZ += forwardSpineTilt * w;
      accumEulerX += sideSpineTilt * w;
      const qSpine = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(accumEulerX, accumEulerY, accumEulerZ, 'ZXY')
      );
      this.rotateBoneFromRest(bName, qSpine);
    }

    // Split cervical counter-rotation smoothly between Neck & Head so his face & gaze lock directly onto the ball
    // at address and smoothly glance toward the target!
    const gazeTargetBlend = Math.max(headTrackTarget, idleGlance * 0.85);
    const addrHeadPitch = isWood ? -0.82 : isPutt ? -1.02 : -0.90;
    const effectiveAddrPitch = THREE.MathUtils.lerp(-0.20, addrHeadPitch, settleU);
    const headYaw = THREE.MathUtils.lerp(0.0, 0.62, gazeTargetBlend);
    const headPitch = THREE.MathUtils.lerp(effectiveAddrPitch, 0.14, gazeTargetBlend);
    const neckYaw = THREE.MathUtils.lerp(accumEulerY * 0.52, headYaw * 0.8, 0.38);
    const neckPitch = THREE.MathUtils.lerp(accumEulerZ * 0.65, headPitch * 0.68, 0.6);
    this.rotateBoneFromRest(
      'mixamorig:Neck',
      new THREE.Quaternion().setFromEuler(new THREE.Euler(accumEulerX * 0.4, neckYaw, neckPitch, 'ZXY'))
    );
    this.rotateBoneFromRest(
      'mixamorig:Head',
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, headYaw, headPitch, 'ZXY'))
    );

    // Parent clavicles cleanly inside Spine2 frame with realistic trail-shoulder drop (right hand sits lower on grip)
    const qSpine2Frame = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(accumEulerX, accumEulerY, accumEulerZ, 'ZXY')
    );
    const qLeftScapula = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.04, armSweep * 0.16, -0.04 + Math.max(0, armSweep) * 0.08, 'YXZ')
    );
    const qRightScapula = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-0.07, -armSweep * 0.12, -0.05, 'YXZ')
    );
    this.rotateBoneFromRest('mixamorig:LeftShoulder', qSpine2Frame.clone().multiply(qLeftScapula));
    this.rotateBoneFromRest('mixamorig:RightShoulder', qSpine2Frame.clone().multiply(qRightScapula));

    this.root.updateMatrixWorld(true);

    // ------------------------------------------------------------------
    // 3. PLANTED FEET & ZERO-TWIST 2-BONE LEG IK
    // ------------------------------------------------------------------
    const lHip = this.bones.get('mixamorig:LeftUpLeg');
    const lLeg = this.bones.get('mixamorig:LeftLeg');
    const rHip = this.bones.get('mixamorig:RightUpLeg');
    const rLeg = this.bones.get('mixamorig:RightLeg');

    if (lHip && lLeg && rHip && rLeg) {
      const lHipPos = toRootLocal(lHip.bone.getWorldPosition(new THREE.Vector3()));
      const rHipPos = toRootLocal(rHip.bone.getWorldPosition(new THREE.Vector3()));

      const cosW = Math.cos(walkYawTurn);
      const sinW = Math.sin(walkYawTurn);

      const lRelX = lAddrX - rootAddrX;
      const lRelZ = lAddrZ - rootAddrZ;
      const rRelX = rAddrX - rootAddrX;
      const rRelZ = rAddrZ - rootAddrZ;

      const ANKLE_SOLE_Y = 0.109;
      const leadFootTarget = isWalkIn
        ? new THREE.Vector3(lRelX * cosW - lRelZ * sinW, ANKLE_SOLE_Y + lFootRelY + liftL, lRelX * sinW + lRelZ * cosW)
        : new THREE.Vector3(-0.015, ANKLE_SOLE_Y + lFootRelY, -stanceHalfW);
      const trailLiftY = trailHeelLift * 0.085 + liftR;
      const trailFootTarget = isWalkIn
        ? new THREE.Vector3(rRelX * cosW - rRelZ * sinW, ANKLE_SOLE_Y + rFootRelY + liftR, rRelX * sinW + rRelZ * cosW)
        : new THREE.Vector3(0.01 + trailHeelLift * 0.045, ANKLE_SOLE_Y + rFootRelY + trailLiftY, stanceHalfW - trailHeelLift * 0.032);

      const leadStraight = animPhase === 'followthrough' ? 0.55 : animPhase === 'downswing' ? phaseT * 0.4 : 0;
      const lKneePole = new THREE.Vector3(1.0 - leadStraight * 0.35, 0.12, THREE.MathUtils.lerp(-0.08, -0.22, settleU));
      const rKneePole = new THREE.Vector3(0.95, 0.10, -trailHeelLift * 0.7 + THREE.MathUtils.lerp(0.08, 0.15, settleU));

      const lKnee = solveTwoBoneIK(lHipPos, leadFootTarget, lHip.length, lLeg.length, lKneePole);
      const rKnee = solveTwoBoneIK(rHipPos, trailFootTarget, rHip.length, rLeg.length, rKneePole);

      // Keep shoe orientation locked to walk direction while planted, pivoting into golf stance ONLY while lifted in Step 3/4!
      const rFootAngle = rFootAngleBase + (isWalkIn ? 0 : trailHeelLift * 0.55);
      const lWalkPitch = isWalkIn ? pitchL : 0.0;
      const rWalkPitch = isWalkIn ? pitchR : 0.0;
      const lFootFwd = new THREE.Vector3(Math.cos(lFootAngle), lWalkPitch, -Math.sin(lFootAngle)).normalize();
      const rFootFwd = new THREE.Vector3(
        Math.cos(rFootAngle),
        -trailHeelLift * 0.45 + rWalkPitch,
        -Math.sin(rFootAngle)
      ).normalize();

      // Align femur & tibia kneecap fronts with knee bend + pelvic/foot orientation so thighs never twist 70° in socket
      const lHipFwd = new THREE.Vector3(Math.cos(hipTurnY * 0.45), 0, -Math.sin(hipTurnY * 0.45));
      const rHipFwd = new THREE.Vector3(Math.cos(hipTurnY * 0.45), 0, -Math.sin(hipTurnY * 0.45));
      const lKneeFront = lKnee.clone().sub(lHipPos.clone().add(leadFootTarget).multiplyScalar(0.5))
        .addScaledVector(lHipFwd, 0.18).addScaledVector(lFootFwd, 0.22).normalize();
      const rKneeFront = rKnee.clone().sub(rHipPos.clone().add(trailFootTarget).multiplyScalar(0.5))
        .addScaledVector(rHipFwd, 0.18).addScaledVector(rFootFwd, 0.22).normalize();

      this.aimBone('mixamorig:LeftUpLeg', lKnee.clone().sub(lHipPos), lKneeFront);
      this.aimBone('mixamorig:LeftLeg', leadFootTarget.clone().sub(lKnee), lKneeFront.clone().lerp(lFootFwd, 0.45));
      this.aimBone(
        'mixamorig:LeftFoot',
        new THREE.Vector3(lFootFwd.x, -0.58 + lWalkPitch, lFootFwd.z),
        new THREE.Vector3(0, 1, 0)
      );

      this.aimBone('mixamorig:RightUpLeg', rKnee.clone().sub(rHipPos), rKneeFront);
      this.aimBone('mixamorig:RightLeg', trailFootTarget.clone().sub(rKnee), rKneeFront.clone().lerp(rFootFwd, 0.45));
      this.aimBone(
        'mixamorig:RightFoot',
        new THREE.Vector3(rFootFwd.x, -0.58 - trailHeelLift * 0.4 + rWalkPitch, rFootFwd.z),
        new THREE.Vector3(0, 1, 0)
      );

      // Anchor soft ground contact shadows directly beneath both shoes (hugging exact foot terrain height!)
      this.leadShoeShadow.position.set(leadFootTarget.x + 0.095, lFootRelY + 0.008, leadFootTarget.z - 0.01);
      this.leadShoeShadow.rotation.y = lFootAngle;
      this.leadShoeShadow.scale.setScalar(1.0 - liftL * 2.2);
      (this.leadShoeShadow.material as THREE.MeshBasicMaterial).opacity =
        0.44 * Math.max(0.18, 1.0 - liftL * 7.5);

      this.trailShoeShadow.position.set(trailFootTarget.x + 0.095, rFootRelY + 0.008, trailFootTarget.z + 0.01);
      this.trailShoeShadow.rotation.y = rFootAngle;
      this.trailShoeShadow.scale.setScalar(1.0 - trailHeelLift * 0.22 - liftR * 2.2);
      (this.trailShoeShadow.material as THREE.MeshBasicMaterial).opacity =
        0.44 * Math.max(0.18, 1.0 - trailHeelLift * 0.55 - liftR * 7.5);
    }

    // ------------------------------------------------------------------
    // 4. CHEST-ANCHORED CLUB SWING PLANE, ZERO-TWIST ARM IK & 5-FINGER GRIP
    // ------------------------------------------------------------------
    this.root.updateMatrixWorld(true);
    const spine2State = this.bones.get('mixamorig:Spine2');
    const lArm = this.bones.get('mixamorig:LeftArm');
    const lFore = this.bones.get('mixamorig:LeftForeArm');
    const rArm = this.bones.get('mixamorig:RightArm');
    const rFore = this.bones.get('mixamorig:RightForeArm');

    if (spine2State && lArm && lFore && rArm && rFore) {
      const lShPos = toRootLocal(lArm.bone.getWorldPosition(new THREE.Vector3()));
      const rShPos = toRootLocal(rArm.bone.getWorldPosition(new THREE.Vector3()));

      // Spine2 orientation in `this.root` local space: delta from restWorldQuat
      const spine2RootPos = toRootLocal(spine2State.bone.getWorldPosition(new THREE.Vector3()));
      const rootWorldQ = this.root.getWorldQuaternion(new THREE.Quaternion());
      const spine2LocalWorldQ = rootWorldQ
        .clone()
        .invert()
        .multiply(spine2State.bone.getWorldQuaternion(new THREE.Quaternion()));
      const chestQ = spine2LocalWorldQ.multiply(spine2State.restWorldQuat.clone().invert());

      // Anchor grip center comfortably below chin and clear (~17cm) in front of hips/thighs,
      // keeping both lead and trail arms in healthy athletic reach (38%..90%) across Driver, Irons & Putter
      const addrGripRelChest = new THREE.Vector3(
        isPutt ? 0.235 : 0.262,
        (isPutt ? -0.292 : -0.275) - THREE.MathUtils.clamp(-ballRelFeetY, -0.08, 0.20) * 0.24,
        isPutt ? 0.010 : 0.010
      );
      let gripRelChest: THREE.Vector3;
      if (isPutt) {
        gripRelChest = new THREE.Vector3(
          addrGripRelChest.x,
          addrGripRelChest.y + Math.abs(armSweep) * 0.04,
          addrGripRelChest.z + armSweep * 0.28
        );
      } else if (armSweep >= 0) {
        const t = armSweep;
        gripRelChest = new THREE.Vector3(
          THREE.MathUtils.lerp(addrGripRelChest.x, 0.28, t),
          THREE.MathUtils.lerp(addrGripRelChest.y, 0.11, t),
          THREE.MathUtils.lerp(addrGripRelChest.z, 0.14, t)
        );
      } else {
        const t = -armSweep;
        gripRelChest = new THREE.Vector3(
          THREE.MathUtils.lerp(addrGripRelChest.x, 0.29, t),
          THREE.MathUtils.lerp(addrGripRelChest.y, 0.12, t),
          THREE.MathUtils.lerp(addrGripRelChest.z, -0.15, t)
        );
      }

      const gripCenterLocal = gripRelChest.clone().applyQuaternion(chestQ).add(spine2RootPos);
      const addrGripLocal = addrGripRelChest.clone().applyQuaternion(chestQ).add(spine2RootPos);
      const ballLocal = new THREE.Vector3(standDist, ballRelFeetY + 0.015, 0.0);

      const chestShaftDir = new THREE.Vector3(0.68, -0.73, 0.0).normalize();
      let shaftDir = chestShaftDir.clone().applyQuaternion(chestQ);

      const impactAlign = 1 - Math.min(1, Math.abs(armSweep) * 2.5);
      const exactAddrShaft = new THREE.Vector3().subVectors(ballLocal, addrGripLocal).normalize();
      shaftDir.lerp(exactAddrShaft, impactAlign).normalize();

      if (isPutt) {
        const qPutt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -armSweep * 1.15);
        shaftDir.applyQuaternion(qPutt).normalize();
      } else {
        const swingAxisLocal = new THREE.Vector3(-0.72, 0.69, 0.0).normalize();
        const qSwing = new THREE.Quaternion().setFromAxisAngle(
          swingAxisLocal,
          armSweep * 1.02 + wristCock
        );
        shaftDir.applyQuaternion(qSwing).normalize();
      }

      if (impactAlign > 0.5) {
        const distToBall = gripCenterLocal.distanceTo(ballLocal);
        const gripAdjust = Math.max(-0.03, Math.min(0.035, shaftLen - distToBall));
        gripCenterLocal.addScaledVector(shaftDir, -gripAdjust * impactAlign);
      }

      const shaftUpPreRoll = shaftDir.clone().negate();
      this.clubMount.position.copy(gripCenterLocal);
      const chestRight = new THREE.Vector3(0, 0, 1).applyQuaternion(chestQ);
      const clubXPre = new THREE.Vector3().crossVectors(shaftUpPreRoll, chestRight);
      if (clubXPre.lengthSq() < 1e-5) clubXPre.set(1, 0, 0);
      clubXPre.normalize();
      const clubZPre = new THREE.Vector3().crossVectors(clubXPre, shaftUpPreRoll).normalize();
      this.clubMount.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(clubXPre, shaftUpPreRoll, clubZPre)
      );
      this.clubMount.rotateOnAxis(new THREE.Vector3(0, 1, 0), faceRoll);

      // Extract post-faceRoll club basis so hands remain 100% locked onto the rotating grip through the entire swing
      const clubX = new THREE.Vector3(1, 0, 0).applyQuaternion(this.clubMount.quaternion).normalize();
      const shaftUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.clubMount.quaternion).normalize();
      const clubZ = new THREE.Vector3(0, 0, 1).applyQuaternion(this.clubMount.quaternion).normalize();

      // Anatomical PGA Tour diagonal-crease golf grip:
      // Left pinky sits cleanly below the +0.080 butt cap (+0.026), Right sits at -0.068 leaving room for Left thumb
      const leadGripPt = gripCenterLocal.clone().addScaledVector(shaftUp, 0.026);
      const trailGripPt = gripCenterLocal.clone().addScaledVector(shaftUp, -0.068);

      const buildHandGripBasis = (
        side: 'Left' | 'Right',
        palmAzimuthDeg: number,
        diagX: number
      ): { handX: THREE.Vector3; palmN: THREE.Vector3; handZ: THREE.Vector3 } => {
        const zSign = side === 'Left' ? 1 : -1;
        const diagZ = Math.sqrt(Math.max(0.05, 1 - diagX * diagX - 0.08 * 0.08)) * zSign;
        const sUpLocal = new THREE.Vector3(-diagX, 0.08, diagZ).normalize();
        const palmLocal = new THREE.Vector3(0, 1, 0);
        const palmPerpLocal = palmLocal.clone().addScaledVector(sUpLocal, -palmLocal.dot(sUpLocal)).normalize();
        const thirdLocal = new THREE.Vector3().crossVectors(sUpLocal, palmPerpLocal).normalize();

        const rad = THREE.MathUtils.degToRad(palmAzimuthDeg);
        const palmTargetPerp = clubX
          .clone()
          .multiplyScalar(Math.sin(rad))
          .addScaledVector(clubZ, Math.cos(rad))
          .normalize();
        const thirdClub = new THREE.Vector3().crossVectors(shaftUp, palmTargetPerp).normalize();

        const mLocal = new THREE.Matrix4().makeBasis(sUpLocal, palmPerpLocal, thirdLocal);
        const mClub = new THREE.Matrix4().makeBasis(shaftUp, palmTargetPerp, thirdClub);
        const R = new THREE.Matrix4().multiplyMatrices(mClub, mLocal.transpose());

        return {
          handX: new THREE.Vector3(1, 0, 0).applyMatrix4(R).normalize(),
          palmN: new THREE.Vector3(0, 1, 0).applyMatrix4(R).normalize(),
          handZ: new THREE.Vector3(0, 0, 1).applyMatrix4(R).normalize(),
        };
      };

      const leadGrip = buildHandGripBasis('Left', isPutt ? 30 : 38, isPutt ? 0.54 : 0.58);
      const trailGrip = buildHandGripBasis('Right', isPutt ? 142 : 134, isPutt ? 0.48 : 0.50);
      const lHandDir = leadGrip.handX;
      const lPalmN = leadGrip.palmN;
      const rHandDir = trailGrip.handX;
      const rPalmN = trailGrip.palmN;

      // Arch knuckles snugly around the grip perimeter (-0.077*X, -0.0225*Y) so every phalanx hugs outside 13mm grip skin
      const lWristTarget = leadGripPt
        .clone()
        .addScaledVector(lHandDir, -0.077)
        .addScaledVector(lPalmN, -0.0225);
      const rWristTarget = trailGripPt
        .clone()
        .addScaledVector(rHandDir, -0.077)
        .addScaledVector(rPalmN, -0.0225);

      const leadElbowHint = new THREE.Vector3(-0.22, -0.32, -0.88).applyQuaternion(chestQ);
      const trailElbowHint = new THREE.Vector3(-0.42, -0.40, 0.82).applyQuaternion(chestQ);

      let activeLeadGripHandZ = leadGrip.handZ;
      let activeTrailGripHandZ = trailGrip.handZ;
      let walkLFingerScale = 1.0;

      if (isWalkIn) {
        // Long, unhurried quintic blend starting smoothly during Step 2 (0.28..0.97) — zero snapping!
        const gripBlend = smootherstep(phaseT, 0.28, 0.97);
        walkLFingerScale = THREE.MathUtils.lerp(0.24, 1.0, gripBlend);

        // Quiet, composed PGA walk: subtle relaxed arm drift (never fast jogging arm-pump!)
        const lArc = armSwingSignal * 0.032;
        const rArc = -armSwingSignal * 0.018;
        const lWristWalk = new THREE.Vector3(
          0.065 + lArc,
          0.885 + Math.max(0, armSwingSignal) * 0.010 + hipBobY * 0.55,
          -0.225 - hipRollX * 0.12
        );
        const rWristWalk = new THREE.Vector3(
          0.095 + rArc,
          0.892 + hipBobY * 0.55,
          0.232 - hipRollX * 0.12
        );

        // Calm relaxed iron carry by right side
        const walkShaftUp = new THREE.Vector3(
          -0.36 + rArc * 0.22,
          0.930,
          -0.06
        ).normalize();
        const walkClubZ = new THREE.Vector3(0.06, 0.05, 0.99).normalize();
        const walkClubX = new THREE.Vector3().crossVectors(walkShaftUp, walkClubZ).normalize();
        const walkClubZOrtho = new THREE.Vector3().crossVectors(walkClubX, walkShaftUp).normalize();
        const walkClubQ = new THREE.Quaternion().setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(walkClubX, walkShaftUp, walkClubZOrtho)
        );
        const walkGripCenter = rWristWalk.clone().add(new THREE.Vector3(0.036, 0.028, 0.015));

        this.clubMount.position.lerpVectors(walkGripCenter, gripCenterLocal, gripBlend);
        const addrClubQ = this.clubMount.quaternion.clone();
        this.clubMount.quaternion.copy(walkClubQ).slerp(addrClubQ, gripBlend);

        lWristTarget.lerpVectors(lWristWalk, lWristTarget, gripBlend);
        rWristTarget.lerpVectors(rWristWalk, rWristTarget, gripBlend);
        // Gentle forward clearance arc so left hand glides cleanly in front of thigh to meet the club
        const handLiftArc = Math.sin(gripBlend * Math.PI);
        lWristTarget.x += handLiftArc * 0.055;
        lWristTarget.y += handLiftArc * 0.025;

        const walkLHandDir = new THREE.Vector3(
          0.12 + armSwingSignal * 0.09,
          -0.98,
          0.06
        ).normalize();
        const walkLPalmN = new THREE.Vector3(0.0, 0.08, 1.0).normalize();
        const walkRHandDir = new THREE.Vector3(0.42, -0.90, -0.06).normalize();
        const walkRPalmN = new THREE.Vector3(-0.18, -0.10, -0.97).normalize();

        lHandDir.lerpVectors(walkLHandDir, lHandDir, gripBlend).normalize();
        lPalmN.lerpVectors(walkLPalmN, lPalmN, gripBlend).normalize();
        rHandDir.lerpVectors(walkRHandDir, rHandDir, gripBlend).normalize();
        rPalmN.lerpVectors(walkRPalmN, rPalmN, gripBlend).normalize();

        leadElbowHint.lerp(new THREE.Vector3(-0.74, -0.12, -0.66), 1 - gripBlend).normalize();
        trailElbowHint.lerp(new THREE.Vector3(-0.74, -0.12, 0.66), 1 - gripBlend).normalize();

        const walkLHandZ = new THREE.Vector3().crossVectors(walkLHandDir, walkLPalmN).normalize();
        const walkRHandZ = new THREE.Vector3().crossVectors(walkRHandDir, walkRPalmN).normalize();
        activeLeadGripHandZ = walkLHandZ.lerp(leadGrip.handZ, gripBlend).normalize();
        activeTrailGripHandZ = walkRHandZ.lerp(trailGrip.handZ, gripBlend).normalize();
      }

      const lElbow = solveTwoBoneIK(lShPos, lWristTarget, lArm.length, lFore.length, leadElbowHint);
      const rElbow = solveTwoBoneIK(rShPos, rWristTarget, rArm.length, rFore.length, trailElbowHint);

      // Compute outer-elbow tricep directions (+Y of Arm/ForeArm in rest pose) for 0° bicep/elbow torsion
      const lElbowOut = lElbow
        .clone()
        .sub(lShPos.clone().add(lWristTarget).multiplyScalar(0.5))
        .addScaledVector(leadElbowHint, 0.16)
        .normalize();
      const rElbowOut = rElbow
        .clone()
        .sub(rShPos.clone().add(rWristTarget).multiplyScalar(0.5))
        .addScaledVector(trailElbowHint, 0.16)
        .normalize();

      // Smoothly distribute arm pronation/supination across shoulder (humeral roll) -> forearm -> wrist
      // so neither the elbow hinge (<=18°) nor the wrist (<=32°) ever experiences candy-wrapper pinch!
      const lArmDir = lElbow.clone().sub(lShPos).normalize();
      const lForeDir = lWristTarget.clone().sub(lElbow).normalize();
      const lBendQ = new THREE.Quaternion().setFromUnitVectors(lArmDir, lForeDir);
      const lArmTwist = lElbowOut.clone().lerp(activeLeadGripHandZ, 0.68).normalize();
      const lForeBase = lArmTwist.clone().applyQuaternion(lBendQ);
      const lForeTwist = lForeBase.clone().lerp(activeLeadGripHandZ, 0.34).normalize();

      const rArmDir = rElbow.clone().sub(rShPos).normalize();
      const rForeDir = rWristTarget.clone().sub(rElbow).normalize();
      const rBendQ = new THREE.Quaternion().setFromUnitVectors(rArmDir, rForeDir);
      const rHandRef = activeTrailGripHandZ.clone().negate();
      const rArmTwist = rElbowOut.clone().lerp(rHandRef, 0.68).normalize();
      const rForeBase = rArmTwist.clone().applyQuaternion(rBendQ);
      const rForeTwist = rForeBase.clone().lerp(rHandRef, 0.34).normalize();

      this.aimBone('mixamorig:LeftArm', lArmDir, lArmTwist);
      this.aimBone('mixamorig:RightArm', rArmDir, rArmTwist);

      this.aimBone('mixamorig:LeftForeArm', lForeDir, lForeTwist);
      this.aimBone('mixamorig:RightForeArm', rForeDir, rForeTwist);

      this.aimBone('mixamorig:LeftHand', lHandDir, lPalmN);
      this.aimBone('mixamorig:RightHand', rHandDir, rPalmN);

      this.curlFingersAroundGrip('Left', isPutt, walkLFingerScale);
      this.curlFingersAroundGrip('Right', isPutt, 1.0);
    }

    // ------------------------------------------------------------------
    // 5. NATURAL BLINKING, EYE BALL-TRACKING & CONFIDENT EXPRESSION
    // ------------------------------------------------------------------
    this.updateFaceAndEyes(dt, animPhase, gazeTargetBlend);
  }

  private curlFingersAroundGrip(side: 'Left' | 'Right', isPutt = false, curlAmount = 1.0): void {
    // Both Left and Right Mixamo hand skeletons share +X along fingers and +Y facing out of palm,
    // so positive rotateZ(+curls) curls fingertips inward toward the palm around the diagonal grip crease.
    // Graded per-finger curls prevent shorter Index from clipping inside the 1.4cm grip while wrapping Ring/Pinky snugly.
    const perFingerCurls: Record<string, [number, number, number]> = {
      Index: isPutt ? [0.52, 0.98, 0.98] : [0.56, 1.02, 1.00],
      Middle: isPutt ? [0.76, 1.08, 0.98] : [0.80, 1.12, 1.02],
      Ring: isPutt ? [0.86, 1.12, 0.98] : [0.92, 1.18, 1.02],
      Pinky: isPutt ? [0.92, 1.16, 0.96] : [0.98, 1.22, 1.00],
    };
    for (const finger of FINGER_NAMES) {
      if (finger === 'Thumb') {
        const t1 = this.bones.get(`mixamorig:${side}HandThumb1`);
        const t2 = this.bones.get(`mixamorig:${side}HandThumb2`);
        const t3 = this.bones.get(`mixamorig:${side}HandThumb3`);
        // Symmetric mirror adduction lays both thumbs comfortably down along the shaft without hitting opposite palm
        if (t1) {
          t1.bone.rotateY((side === 'Left' ? -0.18 : 0.22) * curlAmount);
          t1.bone.rotateZ((side === 'Left' ? 0.22 : 0.26) * curlAmount);
        }
        if (t2) t2.bone.rotateZ((side === 'Left' ? 0.14 : 0.18) * curlAmount);
        if (t3) t3.bone.rotateZ(0.08 * curlAmount);
        continue;
      }
      const curls = perFingerCurls[finger];
      for (let seg = 1; seg <= 3; seg++) {
        const fb = this.bones.get(`mixamorig:${side}Hand${finger}${seg}`);
        if (!fb || !curls) continue;
        fb.bone.rotateZ(curls[seg - 1] * curlAmount);
      }
    }
  }

  private updateFaceAndEyes(dt: number, animPhase: SwingAnimPhase, gazeTargetBlend: number): void {
    if (this.morphMeshes.length > 0) {
      if (this.simTimeS > this.nextBlinkS + 0.16) {
        this.nextBlinkS = this.simTimeS + 2.4 + Math.random() * 3.4;
      }
      let blink = 0;
      if (this.simTimeS > this.nextBlinkS) {
        blink = Math.sin(((this.simTimeS - this.nextBlinkS) / 0.16) * Math.PI);
      }
      // Slight athletic focus squint during swing
      const focus = animPhase === 'backswing' || animPhase === 'downswing' ? 0.22 : 0.0;
      for (const m of this.morphMeshes) {
        const dict = m.morphTargetDictionary!;
        const inf = m.morphTargetInfluences!;
        for (const [k, v] of Object.entries(ARKIT_CONFIDENT)) {
          if (dict[k] !== undefined) inf[dict[k]] = v + (k.startsWith('eyeSquint') ? focus : 0);
        }
        if (dict.eyeBlinkLeft !== undefined) inf[dict.eyeBlinkLeft] = blink;
        if (dict.eyeBlinkRight !== undefined) inf[dict.eyeBlinkRight] = blink;
      }
    }

    // Eye bone axes in golfer.glb: X = forward pupil look, Y = down, Z = left.
    // rotateZ(+pitchDown) pitches eyes downward toward ball; rotateY(-yaw) looks toward target (-Z)!
    if (this.leftEyeBone && this.rightEyeBone && this.headBone) {
      const pitchDown = THREE.MathUtils.lerp(0.32, -0.06, gazeTargetBlend);
      const yawTarget = THREE.MathUtils.lerp(0.0, -0.18, gazeTargetBlend);
      this.leftEyeBone.quaternion.copy(this.leftEyeRestQ);
      this.rightEyeBone.quaternion.copy(this.rightEyeRestQ);
      this.leftEyeBone.rotateZ(pitchDown);
      this.rightEyeBone.rotateZ(pitchDown);
      this.leftEyeBone.rotateY(yawTarget);
      this.rightEyeBone.rotateY(yawTarget);
    }
    void dt;
  }

  public dispose(): void {
    this.disposed = true;
    this.fallbackRig.dispose();
    for (const tex of this.extraMaps) tex.dispose();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
        else mat.dispose();
      }
    });
  }
}
