import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

export type TimeOfDayPreset = 'morning_mist' | 'coastal_noon' | 'golden_hour' | 'twilight';

export interface AtmosphereConfig {
  label: string;
  elevationDeg: number;
  azimuthDeg: number;
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  exposure: number;
  fogColor: number;
  fogDensity: number;
  sunColor: number;
  sunIntensity: number;
  hemiSkyColor: number;
  hemiGroundColor: number;
  hemiIntensity: number;
  envIntensity: number;
  bounceColor: number;
  bounceIntensity: number;
  mistDensity: number;
}

export const TIME_OF_DAY_PRESETS: Record<TimeOfDayPreset, AtmosphereConfig> = {
  morning_mist: {
    label: 'Morning Coastal Mist',
    elevationDeg: 15,
    azimuthDeg: 118,
    turbidity: 5.5,
    rayleigh: 1.95,
    mieCoefficient: 0.0095,
    mieDirectionalG: 0.85,
    exposure: 0.50,
    fogColor: 0xcbd9e2,
    fogDensity: 0.00128,
    sunColor: 0xffebd0,
    sunIntensity: 4.55,
    hemiSkyColor: 0x89b3dc,
    hemiGroundColor: 0x28351d,
    hemiIntensity: 0.48,
    envIntensity: 0.52,
    bounceColor: 0xaad4eb,
    bounceIntensity: 0.46,
    mistDensity: 0.0085,
  },
  coastal_noon: {
    label: 'Championship Afternoon',
    elevationDeg: 27,
    azimuthDeg: 146,
    turbidity: 2.6,
    rayleigh: 1.38,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.82,
    exposure: 0.50,
    fogColor: 0xbad6eb,
    fogDensity: 0.00062,
    sunColor: 0xfff3dc,
    sunIntensity: 5.35,
    hemiSkyColor: 0x6eaee8,
    hemiGroundColor: 0x385226,
    hemiIntensity: 0.44,
    envIntensity: 0.48,
    bounceColor: 0x98cef0,
    bounceIntensity: 0.44,
    mistDensity: 0.0018,
  },
  golden_hour: {
    label: 'Golden Hour Links',
    elevationDeg: 10.5,
    azimuthDeg: 226,
    turbidity: 7.2,
    rayleigh: 2.75,
    mieCoefficient: 0.0115,
    mieDirectionalG: 0.89,
    exposure: 0.52,
    fogColor: 0xe2b690,
    fogDensity: 0.00105,
    sunColor: 0xffb870,
    sunIntensity: 4.95,
    hemiSkyColor: 0xc29276,
    hemiGroundColor: 0x1e2816,
    hemiIntensity: 0.36,
    envIntensity: 0.44,
    bounceColor: 0x89a8d8,
    bounceIntensity: 0.34,
    mistDensity: 0.0048,
  },
  twilight: {
    label: 'Monterey Dusk',
    elevationDeg: 4.5,
    azimuthDeg: 244,
    turbidity: 9.0,
    rayleigh: 3.35,
    mieCoefficient: 0.0145,
    mieDirectionalG: 0.90,
    exposure: 0.56,
    fogColor: 0x777396,
    fogDensity: 0.00130,
    sunColor: 0xff8254,
    sunIntensity: 3.35,
    hemiSkyColor: 0x5869a6,
    hemiGroundColor: 0x141b10,
    hemiIntensity: 0.38,
    envIntensity: 0.46,
    bounceColor: 0x6c88c4,
    bounceIntensity: 0.38,
    mistDensity: 0.0068,
  },
};

