import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

export type GraphicsQuality = 'ultra' | 'high' | 'medium';

const SUN_SHAFTS_HALATION_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uDepthTex: { value: null },
    uHasDepth: { value: 0.0 },
    uSunScreenPos: { value: new THREE.Vector2(0.5, 0.7) },
    uSunColor: { value: new THREE.Color(0xffdda6) },
    uSunVisible: { value: 0.0 },
    uTexelSize: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uStrength: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D uDepthTex;
    uniform float uHasDepth;
    uniform vec2 uSunScreenPos;
    uniform vec3 uSunColor;
    uniform float uSunVisible;
    uniform vec2 uTexelSize;
    uniform float uStrength;
    varying vec2 vUv;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 col = base.rgb;

      if (uStrength > 0.01) {
        // 1. Tight warm optical film halation strictly around extreme HDR speculars (never smears skin/cloth)
        vec3 halation = vec3(0.0);
        vec2 rStep = uTexelSize * 2.5;
        vec2 offsets[4];
        offsets[0] = vec2( 1.0,  0.6);
        offsets[1] = vec2(-1.0,  0.6);
        offsets[2] = vec2( 0.6, -1.0);
        offsets[3] = vec2(-0.6, -1.0);
        for (int i = 0; i < 4; i++) {
          vec3 s = texture2D(tDiffuse, clamp(vUv + offsets[i] * rStep, 0.002, 0.998)).rgb;
          float sLuma = dot(s, vec3(0.2126, 0.7152, 0.0722));
          halation += s * smoothstep(1.75, 2.95, sLuma);
        }
        col += halation * 0.25 * vec3(1.0, 0.56, 0.30) * 0.10 * uStrength;

        // 2. Depth-gated screen-space volumetric sun shafts (strictly sky/cloud gaps; never bleeds off bunkers or shirts)
        if (uSunVisible > 0.005) {
          vec2 delta = (vUv - uSunScreenPos) * 0.062;
          vec2 coord = vUv;
          float decay = 1.0;
          float accum = 0.0;
          for (int i = 0; i < 12; i++) {
            coord -= delta;
            vec2 cUv = clamp(coord, 0.002, 0.998);
            float skyDepth = uHasDepth > 0.5 ? step(0.994, texture2D(uDepthTex, cUv).x) : 1.0;
            vec3 smp = texture2D(tDiffuse, cUv).rgb;
            float luma = dot(smp, vec3(0.2126, 0.7152, 0.0722));
            float skyPass = smoothstep(0.90, 1.85, luma) * skyDepth;
            accum += skyPass * decay;
            decay *= 0.875;
          }
          float distToSun = length(vUv - uSunScreenPos);
          float radialFalloff = exp(-distToSun * 2.1);
          col += uSunColor * accum * 0.052 * radialFalloff * uSunVisible * uStrength;
        }
      }

      gl_FragColor = vec4(col, base.a);
    }
  `,
};

const BROADCAST_GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uDepthTex: { value: null },
    uHasDepth: { value: 0.0 },
    uCameraNear: { value: 0.15 },
    uCameraFar: { value: 3200.0 },
    uFocusDist: { value: 4.5 },
    uDofStrength: { value: 1.0 },
    uTexelSize: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uSharpness: { value: 0.46 },
    uDofTaps: { value: 1.0 },
    uGradeStrength: { value: 1.0 },
    uExposureLift: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D uDepthTex;
    uniform float uHasDepth;
    uniform float uCameraNear;
    uniform float uCameraFar;
    uniform float uFocusDist;
    uniform float uDofStrength;
    uniform vec2 uTexelSize;
    uniform float uSharpness;
    uniform float uDofTaps;
    uniform float uGradeStrength;
    uniform float uExposureLift;
    varying vec2 vUv;

    float gHash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    float linearViewZ(float rawD) {
      float z = rawD * 2.0 - 1.0;
      return (2.0 * uCameraNear * uCameraFar) / max(uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear), 0.0001);
    }

    void main() {
      vec2 dc = vUv - 0.5;
      float r2 = dot(dc, dc);

      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 cN = texture2D(tDiffuse, clamp(vUv + vec2(0.0, uTexelSize.y), 0.001, 0.999)).rgb;
      vec3 cS = texture2D(tDiffuse, clamp(vUv - vec2(0.0, uTexelSize.y), 0.001, 0.999)).rgb;
      vec3 cE = texture2D(tDiffuse, clamp(vUv + vec2(uTexelSize.x, 0.0), 0.001, 0.999)).rgb;
      vec3 cW = texture2D(tDiffuse, clamp(vUv - vec2(uTexelSize.x, 0.0), 0.001, 0.999)).rgb;

      // 1. Subtle Broadcast Telephoto Depth-of-Field (far background cliffs only; 0% blur on golfer, ball & green)
      float farCoc = 0.0;
      if (uHasDepth > 0.5 && uDofStrength > 0.01) {
        float rawD = texture2D(uDepthTex, vUv).x;
        float vz = linearViewZ(rawD);
        farCoc = smoothstep(uFocusDist + 24.0, uFocusDist + 165.0, vz) * (1.0 - step(0.9994, rawD)) * uDofStrength;
      }

      // Contrast-Adaptive Sharpening (CAS) for razor-crisp golfer, face, fabrics, shaft & grass blades
      vec3 minC3 = min(tex.rgb, min(min(cN, cS), min(cE, cW)));
      vec3 maxC3 = max(tex.rgb, max(max(cN, cS), max(cE, cW)));
      vec3 amp = sqrt(clamp(min(minC3, 1.0 - maxC3) / max(maxC3, vec3(1e-4)), 0.0, 1.0));
      vec3 casWeight = -amp * (0.26 * uSharpness * (1.0 - farCoc * 0.85));
      vec3 sharpCol = clamp((tex.rgb + (cN + cS + cE + cW) * casWeight) / max(1.0 + 4.0 * casWeight, vec3(0.35)), 0.0, 1.0);

      if (farCoc > 0.04 && uDofTaps > 0.5) {
        vec2 aspectScale = vec2(uTexelSize.y / max(uTexelSize.x, 1e-5), 1.0);
        float rad = farCoc * 0.0024;
        // 12-tap golden-angle spiral disc — visibly creamier, more circular bokeh than a 6-tap hex
        vec3 bokehAcc = sharpCol;
        float wAcc = 1.0;
        for (int i = 0; i < 12; i++) {
          float fi = float(i);
          float spiralR = sqrt((fi + 0.5) / 12.0);
          float spiralA = fi * 2.39996;
          vec2 tUv = clamp(vUv + vec2(cos(spiralA), sin(spiralA)) * spiralR * rad * aspectScale, 0.002, 0.998);
          float tapZ = linearViewZ(texture2D(uDepthTex, tUv).x);
          // Reject foreground samples (golfer/trees) so background bokeh never bleeds sharp silhouettes
          float bgGate = smoothstep(uFocusDist + 14.0, uFocusDist + 28.0, tapZ);
          // Bright-weight highlights so sun glints sparkle as natural bokeh discs
          vec3 tapCol = texture2D(tDiffuse, tUv).rgb;
          float tapLuma = dot(tapCol, vec3(0.2126, 0.7152, 0.0722));
          float hl = 1.0 + smoothstep(0.75, 1.6, tapLuma) * 1.4;
          bokehAcc += tapCol * bgGate * hl;
          wAcc += bgGate * hl;
        }
        sharpCol = mix(sharpCol, bokehAcc / wAcc, farCoc * 0.82);
      }

      // Edge-only optical chromatic shift restricted strictly to outer frame corners (leaves center 100% crisp)
      float edgeMask = smoothstep(0.30, 0.75, r2) * uGradeStrength;
      vec2 fringe = dc * edgeMask * 0.0020;
      vec3 col = vec3(
        edgeMask > 0.01 ? texture2D(tDiffuse, clamp(vUv + fringe, 0.001, 0.999)).r : sharpCol.r,
        sharpCol.g,
        edgeMask > 0.01 ? texture2D(tDiffuse, clamp(vUv - fringe, 0.001, 0.999)).b : sharpCol.b
      );
      col = mix(sharpCol, col, edgeMask);

      // Gentle smooth exposure adaptation lift + AgX shadow/highlight preservation
      col *= uExposureLift;
      vec3 curved = col * col * (3.0 - 2.0 * col);
      vec3 graded = mix(col, curved, 0.075);

      float luma = dot(graded, vec3(0.2126, 0.7152, 0.0722));
      float maxC = max(graded.r, max(graded.g, graded.b));
      float minC = min(graded.r, min(graded.g, graded.b));
      float sat = maxC - minC;
      graded = mix(vec3(luma), graded, 1.0 + 0.14 * (1.0 - sat));

      // Crisp broadcast split-tone: deep coastal shadows, warm sunlit highlights
      vec3 shadowTint = vec3(0.955, 0.985, 1.040);
      vec3 highTint = vec3(1.032, 1.008, 0.968);
      graded *= mix(shadowTint, highTint, smoothstep(0.18, 0.84, luma));

      // Subtle optical lens vignette & sky gradient micro-dither
      float vig = 1.0 - r2 * 0.22;
      graded *= mix(1.0, clamp(vig, 0.84, 1.0), 0.70);
      graded += (gHash(vUv * 512.0) - 0.5) * (1.2 / 255.0);

      gl_FragColor = vec4(clamp(mix(sharpCol, graded, uGradeStrength), 0.0, 1.0), tex.a);
    }
  `,
};

