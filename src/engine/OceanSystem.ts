import * as THREE from 'three';
import type { HoleDefinition } from '../course/types';
import { clamp, smoothstep } from '../course/noise';

const OCEAN_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec2 uWindDir;
  uniform float uWindSpeed;
  uniform sampler2D uCoastMap;
  uniform vec4 uCourseBounds; // minX, maxX, minZ, maxZ
  uniform mat4 uTextureMatrix;

  varying vec3 vWorldPos;
  varying vec3 vWaveNormal;
  varying float vCoastDist;
  varying float vWaveCrest;
  varying vec4 vReflectCoord;

  vec3 gerstnerWave(vec2 pos, vec2 dir, float steepness, float wavelength, float speedScale, inout vec3 tangent, inout vec3 binormal) {
    float k = 6.2831853 / wavelength;
    float c = sqrt(9.81 / k) * speedScale;
    vec2 d = normalize(dir);
    float f = k * (dot(d, pos) - c * uTime);
    float a = steepness / k;

    tangent += vec3(
      -d.x * d.x * (steepness * sin(f)),
      d.x * (steepness * cos(f)),
      -d.x * d.y * (steepness * sin(f))
    );
    binormal += vec3(
      -d.x * d.y * (steepness * sin(f)),
      d.y * (steepness * cos(f)),
      -d.y * d.y * (steepness * sin(f))
    );

    return vec3(
      d.x * (a * cos(f)),
      a * sin(f),
      d.y * (a * cos(f))
    );
  }

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec2 xz = wp.xz;

    // Sample baked coastline distance texture (-60m ocean -> +60m inland mapped to 0..1)
    vec2 cuv = vec2(
      (xz.x - uCourseBounds.x) / (uCourseBounds.y - uCourseBounds.x),
      (xz.y - uCourseBounds.z) / (uCourseBounds.w - uCourseBounds.z)
    );
    float coastEnc = 0.0;
    if (cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0) {
      coastEnc = texture2D(uCoastMap, cuv).r;
    }
    float coastDist = (coastEnc - 0.5) * 140.0; // approx meters (+ inland, - ocean)
    vCoastDist = coastDist;

    // Attenuate swell amplitude slightly very close to shore / underwater terrain
    float shoreFactor = clamp(1.0 - smoothstep(-18.0, 2.0, coastDist), 0.15, 1.0);
    float windBoost = clamp(0.75 + uWindSpeed * 0.035, 0.7, 1.45);

    vec3 tangent = vec3(1.0, 0.0, 0.0);
    vec3 binormal = vec3(0.0, 0.0, 1.0);
    vec3 disp = vec3(0.0);

    vec2 swellDir1 = normalize(vec2(-0.85, 0.52) + uWindDir * 0.25);
    vec2 swellDir2 = normalize(vec2(-0.55, -0.83) + uWindDir * 0.2);
    vec2 swellDir3 = normalize(vec2(0.45, 0.89));

    disp += gerstnerWave(xz, swellDir1, 0.16 * shoreFactor * windBoost, 26.0, 0.85, tangent, binormal);
    disp += gerstnerWave(xz, swellDir2, 0.11 * shoreFactor * windBoost, 15.0, 0.95, tangent, binormal);
    disp += gerstnerWave(xz, swellDir3, 0.07 * shoreFactor * windBoost, 7.5, 1.1, tangent, binormal);

    // Distance fade so distant horizon stays crisp without aliasing
    float distToCam = length(cameraPosition - wp.xyz);
    float distFade = 1.0 - smoothstep(380.0, 1400.0, distToCam);
    wp.xyz += disp * distFade;

    vWorldPos = wp.xyz;
    vWaveNormal = normalize(cross(binormal, tangent));
    vWaveCrest = clamp(disp.y * 1.4, 0.0, 1.0);
    vReflectCoord = uTextureMatrix * vec4(wp.x, 0.0, wp.z, 1.0);

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const OCEAN_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyHorizonColor;
  uniform vec3 uSkyZenithColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform vec2 uCloudOffset;
  uniform float uCloudCoverage;
  uniform vec3 uMistColor;
  uniform float uMistDensity;
  uniform sampler2D uCoastMap;
  uniform vec4 uCourseBounds;
  uniform sampler2D uReflectMap;
  uniform float uHasReflect;

  varying vec3 vWorldPos;
  varying vec3 vWaveNormal;
  varying float vCoastDist;
  varying float vWaveCrest;
  varying vec4 vReflectCoord;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p = p * 2.07 + vec2(17.1, 31.7);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 xz = vWorldPos.xz;
    vec3 V = normalize(cameraPosition - vWorldPos);
    float viewDist = length(cameraPosition - vWorldPos);

    // High-frequency capillary ripple normal perturbation
    float eps = 0.28;
    float r1 = fbm(xz * 0.42 + vec2(uTime * 0.25, -uTime * 0.18)) * 0.65
             + fbm(xz * 1.35 - vec2(uTime * 0.42, uTime * 0.31)) * 0.35;
    float r2 = fbm((xz + vec2(eps, 0.0)) * 0.42 + vec2(uTime * 0.25, -uTime * 0.18)) * 0.65
             + fbm((xz + vec2(eps, 0.0)) * 1.35 - vec2(uTime * 0.42, uTime * 0.31)) * 0.35;
    float r3 = fbm((xz + vec2(0.0, eps)) * 0.42 + vec2(uTime * 0.25, -uTime * 0.18)) * 0.65
             + fbm((xz + vec2(0.0, eps)) * 1.35 - vec2(uTime * 0.42, uTime * 0.31)) * 0.35;

    float rippleFade = 1.0 - smoothstep(120.0, 750.0, viewDist);
    vec3 rippleN = normalize(vec3((r1 - r2) * 1.25 * rippleFade, 1.0, (r1 - r3) * 1.25 * rippleFade));
    vec3 N = normalize(vWaveNormal + vec3(rippleN.x, 0.0, rippleN.z) * 0.65);

    // Sample exact coastline + rock proximity from baked texture
    vec2 cuv = vec2(
      (xz.x - uCourseBounds.x) / (uCourseBounds.y - uCourseBounds.x),
      (xz.y - uCourseBounds.z) / (uCourseBounds.w - uCourseBounds.z)
    );
    float rockMask = 0.0;
    float coastDist = vCoastDist;
    if (cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0) {
      vec4 cm = texture2D(uCoastMap, cuv);
      coastDist = (cm.r - 0.5) * 140.0;
      rockMask = cm.g;
    }

    // Beer-Lambert exponential depth absorption: translucent kelp-sand shallows -> deep Pacific cobalt
    float reefPatch = fbm(xz * 0.09);
    float waterDepth = clamp(-coastDist * 0.42 + (1.0 - reefPatch) * 1.4, 0.25, 16.0);
    vec3 absorption = exp(-waterDepth * vec3(0.42, 0.145, 0.105));
    vec3 seabedTint = mix(vec3(0.18, 0.34, 0.27), vec3(0.32, 0.44, 0.35), reefPatch) * max(uSunDir.y, 0.16);
    vec3 deepScatter = vec3(0.014, 0.088, 0.175);
    vec3 waterBody = mix(deepScatter, mix(vec3(0.04, 0.26, 0.28), seabedTint, 0.42), absorption);

    // Projected moving cloud shadow over Pacific swells (dims direct sun & glint while preserving sky reflection)
    vec2 cloudOceanUv = xz * 0.0042 + uCloudOffset * 1.15 - (uSunDir.xz / max(uSunDir.y + 0.18, 0.25)) * 0.28;
    float cloudDensity = fbm(cloudOceanUv * 1.15);
    float cloudShadow = 1.0 - smoothstep(uCloudCoverage - 0.03, uCloudCoverage + 0.28, cloudDensity) * 0.56;

    // Subsurface sunlight scatter through wave crests
    float sss = pow(clamp(dot(V, -uSunDir + N * 0.45), 0.0, 1.0), 3.2) * (0.35 + 0.65 * vWaveCrest) * cloudShadow;
    waterBody = mix(waterBody * 0.54, waterBody, cloudShadow);
    waterBody += vec3(0.04, 0.30, 0.27) * sss * uSunColor;

    // Schlick Fresnel sky + real-time planar coastal cliff/tree/cloud reflection
    float NdotV = max(dot(N, V), 0.001);
    float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 4.5);
    vec3 R = reflect(-V, N);
    float skyGrad = clamp(R.y * 1.6, 0.0, 1.0);
    vec3 skyReflect = mix(uSkyHorizonColor, uSkyZenithColor, skyGrad);
    vec2 refCloudUv = (R.xz / max(R.y, 0.08)) * 0.65 + uCloudOffset;
    float refCloud = smoothstep(uCloudCoverage - 0.04, uCloudCoverage + 0.26, fbm(refCloudUv * 1.35)) * smoothstep(0.0, 0.22, R.y);
    skyReflect = mix(skyReflect, mix(vec3(0.95, 0.96, 0.98), uSunColor, 0.22), refCloud * 0.55);

    if (uHasReflect > 0.5 && vReflectCoord.w > 0.001) {
      vec2 baseUv = vReflectCoord.xy / vReflectCoord.w;
      float distScale = 0.018 + 0.35 / max(viewDist, 6.0);
      vec2 reflUv = clamp(baseUv + N.xz * distScale, vec2(0.004), vec2(0.996));
      vec3 planarCol = texture2D(uReflectMap, reflUv).rgb;
      float edgeFade = smoothstep(0.0, 0.08, reflUv.x) * smoothstep(1.0, 0.92, reflUv.x)
                     * smoothstep(0.0, 0.08, reflUv.y) * smoothstep(1.0, 0.92, reflUv.y);
      skyReflect = mix(skyReflect, planarCol, edgeFade * 0.92);
    }

    // Crisp sun specular glitter path + fine capillary sparkles across ocean swells
    vec3 H = normalize(uSunDir + V);
    float microSpec = pow(max(dot(N, H), 0.0), 920.0) * 5.2;
    float spec = pow(max(dot(N, H), 0.0), 320.0) * 2.4 + pow(max(dot(N, H), 0.0), 42.0) * 0.24 + microSpec;
    vec3 sunGlint = uSunColor * spec * cloudShadow;

    vec3 col = mix(waterBody, skyReflect, fresnel * 0.88) + sunGlint;

    // Animated Lacy Surf Whitewater Foam surging against cliffs & sea stacks!
    float foamNoise = fbm(xz * 0.18 + vec2(uTime * 0.22, uTime * 0.14));
    float detailFoam = fbm(xz * 0.88 - vec2(uTime * 0.35, 0.0));
    float lacyFoam = fbm(xz * 2.4 + vec2(uTime * 0.2, -uTime * 0.15));
    float surfWave = sin(coastDist * 0.72 + uTime * 2.1 + foamNoise * 3.8);
    float shoreLine = smoothstep(-18.0, -1.5, coastDist);
    float shoreFoam = shoreLine * smoothstep(0.24, 0.82, surfWave * 0.42 + detailFoam * 0.75 + lacyFoam * 0.28 + shoreLine * 0.32);

    // Foam ring around offshore sea rocks
    float rockSurf = rockMask * smoothstep(0.28, 0.76, detailFoam + 0.25 * sin(uTime * 2.4 + foamNoise * 4.0));
    // Occasional offshore whitecaps in windy conditions
    float whitecap = smoothstep(0.68, 0.98, vWaveCrest + detailFoam * 0.35) * 0.45;

    float totalFoam = clamp(max(shoreFoam, rockSurf) + whitecap, 0.0, 1.0);
    totalFoam *= smoothstep(0.18, 0.52, lacyFoam + shoreLine * 0.55);
    vec3 foamColor = mix(vec3(0.84, 0.90, 0.93), vec3(0.98, 0.99, 1.0), detailFoam) * (0.50 + 0.65 * max(uSunDir.y, 0.15) * (0.5 + 0.5 * cloudShadow));
    col = mix(col, foamColor, totalFoam * 0.90);
    // Match HDR scale for AgXToneMapping OutputPass at ~0.50 exposure
    col *= 1.32;

    // Coastal sea-level marine mist + exponential atmospheric horizon haze
    float seaMist = clamp(1.0 - exp(-viewDist * uMistDensity * 1.45), 0.0, 0.56);
    col = mix(col, uMistColor, seaMist);
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * viewDist * viewDist);
    col = mix(col, uFogColor * 1.12, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class OceanSystem {
  public readonly mesh: THREE.Mesh;
  public readonly material: THREE.ShaderMaterial;
  private coastTexture: THREE.DataTexture | null = null;
  private reflectRT: THREE.WebGLRenderTarget;
  private reflectCam = new THREE.PerspectiveCamera();
  private textureMatrix = new THREE.Matrix4();
  public planarReflectionEnabled = true;

  /** Re-allocates the planar-reflection render target (quality ladder: 384 low / 768 high / 1024 ultra). */
  public setReflectionResolution(size: number): void {
    const s = Math.max(256, Math.min(1024, Math.round(size)));
    if (this.reflectRT.width === s) return;
    this.reflectRT.dispose();
    this.reflectRT = new THREE.WebGLRenderTarget(s, s, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    this.material.uniforms.uReflectMap.value = this.reflectRT.texture;
  }

  // Scratch vectors/matrices for zero-GC planar reflection matrix calculation
  private readonly _mirrorPos = new THREE.Vector3(0, 0, 0);
  private readonly _mirrorNormal = new THREE.Vector3(0, 1, 0);
  private readonly _camPos = new THREE.Vector3();
  private readonly _view = new THREE.Vector3();
  private readonly _target = new THREE.Vector3();
  private readonly _lookAt = new THREE.Vector3();
  private readonly _rotMat = new THREE.Matrix4();
  private readonly _mirrorPlane = new THREE.Plane();
  private readonly _clipPlane = new THREE.Vector4();
  private readonly _q = new THREE.Vector4();

  constructor(private readonly scene: THREE.Scene) {
    // Dense near coastline (-550..+200m), broad horizon out to 2600m
    const geo = new THREE.PlaneGeometry(2800, 2800, 180, 180);
    geo.rotateX(-Math.PI / 2);

    this.reflectRT = new THREE.WebGLRenderTarget(512, 512, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });

    this.material = new THREE.ShaderMaterial({
      vertexShader: OCEAN_VERTEX_SHADER,
      fragmentShader: OCEAN_FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uWindDir: { value: new THREE.Vector2(0.7, -0.7) },
        uWindSpeed: { value: 5.0 },
        uCoastMap: { value: null },
        uCourseBounds: { value: new THREE.Vector4(-150, 150, -560, 80) },
        uTextureMatrix: { value: this.textureMatrix },
        uReflectMap: { value: this.reflectRT.texture },
        uHasReflect: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.5, 0.7, -0.4).normalize() },
        uSunColor: { value: new THREE.Color(0xfff5e0) },
        uSkyHorizonColor: { value: new THREE.Color(0xbcd8eb) },
        uSkyZenithColor: { value: new THREE.Color(0x3a6e9e) },
        uFogColor: { value: new THREE.Color(0xc2dced) },
        uFogDensity: { value: 0.00075 },
        uCloudOffset: { value: new THREE.Vector2() },
        uCloudCoverage: { value: 0.49 },
        uMistColor: { value: new THREE.Color(0xc0d9eb) },
        uMistDensity: { value: 0.0045 },
      },
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.set(0, 0, -240);
    this.mesh.receiveShadow = false;
    this.scene.add(this.mesh);
  }

  public updatePlanarReflection(
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    hiddenObjects: THREE.Object3D[]
  ): void {
    if (!this.planarReflectionEnabled) {
      this.material.uniforms.uHasReflect.value = 0;
      return;
    }

    camera.updateMatrixWorld();
    this._camPos.setFromMatrixPosition(camera.matrixWorld);
    this._view.subVectors(this._mirrorPos, this._camPos);
    if (this._view.dot(this._mirrorNormal) > -0.05) {
      this.material.uniforms.uHasReflect.value = 0;
      return;
    }

    this._view.reflect(this._mirrorNormal).negate().add(this._mirrorPos);
    this._rotMat.extractRotation(camera.matrixWorld);
    this._lookAt.set(0, 0, -1).applyMatrix4(this._rotMat).add(this._camPos);
    this._target.subVectors(this._mirrorPos, this._lookAt).reflect(this._mirrorNormal).negate().add(this._mirrorPos);

    this.reflectCam.position.copy(this._view);
    this.reflectCam.up.set(0, 1, 0).applyMatrix4(this._rotMat).reflect(this._mirrorNormal);
    this.reflectCam.lookAt(this._target);
    this.reflectCam.fov = camera.fov;
    this.reflectCam.aspect = camera.aspect;
    this.reflectCam.near = camera.near;
    this.reflectCam.far = camera.far;
    this.reflectCam.updateMatrixWorld();
    this.reflectCam.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0
    );
    this.textureMatrix.multiply(this.reflectCam.projectionMatrix);
    this.textureMatrix.multiply(this.reflectCam.matrixWorldInverse);

    // Oblique near-plane clipping at y = 0 water plane (Lengyel)
    this._mirrorPlane.setFromNormalAndCoplanarPoint(this._mirrorNormal, this._mirrorPos);
    this._mirrorPlane.applyMatrix4(this.reflectCam.matrixWorldInverse);
    this._clipPlane.set(
      this._mirrorPlane.normal.x,
      this._mirrorPlane.normal.y,
      this._mirrorPlane.normal.z,
      this._mirrorPlane.constant
    );
    const proj = this.reflectCam.projectionMatrix;
    this._q.x = (Math.sign(this._clipPlane.x) + proj.elements[8]) / proj.elements[0];
    this._q.y = (Math.sign(this._clipPlane.y) + proj.elements[9]) / proj.elements[5];
    this._q.z = -1.0;
    this._q.w = (1.0 + proj.elements[10]) / proj.elements[14];
    this._clipPlane.multiplyScalar(2.0 / this._clipPlane.dot(this._q));
    proj.elements[2] = this._clipPlane.x;
    proj.elements[6] = this._clipPlane.y;
    proj.elements[10] = this._clipPlane.z + 1.0;
    proj.elements[14] = this._clipPlane.w;

    const prevRT = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;

    const prevStates: boolean[] = [];
    this.mesh.visible = false;
    for (let i = 0; i < hiddenObjects.length; i++) {
      prevStates.push(hiddenObjects[i].visible);
      hiddenObjects[i].visible = false;
    }

    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.reflectRT);
    renderer.state.buffers.depth.setMask(true);
    renderer.clear();
    renderer.render(this.scene, this.reflectCam);

    this.mesh.visible = true;
    for (let i = 0; i < hiddenObjects.length; i++) {
      hiddenObjects[i].visible = prevStates[i];
    }
    renderer.xr.enabled = prevXr;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.setRenderTarget(prevRT);

    this.material.uniforms.uHasReflect.value = 1;
  }

  public configureForHole(hole: HoleDefinition): void {
    if (this.coastTexture) this.coastTexture.dispose();

    const w = 256;
    const h = 256;
    const data = new Uint8Array(w * h * 4);
    const { minX, maxX, minZ, maxZ } = hole.bounds;
    // Pad bounds generously so offshore surf transitions smoothly
    const pMinX = minX - 60;
    const pMaxX = maxX + 60;
    const pMinZ = minZ - 60;
    const pMaxZ = maxZ + 60;

    for (let iy = 0; iy < h; iy++) {
      const v = (iy + 0.5) / h;
      const z = pMinZ + v * (pMaxZ - pMinZ);
      for (let ix = 0; ix < w; ix++) {
        const u = (ix + 0.5) / w;
        const x = pMinX + u * (pMaxX - pMinX);

        const coastDist = hole.coastlineSignedDist(x, z);
        const encCoast = clamp(coastDist / 140 + 0.5, 0, 1);

        let rockRing = 0;
        for (const rock of hole.seaRocks) {
          const d = Math.hypot(x - rock.x, z - rock.z) - rock.radius;
          if (d < 5.5) {
            rockRing = Math.max(rockRing, 1 - smoothstep(-0.5, 5.5, d));
          }
        }

        const idx = (iy * w + ix) * 4;
        data[idx] = Math.round(encCoast * 255);
        data[idx + 1] = Math.round(rockRing * 255);
        data[idx + 2] = 0;
        data[idx + 3] = 255;
      }
    }

    this.coastTexture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    this.coastTexture.minFilter = THREE.LinearFilter;
    this.coastTexture.magFilter = THREE.LinearFilter;
    this.coastTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.coastTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.coastTexture.needsUpdate = true;

    this.material.uniforms.uCoastMap.value = this.coastTexture;
    this.material.uniforms.uCourseBounds.value.set(pMinX, pMaxX, pMinZ, pMaxZ);

    // Center ocean mesh around hole center
    this.mesh.position.set((pMinX + pMaxX) * 0.5, 0, (pMinZ + pMaxZ) * 0.5);
  }

  public update(
    timeS: number,
    windSpeedMps: number,
    windDirRad: number,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    fogColor: THREE.Color,
    fogDensity: number,
    cloudOffset?: THREE.Vector2,
    cloudCoverage?: number,
    mistColor?: THREE.Color,
    mistDensity?: number
  ): void {
    const u = this.material.uniforms;
    u.uTime.value = timeS;
    u.uWindSpeed.value = windSpeedMps;
    u.uWindDir.value.set(Math.sin(windDirRad), -Math.cos(windDirRad));
    u.uSunDir.value.copy(sunDir).normalize();
    u.uSunColor.value.copy(sunColor);
    u.uFogColor.value.copy(fogColor);
    u.uFogDensity.value = fogDensity;
    if (cloudOffset) u.uCloudOffset.value.copy(cloudOffset);
    if (cloudCoverage !== undefined) u.uCloudCoverage.value = cloudCoverage;
    if (mistColor) u.uMistColor.value.copy(mistColor);
    if (mistDensity !== undefined) u.uMistDensity.value = mistDensity;
    // Derive horizon & zenith tint smoothly from sun elevation
    const sunElev = clamp(sunDir.y, 0.02, 1);
    u.uSkyHorizonColor.value.copy(fogColor);
    u.uSkyZenithColor.value
      .setRGB(0.14, 0.34, 0.58)
      .lerp(fogColor, 1 - smoothstep(0.05, 0.45, sunElev) * 0.75);
  }

  public dispose(): void {
    if (this.coastTexture) this.coastTexture.dispose();
    this.reflectRT.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