const CLOUD_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldDir;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldDir = normalize(position);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const CLOUD_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec2 uWindOffset;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyTint;
  uniform vec3 uFogColor;
  uniform float uCoverage;

  varying vec3 vWorldDir;

  float cHash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float cNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(cHash(i), cHash(i + vec2(1.0, 0.0)), f.x),
      mix(cHash(i + vec2(0.0, 1.0)), cHash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  float cFbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 5; i++) {
      v += a * cNoise(p);
      p = rot * p * 2.05 + vec2(11.3, 19.7);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vWorldDir);
    if (dir.y <= 0.012) discard;

    // 4-slice volumetric parallax raymarch through coastal cumulus deck (base -> crown)
    float projBase = 1.0 / (dir.y + 0.14);
    float cosTheta = max(dot(dir, uSunDir), 0.0);
    float hgPhase = pow(cosTheta, 6.0) * 0.55 + pow(cosTheta, 26.0) * 0.90;
    vec2 sunStep = uSunDir.xz / max(uSunDir.y + 0.25, 0.25) * 0.068;

    vec3 accumCol = vec3(0.0);
    float transmittance = 1.0;

    for (int s = 0; s < 4; s++) {
      float hFrac = float(s) / 3.0;
      float sliceProj = projBase * (1.0 + hFrac * 0.085);
      vec2 uv = dir.xz * sliceProj * 0.72 + uWindOffset * (1.0 + hFrac * 0.05);

      float baseFbm = cFbm(uv * 1.15);
      float detailFbm = cFbm(uv * 2.85 - uWindOffset * 0.35 + vec2(hFrac * 1.7));
      // Rounded puffy cumulus silhouette: denser core in mid-layers, billowy top
      float heightProfile = 1.0 - abs(hFrac - 0.42) * 0.45;
      float densityRaw = (baseFbm * 0.70 + detailFbm * 0.30) * heightProfile;
      float sliceDensity = smoothstep(uCoverage, uCoverage + 0.26, densityRaw);

      if (sliceDensity > 0.01) {
        float sunSample = cFbm((uv + sunStep) * 1.15) * 0.70 + cFbm((uv + sunStep) * 2.85) * 0.30;
        float sunShadow = exp(-smoothstep(uCoverage - 0.04, uCoverage + 0.34, sunSample) * (1.85 - hFrac * 0.95));
        float powder = 1.0 - exp(-sliceDensity * 2.2);

        vec3 shadowCol = mix(uSkyTint * 0.56, uFogColor * 0.80, 0.50);
        vec3 litCol = mix(vec3(0.97, 0.98, 1.0), uSunColor, 0.44) * 1.48;
        vec3 sampleLight = mix(shadowCol, litCol, clamp(sunShadow + hFrac * 0.18, 0.0, 1.0));
        sampleLight += uSunColor * hgPhase * (1.0 - sliceDensity * 0.5) * 0.92;

        float stepAlpha = sliceDensity * (0.36 + 0.22 * powder);
        accumCol += transmittance * sampleLight * stepAlpha;
        transmittance *= (1.0 - stepAlpha);
        if (transmittance < 0.04) break;
      }
    }

    float totalAlpha = 1.0 - transmittance;
    if (totalAlpha < 0.005) discard;

    // Soft atmospheric fade toward coastal horizon
    float horizonFade = smoothstep(0.018, 0.22, dir.y);
    float distFade = 1.0 - smoothstep(1.8, 5.5, projBase);
    float alpha = totalAlpha * horizonFade * distFade * 0.92;
    vec3 cloudCol = accumCol / max(totalAlpha, 0.001);

    gl_FragColor = vec4(cloudCol, alpha);
  }