export class PostProcessingPipeline {
  public readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly gtaoPass: GTAOPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly shaftsPass: ShaderPass;
  private readonly outputPass: OutputPass;
  private readonly gradePass: ShaderPass;
  private readonly gtaoExcludeSet = new Set<THREE.Object3D>();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpFwd = new THREE.Vector3();
  private smoothExposureLift = 1.0;
  private aoScale = 0.55;
  public enabled = true;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    width: number,
    height: number
  ) {
    const gl = renderer.getContext();
    const dpr = renderer.getPixelRatio();
    const rtW = Math.max(1, Math.round(width * dpr));
    const rtH = Math.max(1, Math.round(height * dpr));
    const maxSamples =
      'MAX_SAMPLES' in gl
        ? Math.min(4, (gl as WebGL2RenderingContext).getParameter((gl as WebGL2RenderingContext).MAX_SAMPLES) || 0)
        : 0;

    // Allocate renderTarget at FULL native DPR pixel dimensions + up to 4x hardware MSAA (zero motion ghosting)
    const rt = new THREE.WebGLRenderTarget(rtW, rtH, {
      type: THREE.HalfFloatType,
      samples: maxSamples,
    });

    this.composer = new EffectComposer(renderer, rt);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(width, height);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // Clean masked Ground-Truth Ambient Occlusion at 0.55x resolution (~3.3x faster, silky-smooth contact shadows)
    const aoW = Math.max(256, Math.round(rtW * 0.55));
    const aoH = Math.max(256, Math.round(rtH * 0.55));
    this.gtaoPass = new GTAOPass(scene, camera, aoW, aoH);
    this.gtaoPass.updateGtaoMaterial({
      radius: 0.65,
      distanceExponent: 1.6,
      thickness: 0.95,
      distanceFallOff: 0.85,
      scale: 0.92,
      samples: 12,
    });
    this.gtaoPass.updatePdMaterial({
      lumaPhi: 10,
      depthPhi: 2,
      normalPhi: 3,
      radius: 5,
      rings: 2,
      samples: 8,
    });
    this.gtaoPass.output = GTAOPass.OUTPUT.Default;
    this.gtaoPass.blendIntensity = 0.72;

    const origGtaoSetSize = this.gtaoPass.setSize.bind(this.gtaoPass);
    this.gtaoPass.setSize = (w: number, h: number) => {
      origGtaoSetSize(
        Math.max(256, Math.round(w * this.aoScale)),
        Math.max(256, Math.round(h * this.aoScale))
      );
    };

    // Mask out sky dome, clouds, dense wind-animated grass blades, and alpha-cutout canopy quads during AO depth/normal pass
    const excludeSet = this.gtaoExcludeSet;
    const visMap = new Map<THREE.Object3D, boolean>();
    this.gtaoPass.overrideVisibility = () => {
      visMap.clear();
      scene.traverse((object: THREE.Object3D) => {
        visMap.set(object, object.visible);
        if (!object.visible) return;
        const asLineOrPts = object as THREE.Points & THREE.Line;
        if (asLineOrPts.isPoints || asLineOrPts.isLine || excludeSet.has(object)) {
          object.visible = false;
          return;
        }
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh && mesh.material) {
          const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          if (mat && (mat.transparent || mat.alphaTest > 0)) {
            object.visible = false;
          }
        }
      });
    };
    this.gtaoPass.restoreVisibility = () => {
      visMap.forEach((wasVisible, object) => {
        object.visible = wasVisible;
      });
      visMap.clear();
    };
    this.composer.addPass(this.gtaoPass);

    // High-threshold tight bloom so ONLY intense specular glints, ocean sparkle & cloud rims softly glow
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      0.12, // strength
      0.34, // radius
      0.96 // threshold
    );
    this.composer.addPass(this.bloomPass);

    // Linear-HDR depth-gated volumetric sun shafts + tight halation before AgX tone mapping
    this.shaftsPass = new ShaderPass(SUN_SHAFTS_HALATION_SHADER);
    this.shaftsPass.uniforms.uTexelSize.value.set(1 / rtW, 1 / rtH);
    this.shaftsPass.uniforms.uDepthTex.value = this.gtaoPass.depthTexture;
    this.shaftsPass.uniforms.uHasDepth.value = 1.0;
    this.composer.addPass(this.shaftsPass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this.gradePass = new ShaderPass(BROADCAST_GRADE_SHADER);
    this.gradePass.uniforms.uTexelSize.value.set(1 / rtW, 1 / rtH);
    this.gradePass.uniforms.uDepthTex.value = this.gtaoPass.depthTexture;
    this.gradePass.uniforms.uHasDepth.value = 1.0;
    this.gradePass.uniforms.uCameraNear.value = camera.near;
    this.gradePass.uniforms.uCameraFar.value = camera.far;
    this.composer.addPass(this.gradePass);
  }

  public setDepthExcludeObjects(objects: THREE.Object3D[]): void {
    this.gtaoExcludeSet.clear();
    for (const o of objects) {
      if (o) this.gtaoExcludeSet.add(o);
    }
  }

  public updateSun(sunDir: THREE.Vector3, sunColor: THREE.Color): void {
    this.camera.updateMatrixWorld();
    this.tmpFwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const viewAlign = this.tmpFwd.dot(sunDir);

    if (viewAlign <= 0.02) {
      this.shaftsPass.uniforms.uSunVisible.value = 0.0;
      return;
    }

    this.tmpVec.copy(this.camera.position).addScaledVector(sunDir, 1000);
    this.tmpVec.project(this.camera);

    const sx = this.tmpVec.x * 0.5 + 0.5;
    const sy = this.tmpVec.y * 0.5 + 0.5;
    const edgeDist = Math.hypot(sx - 0.5, sy - 0.5);
    const edgeFade = 1.0 - THREE.MathUtils.smoothstep(edgeDist, 0.72, 1.38);
    const alignFade = THREE.MathUtils.smoothstep(viewAlign, 0.04, 0.42);

    this.shaftsPass.uniforms.uSunScreenPos.value.set(sx, sy);
    this.shaftsPass.uniforms.uSunColor.value.copy(sunColor);
    this.shaftsPass.uniforms.uSunVisible.value = alignFade * edgeFade;
  }

  public updateCameraLens(dt: number, focusDistM: number, dofStrength: number, sunElev: number): void {
    this.gradePass.uniforms.uFocusDist.value = Math.max(1.5, focusDistM);
    this.gradePass.uniforms.uDofStrength.value =
      this.gtaoPass.enabled && this.gradePass.uniforms.uDofTaps.value > 0.5 ? dofStrength : 0.0;
    this.gradePass.uniforms.uCameraNear.value = this.camera.near;
    this.gradePass.uniforms.uCameraFar.value = this.camera.far;

    // Gentle smooth eye adaptation across coastal sun elevation (subtle shadow lift in golden hour/twilight)
    const targetLift = sunElev < 0.16 ? 1.04 : sunElev > 0.58 ? 0.985 : 1.0;
    this.smoothExposureLift += (targetLift - this.smoothExposureLift) * (1 - Math.exp(-1.8 * Math.max(0.001, dt)));
    this.gradePass.uniforms.uExposureLift.value = this.smoothExposureLift;
  }

  public setQuality(quality: GraphicsQuality): void {
    const dpr = this.renderer.getPixelRatio();
    const size = this.renderer.getSize(new THREE.Vector2());
    // AO buffer resolution scales with quality (set BEFORE composer resize so setSize picks it up)
    this.aoScale = quality === 'ultra' ? 0.7 : quality === 'high' ? 0.6 : 0.5;
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(size.x, size.y);
    const rtW = Math.max(1, Math.round(size.x * dpr));
    const rtH = Math.max(1, Math.round(size.y * dpr));
    this.shaftsPass.uniforms.uTexelSize.value.set(1 / rtW, 1 / rtH);
    this.gradePass.uniforms.uTexelSize.value.set(1 / rtW, 1 / rtH);

    if (quality === 'medium') {
      // Cheap tier: no AO, no bloom, no volumetric shafts, no 12-tap bokeh. The remaining
      // grade pass is a single 5-tap sharpen+tonemap and costs almost nothing.
      this.gtaoPass.enabled = false;
      this.bloomPass.enabled = false;
      this.shaftsPass.enabled = false;
      this.shaftsPass.uniforms.uHasDepth.value = 0.0;
      this.shaftsPass.uniforms.uStrength.value = 0.45;
      this.gradePass.uniforms.uHasDepth.value = 0.0;
      this.gradePass.uniforms.uDofTaps.value = 0.0;
      this.gradePass.uniforms.uSharpness.value = 0.34;
      this.gradePass.uniforms.uGradeStrength.value = 0.75;
    } else {
      this.gtaoPass.enabled = true;
      this.gtaoPass.updateGtaoMaterial({ samples: quality === 'ultra' ? 16 : 12 });
      this.bloomPass.enabled = true;
      // Creamier highlight roll-off: wider radius + slightly stronger core on ultra
      this.bloomPass.strength = quality === 'ultra' ? 0.17 : 0.11;
      this.bloomPass.radius = quality === 'ultra' ? 0.42 : 0.36;
      this.shaftsPass.uniforms.uHasDepth.value = 1.0;
      this.shaftsPass.uniforms.uStrength.value = quality === 'ultra' ? 1.15 : 0.80;
      this.gradePass.uniforms.uHasDepth.value = 1.0;
      this.gradePass.uniforms.uDofTaps.value = 1.0;
      this.shaftsPass.enabled = true;
      // CAS cannot recover detail that was never sampled, and over-sharpening is exactly
      // what makes procedural grass look crunchy. With the packed KTX2 detail layers doing
      // the work now (per-material relief height, real photographic normals), the sharpener
      // can sit lower and look cleaner.
      this.gradePass.uniforms.uSharpness.value = quality === 'ultra' ? 0.40 : 0.32;
      this.gradePass.uniforms.uGradeStrength.value = 1.0;
    }
  }

  public setSize(width: number, height: number): void {
    const dpr = this.renderer.getPixelRatio();
    const rtW = Math.max(1, Math.round(width * dpr));
    const rtH = Math.max(1, Math.round(height * dpr));
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(width, height);
    this.bloomPass.setSize(width, height);
    this.shaftsPass.uniforms.uTexelSize.value.set(1 / rtW, 1 / rtH);
    this.gradePass.uniforms.uTexelSize.value.set(1 / rtW, 1 / rtH);
  }

  public render(): void {
    if (this.enabled) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  public dispose(): void {
    this.gtaoPass.dispose();
    this.bloomPass.dispose();
    this.composer.dispose();
  }
}