`;

const IBL_GROUND_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const IBL_GROUND_FRAGMENT = /* glsl */ `
  uniform vec3 uFogColor;
  varying vec3 vDir;
  void main() {
    if (vDir.y > 0.02) discard;
    float oceanSide = smoothstep(-0.35, 0.35, -vDir.x);
    vec3 oceanCol = vec3(0.03, 0.14, 0.24);
    vec3 turfCol = vec3(0.11, 0.24, 0.07);
    vec3 ground = mix(turfCol, oceanCol, oceanSide);
    vec3 col = mix(uFogColor * 0.85, ground, smoothstep(0.02, -0.18, vDir.y));
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class SkyAtmosphereSystem {
  public readonly sky: Sky;
  public readonly cloudDome: THREE.Mesh;
  public readonly csm: CSM;
  public readonly hemiLight: THREE.HemisphereLight;
  public readonly oceanBounceLight: THREE.DirectionalLight;
  public readonly sunDirection = new THREE.Vector3();
  public readonly cloudOffset = new THREE.Vector2();
  public readonly mistColor = new THREE.Color(0xbad6eb);
  public cloudCoverage = 0.49;
  public mistDensity = 0.0018;
  public currentPreset: TimeOfDayPreset = 'coastal_noon';
  private pmremGenerator: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private skyScene: THREE.Scene;
  private cloudMat: THREE.ShaderMaterial;
  private envCloudMat: THREE.ShaderMaterial;
  private envGroundMat: THREE.ShaderMaterial;
  private csmMaterials = new WeakSet<THREE.Material>();

  public get sunLight(): THREE.DirectionalLight {
    return this.csm.lights[0];
  }

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly camera: THREE.PerspectiveCamera
  ) {
    this.sky = new Sky();
    this.sky.scale.setScalar(4500);
    this.scene.add(this.sky);

    this.cloudMat = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERTEX_SHADER,
      fragmentShader: CLOUD_FRAGMENT_SHADER,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uWindOffset: { value: new THREE.Vector2() },
        uSunDir: { value: new THREE.Vector3(0.4, 0.6, -0.5).normalize() },
        uSunColor: { value: new THREE.Color(0xfff5e0) },
        uSkyTint: { value: new THREE.Color(0x8ec3f2) },
        uFogColor: { value: new THREE.Color(0xc2dced) },
        uCoverage: { value: 0.49 },
      },
    });
    this.cloudDome = new THREE.Mesh(new THREE.SphereGeometry(4100, 48, 24), this.cloudMat);
    this.cloudDome.renderOrder = 1;
    this.cloudDome.frustumCulled = false;
    this.scene.add(this.cloudDome);

    // Rich IBL reflection dome containing Sky + Animated Cloud Deck + Ocean/Turf Lower Horizon
    this.skyScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(1000);
    this.skyScene.add(envSky);

    this.envCloudMat = this.cloudMat.clone();
    const envClouds = new THREE.Mesh(new THREE.SphereGeometry(850, 32, 16), this.envCloudMat);
    this.skyScene.add(envClouds);

    this.envGroundMat = new THREE.ShaderMaterial({
      vertexShader: IBL_GROUND_VERTEX,
      fragmentShader: IBL_GROUND_FRAGMENT,
      side: THREE.BackSide,
      uniforms: { uFogColor: { value: new THREE.Color(0xbad6eb) } },
    });
    const envGround = new THREE.Mesh(new THREE.SphereGeometry(780, 24, 12), this.envGroundMat);
    this.skyScene.add(envGround);

    // 3-Cascade Cascaded Shadow Maps (0..22m ultra-sharp golfer/cleats -> 22..96m trees/bunkers -> 96..340m panoramic fairway/green)
    this.csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: 3,
      maxFar: 340,
      mode: 'custom',
      customSplitsCallback: (_cascades: number, _near: number, _far: number, target: number[]) => {
        target.push(0.064, 0.28, 1.0);
      },
      shadowMapSize: 2048,
      lightDirection: new THREE.Vector3(-0.4, -0.6, 0.5).normalize(),
      lightIntensity: 5.35,
      lightNear: 1,
      lightFar: 580,
      lightMargin: 130,
      shadowBias: -0.00014,
    });
    this.csm.fade = true;
    this.csm.updateFrustums();

    for (let i = 0; i < this.csm.lights.length; i++) {
      const l = this.csm.lights[i];
      l.shadow.bias = i === 0 ? -0.00012 : i === 1 ? -0.00022 : -0.00036;
      l.shadow.normalBias = i === 0 ? 0.012 : i === 1 ? 0.024 : 0.040;
      l.shadow.radius = i === 0 ? 1.25 : i === 1 ? 1.75 : 2.4;
    }

    this.hemiLight = new THREE.HemisphereLight(0x6eaee8, 0x385226, 0.44);
    this.scene.add(this.hemiLight);

    // Cool coastal Pacific ocean-sky bounce fill light (sculpts shadow sides of golfer, trees & sea stacks)
    this.oceanBounceLight = new THREE.DirectionalLight(0x98cef0, 0.44);
    this.oceanBounceLight.position.set(-78, 30, -34);
    this.oceanBounceLight.castShadow = false;
    this.scene.add(this.oceanBounceLight);

    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();

    this.applyPreset('coastal_noon');
  }

  public applyPreset(preset: TimeOfDayPreset): AtmosphereConfig {
    this.currentPreset = preset;
    const cfg = TIME_OF_DAY_PRESETS[preset];

    const phi = THREE.MathUtils.degToRad(90 - cfg.elevationDeg);
    const theta = THREE.MathUtils.degToRad(cfg.azimuthDeg);
    this.sunDirection.setFromSphericalCoords(1, phi, theta);

    const updateSkyUniforms = (skyObj: Sky) => {
      const u = skyObj.material.uniforms;
      u['turbidity'].value = cfg.turbidity;
      u['rayleigh'].value = cfg.rayleigh;
      u['mieCoefficient'].value = cfg.mieCoefficient;
      u['mieDirectionalG'].value = cfg.mieDirectionalG;
      u['sunPosition'].value.copy(this.sunDirection);
    };

    updateSkyUniforms(this.sky);
    const envSky = this.skyScene.children[0] as Sky;
    updateSkyUniforms(envSky);

    this.csm.lightDirection.copy(this.sunDirection).negate();
    this.csm.lightIntensity = cfg.sunIntensity;
    for (const light of this.csm.lights) {
      light.color.setHex(cfg.sunColor);
      light.intensity = cfg.sunIntensity;
    }

    this.hemiLight.color.setHex(cfg.hemiSkyColor);
    this.hemiLight.groundColor.setHex(cfg.hemiGroundColor);
    this.hemiLight.intensity = cfg.hemiIntensity;

    this.oceanBounceLight.color.setHex(cfg.bounceColor);
    this.oceanBounceLight.intensity = cfg.bounceIntensity;

    this.renderer.toneMappingExposure = cfg.exposure;
    const hdrFogColor = new THREE.Color(cfg.fogColor).multiplyScalar(1.12);
    this.scene.fog = new THREE.FogExp2(hdrFogColor.getHex(), cfg.fogDensity);
    this.mistColor.copy(hdrFogColor);
    this.mistDensity = cfg.mistDensity;
    this.cloudCoverage =
      preset === 'morning_mist' ? 0.40 : preset === 'golden_hour' ? 0.45 : preset === 'twilight' ? 0.47 : 0.49;

    // Sync animated cloud dome & IBL cloud/ground sphere to lighting preset
    for (const mat of [this.cloudMat, this.envCloudMat]) {
      const cu = mat.uniforms;
      cu.uSunDir.value.copy(this.sunDirection);
      cu.uSunColor.value.setHex(cfg.sunColor);
      cu.uSkyTint.value.setHex(cfg.hemiSkyColor);
      cu.uFogColor.value.copy(hdrFogColor);
      cu.uCoverage.value = this.cloudCoverage;
    }
    this.envGroundMat.uniforms.uFogColor.value.copy(hdrFogColor);

    // Regenerate crisp HDR IBL environment map with sky + cloud deck + coastal ocean/turf horizon
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmremGenerator.fromScene(this.skyScene, 0.018);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = cfg.envIntensity;

    return cfg;
  }

  /**
   * Attaches 3-cascade CSM cleanly to every MeshStandardMaterial / MeshPhysicalMaterial
   * while chaining onto existing custom onBeforeCompile hooks (terrain, 8K grass, 4K trees).
   */
  public applyCSMToScene(root?: THREE.Object3D): void {
    const activeMats = new Set<THREE.Material>();
    const targetRoot = root ?? this.scene;

    targetRoot.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (
          !(mat instanceof THREE.MeshStandardMaterial) &&
          !(mat instanceof THREE.MeshPhysicalMaterial)
        ) {
          continue;
        }
        activeMats.add(mat);
        if (this.csmMaterials.has(mat)) continue;

        const prevCompile = mat.onBeforeCompile;
        const prevKey = mat.customProgramCacheKey?.bind(mat);
        const csmShaders = this.csm.shaders as unknown as Map<
          THREE.Material,
          THREE.WebGLProgramParametersWithUniforms | null
        >;
        const breaksVec2: THREE.Vector2[] = [];

        mat.defines = mat.defines || {};
        mat.defines.USE_CSM = 1;
        mat.defines.CSM_CASCADES = this.csm.cascades;
        if (this.csm.fade) mat.defines.CSM_FADE = '';

        mat.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|csm3`;
        mat.onBeforeCompile = (shader, r) => {
          if (prevCompile) prevCompile.call(mat, shader, r);
          const far = Math.min(this.camera.far, this.csm.maxFar);
          this.csm.getExtendedBreaks(breaksVec2);
          shader.uniforms.CSM_cascades = { value: breaksVec2 };
          shader.uniforms.cameraNear = { value: this.camera.near };
          shader.uniforms.shadowFar = { value: far };
          csmShaders.set(mat, shader);
        };
        csmShaders.set(mat, null);
        mat.needsUpdate = true;
        this.csmMaterials.add(mat);
      }
    });

    // Prune any disposed materials from previous holes
    if (!root) {
      const csmShaders = this.csm.shaders as unknown as Map<
        THREE.Material,
        THREE.WebGLProgramParametersWithUniforms | null
      >;
      for (const mat of Array.from(csmShaders.keys())) {
        if (!activeMats.has(mat)) {
          csmShaders.delete(mat);
        }
      }
    }
    this.csm.updateUniforms();
  }

  public update(dt: number, windSpeedMps: number, windDirRad: number, cameraPos: THREE.Vector3): void {
    const speed = (0.002 + windSpeedMps * 0.0008) * dt;
    this.cloudOffset.x += Math.sin(windDirRad) * speed;
    this.cloudOffset.y += -Math.cos(windDirRad) * speed;
    this.cloudMat.uniforms.uTime.value += dt;
    this.cloudMat.uniforms.uWindOffset.value.copy(this.cloudOffset);
    this.cloudDome.position.copy(cameraPos);
    this.csm.update();
  }

  public setShadowResolution(size: 1024 | 2048 | 4096): void {
    const clamped = size >= 4096 ? 2048 : size >= 2048 ? 1536 : 1024;
    if (this.csm.shadowMapSize === clamped) return;
    this.csm.shadowMapSize = clamped;
    for (const light of this.csm.lights) {
      light.shadow.mapSize.set(clamped, clamped);
      if (light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null;
      }
    }
    this.csm.updateShadowBounds();
  }

  public refreshCascades(): void {
    this.csm.updateFrustums();
    this.csm.update();
  }

  public focusShadowsAt(_target: THREE.Vector3, _radius = 85): void {
    // CSM frustums are already updated cleanly once per frame in skySys.update()
  }

  public dispose(): void {
    if (this.envRT) this.envRT.dispose();
    this.pmremGenerator.dispose();
    this.csm.dispose();
    this.csm.remove();
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.cloudDome.geometry.dispose();
    this.cloudMat.dispose();
    this.envCloudMat.dispose();
    this.envGroundMat.dispose();
  }
}
