import * as THREE from 'three';

function hash2(x: number, y: number, seed = 17): number {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function tileNoise(u: number, v: number, period: number, seed = 17): number {
  const x = u * period;
  const y = v * period;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y0 = ((iy % period) + period) % period;
  const y1 = (y0 + 1) % period;

  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uy;
}

function tileFbm(u: number, v: number, basePeriod: number, octaves: number, seed = 17): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = basePeriod;
  for (let i = 0; i < octaves; i++) {
    sum += amp * tileNoise(u, v, p, seed + i * 71);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

function heightBufferToNormalTexture(
  heights: Float32Array,
  width: number,
  height: number,
  strength: number
): THREE.DataTexture {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const ym = (y - 1 + height) % height;
    const yp = (y + 1) % height;
    for (let x = 0; x < width; x++) {
      const xm = (x - 1 + width) % width;
      const xp = (x + 1) % width;

      const hL = heights[y * width + xm];
      const hR = heights[y * width + xp];
      const hD = heights[ym * width + x];
      const hU = heights[yp * width + x];

      const dx = (hL - hR) * strength;
      const dy = (hD - hU) * strength;
      const dz = 1.0;
      const inv = 1 / Math.hypot(dx, dy, dz);

      const idx = (y * width + x) * 4;
      data[idx] = Math.round((dx * inv * 0.5 + 0.5) * 255);
      data[idx + 1] = Math.round((dy * inv * 0.5 + 0.5) * 255);
      data[idx + 2] = Math.round((dz * inv * 0.5 + 0.5) * 255);
      data[idx + 3] = Math.round(Math.min(1, Math.max(0, heights[y * width + x])) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export interface CourseTextureSet {
  maxAnisotropy: number;
  ballAlbedo: THREE.CanvasTexture;
  ballNormal: THREE.DataTexture;
  grassDetailMap: THREE.DataTexture;
  grassNormal: THREE.DataTexture;
  sandNormal: THREE.DataTexture;
  rockNormal: THREE.DataTexture;
  cypressFoliageMap: THREE.CanvasTexture;
  pineFoliageMap: THREE.CanvasTexture;
  barkMap: THREE.DataTexture;
  barkNormal: THREE.DataTexture;
  carbonWeaveMap: THREE.CanvasTexture;
  skinAlbedo: THREE.CanvasTexture;
  skinNormal: THREE.DataTexture;
  poloAlbedo: THREE.CanvasTexture;
  trouserAlbedo: THREE.CanvasTexture;
  fabricNormal: THREE.DataTexture;
  leatherNormal: THREE.DataTexture;
  dispose: () => void;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967295;
  };
}

/**
 * Generates high-precision procedural PBR maps:
 *  - 336-dimple Fibonacci sphere golf ball normal map + Tour Pro stamp albedo
 *  - 512px anisotropic bentgrass/turf, silica sand, and coastal granite cliff normal maps
 *  - Feathery layered Monterey cypress foliage spray & grooved bark + bark normal maps
 *  - Carbon-fiber driver crown weave, human skin pore normal, and piqué knit fabric normal maps
 */
export function createCourseTextures(maxAnisotropy = 8): CourseTextureSet {
  // 1. Golf Ball 336-Dimple Fibonacci Lattice Normal Map (512 x 256)
  const bw = 512;
  const bh = 256;
  const dimpleCount = 336;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const centers: Array<[number, number, number]> = [];
  for (let i = 0; i < dimpleCount; i++) {
    const y = 1 - ((i + 0.5) / dimpleCount) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * i;
    centers.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
  }

  const ballHeights = new Float32Array(bw * bh);
  const dimpleAngularRadius = 0.096; // ~3.9 mm radius on 21.3 mm ball
  for (let py = 0; py < bh; py++) {
    const v = (py + 0.5) / bh;
    const phi = v * Math.PI;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let px = 0; px < bw; px++) {
      const u = (px + 0.5) / bw;
      const theta = u * Math.PI * 2;
      const sx = sinPhi * Math.cos(theta);
      const sy = cosPhi;
      const sz = sinPhi * Math.sin(theta);

      let maxDot = -1;
      for (let k = 0; k < dimpleCount; k++) {
        const c = centers[k];
        const dot = sx * c[0] + sy * c[1] + sz * c[2];
        if (dot > maxDot) maxDot = dot;
      }
      const ang = Math.acos(Math.min(1, Math.max(-1, maxDot)));
      let h = 1.0;
      if (ang < dimpleAngularRadius) {
        const t = ang / dimpleAngularRadius;
        // Smooth concave spherical dimple dish with rounded lip
        h = 1.0 - 0.85 * Math.pow(1 - t * t, 1.4);
      }
      ballHeights[py * bw + px] = h;
    }
  }
  const ballNormal = heightBufferToNormalTexture(ballHeights, bw, bh, 3.4);

  // Golf Ball Albedo with subtle Tour alignment side-stamp & warm pearl urethane tint
  const ballCanvas = document.createElement('canvas');
  ballCanvas.width = 512;
  ballCanvas.height = 256;
  const bctx = ballCanvas.getContext('2d')!;
  bctx.fillStyle = '#f8f8f4';
  bctx.fillRect(0, 0, 512, 256);
  // Subtle micro-speckle for pearl urethane finish
  for (let i = 0; i < 1800; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 256;
    bctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(225,228,220,0.16)';
    bctx.fillRect(x, y, 2, 2);
  }
  // Tour alignment line + brand stamp
  bctx.strokeStyle = '#1d3a2f';
  bctx.lineWidth = 3;
  bctx.beginPath();
  bctx.moveTo(222, 128);
  bctx.lineTo(290, 128);
  bctx.stroke();
  bctx.fillStyle = '#18242e';
  bctx.font = 'bold 14px Georgia, serif';
  bctx.textAlign = 'center';
  bctx.fillText('LINKS PRO', 256, 114);
  const ballAlbedo = new THREE.CanvasTexture(ballCanvas);
  ballAlbedo.colorSpace = THREE.SRGBColorSpace;
  ballAlbedo.anisotropy = maxAnisotropy;
  ballNormal.anisotropy = maxAnisotropy;

  // 2. 1024x1024 Seamless High-Definition Turf Blade Height, Pigment & Normal Maps
  // Synthesizes 24,000 overlapping individual curved bentgrass/ryegrass blades + root thatch
  const gw = 1024;
  const gwMask = gw - 1;
  const grassH = new Float32Array(gw * gw);
  const grassPigment = new Float32Array(gw * gw);
  const grassThatch = new Float32Array(gw * gw);

  // Base organic thatch & root soil bed
  for (let y = 0; y < gw; y++) {
    const v = y / gw;
    for (let x = 0; x < gw; x++) {
      const u = x / gw;
      const soil = tileFbm(u, v, 32, 3, 103) * 0.24 + tileNoise(u, v, 128, 207) * 0.14;
      const idx = y * gw + x;
      grassH[idx] = soil;
      grassPigment[idx] = 0.56 + soil * 0.45;
      grassThatch[idx] = 0.35 + tileNoise(u, v, 96, 251) * 0.50;
    }
  }

  // Stamp 24,000 seamless curved grass blades with central leaf midrib ridge & per-blade chlorophyll variation
  const gRng = makeRng(314159);
  for (let i = 0; i < 24000; i++) {
    const x0 = gRng() * gw;
    const y0 = gRng() * gw;
    const ang = gRng() * Math.PI * 2;
    const curve = (gRng() - 0.5) * 0.95;
    const len = 10 + gRng() * 20;
    const halfW = 1.1 + gRng() * 1.35;
    const baseH = 0.42 + gRng() * 0.56;
    const bladePig = 0.68 + gRng() * 0.58;
    const isDryTip = gRng() > 0.86 ? 0.65 + gRng() * 0.35 : 0.08 + gRng() * 0.18;

    const steps = Math.ceil(len * 1.4);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const curAng = ang + curve * t;
      const cx = x0 + Math.cos(ang + curve * 0.45 * t) * len * t;
      const cy = y0 + Math.sin(ang + curve * 0.45 * t) * len * t;
      const nx = -Math.sin(curAng);
      const ny = Math.cos(curAng);
      const wHere = halfW * (1.0 - t * 0.78);
      const hSpine = baseH * (0.28 + 0.72 * Math.sin(t * Math.PI * 0.62));
      const rSpan = Math.ceil(wHere + 0.5);

      for (let d = -rSpan; d <= rSpan; d++) {
        const distNorm = Math.abs(d) / Math.max(0.45, wHere);
        if (distNorm > 1.0) continue;
        // Crisp leaf V-ridge profile (high at midrib center, crisp edge rolloff)
        const profile = (1.0 - distNorm * distNorm) * (1.0 - 0.15 * distNorm);
        const hVal = hSpine * profile;
        const px = Math.floor(cx + nx * d) & gwMask;
        const py = Math.floor(cy + ny * d) & gwMask;
        const pIdx = py * gw + px;
        if (hVal > grassH[pIdx]) {
          grassH[pIdx] = hVal;
          grassPigment[pIdx] = bladePig * (0.86 + 0.24 * t);
          grassThatch[pIdx] = isDryTip * t;
        }
      }
    }
  }

  const grassDetailBytes = new Uint8Array(gw * gw * 4);
  for (let i = 0; i < gw * gw; i++) {
    const o = i * 4;
    grassDetailBytes[o] = Math.round(Math.min(1, Math.max(0, grassH[i])) * 255);
    grassDetailBytes[o + 1] = Math.round(Math.min(1, Math.max(0, grassPigment[i] / 1.32)) * 255);
    grassDetailBytes[o + 2] = Math.round(Math.min(1, Math.max(0, grassThatch[i])) * 255);
    grassDetailBytes[o + 3] = 255;
  }
  const grassDetailMap = new THREE.DataTexture(grassDetailBytes, gw, gw, THREE.RGBAFormat);
  grassDetailMap.wrapS = THREE.RepeatWrapping;
  grassDetailMap.wrapT = THREE.RepeatWrapping;
  grassDetailMap.generateMipmaps = true;
  grassDetailMap.minFilter = THREE.LinearMipmapLinearFilter;
  grassDetailMap.magFilter = THREE.LinearFilter;
  grassDetailMap.anisotropy = maxAnisotropy;
  grassDetailMap.colorSpace = THREE.NoColorSpace;
  grassDetailMap.needsUpdate = true;

  const grassNormal = heightBufferToNormalTexture(grassH, gw, gw, 4.4);
  grassNormal.anisotropy = maxAnisotropy;

  // 3. Raked Coastal Bunker Sand Normal Map (512 x 512 tileable)
  const sw = 512;
  const sandH = new Float32Array(sw * sw);
  for (let y = 0; y < sw; y++) {
    for (let x = 0; x < sw; x++) {
      const u = x / sw;
      const v = y / sw;
      const rake = Math.sin((u * 12 + 0.35 * tileNoise(u, v, 4, 88)) * Math.PI * 2) * 0.5 + 0.5;
      const grain = tileFbm(u, v, 72, 3, 309);
      const sparkle = tileNoise(u, v, 210, 331);
      sandH[y * sw + x] = rake * 0.54 + grain * 0.32 + sparkle * 0.14;
    }
  }
  const sandNormal = heightBufferToNormalTexture(sandH, sw, sw, 3.0);
  sandNormal.anisotropy = maxAnisotropy;

  // 4. Stratified Coastal Cliff Rock Normal Map (512 x 512 tileable)
  const rw = 512;
  const rockH = new Float32Array(rw * rw);
  for (let y = 0; y < rw; y++) {
    for (let x = 0; x < rw; x++) {
      const u = x / rw;
      const v = y / rw;
      const strata = Math.sin((v * 10 + tileFbm(u, v, 6, 3, 505) * 1.6) * Math.PI * 2) * 0.5 + 0.5;
      const crag = tileFbm(u, v, 16, 4, 607);
      const grit = tileNoise(u, v, 128, 619);
      rockH[y * rw + x] = strata * 0.42 + crag * 0.46 + grit * 0.12;
    }
  }
  const rockNormal = heightBufferToNormalTexture(rockH, rw, rw, 4.8);
  rockNormal.anisotropy = maxAnisotropy;

  // 5. High-Res 1024x1024 Monterey Cypress Scale-Leaf Spray Texture (woody twig core + feathery scale-needle fans)
  const fRng = makeRng(4242);
  const fw = 1024;
  const fCanvas = document.createElement('canvas');
  fCanvas.width = fw;
  fCanvas.height = fw;
  const fctx = fCanvas.getContext('2d')!;
  fctx.clearRect(0, 0, fw, fw);

  // Woody interior twig ribs peeking cleanly through dense cypress foliage pads
  fctx.strokeStyle = '#3b2f24';
  fctx.lineCap = 'round';
  for (let b = 0; b < 14; b++) {
    const bAng = (b / 14) * Math.PI * 2 + (fRng() - 0.5) * 0.35;
    const bLen = 190 + fRng() * 170;
    fctx.lineWidth = 5 + fRng() * 5;
    fctx.beginPath();
    fctx.moveTo(fw * 0.5, fw * 0.5);
    fctx.lineTo(fw * 0.5 + Math.cos(bAng) * bLen, fw * 0.5 + Math.sin(bAng) * bLen * 0.88);
    fctx.stroke();
  }

  // Deep shaded inner core pads so foliage silhouette stays lush without flat holes
  for (let p = 0; p < 85; p++) {
    const ang = fRng() * Math.PI * 2;
    const rad = Math.pow(fRng(), 0.72) * 330;
    const px = 512 + Math.cos(ang) * rad;
    const py = 512 + Math.sin(ang) * rad * 0.88;
    const r = 24 + fRng() * 44;
    const grad = fctx.createRadialGradient(px, py, 3, px, py, r);
    grad.addColorStop(0, 'rgba(20, 42, 22, 0.88)');
    grad.addColorStop(1, 'rgba(20, 42, 22, 0.0)');
    fctx.fillStyle = grad;
    fctx.beginPath();
    fctx.arc(px, py, r, 0, Math.PI * 2);
    fctx.fill();
  }

  // Thousands of fine feathery scale-needle fans with core-to-tip chlorophyll gradient
  const fColors = ['#152b17', '#1d3c1f', '#274d26', '#325f2d', '#447235', '#58823c'];
  for (let i = 0; i < 6400; i++) {
    const ang = fRng() * Math.PI * 2;
    const rad = Math.pow(fRng(), 0.64) * 445;
    const cx = 512 + Math.cos(ang) * rad;
    const cy = 512 + Math.sin(ang) * rad * 0.86;
    const len = 18 + fRng() * 42;
    const nAng = ang + (fRng() - 0.5) * 1.35;
    const tipBoost = rad > 280 && fRng() > 0.35 ? 4 + (i % 2) : i % (fColors.length - 1);
    fctx.strokeStyle = fColors[Math.min(fColors.length - 1, tipBoost)];
    fctx.lineWidth = 2.6 + fRng() * 3.8;
    fctx.lineCap = 'round';
    fctx.beginPath();
    fctx.moveTo(cx, cy);
    fctx.lineTo(cx + Math.cos(nAng) * len, cy + Math.sin(nAng) * len);
    fctx.stroke();
  }
  const cypressFoliageMap = new THREE.CanvasTexture(fCanvas);
  cypressFoliageMap.colorSpace = THREE.SRGBColorSpace;
  cypressFoliageMap.anisotropy = maxAnisotropy;

  // 5b. High-Res 1024x1024 Monterey Pine Long-Needle Fascicle Texture (spiky radiating needles + woody shoots)
  const pRng = makeRng(9191);
  const pCanvas = document.createElement('canvas');
  pCanvas.width = fw;
  pCanvas.height = fw;
  const pfctx = pCanvas.getContext('2d')!;
  pfctx.clearRect(0, 0, fw, fw);

  // Branching warm reddish-brown pine twigs & cones
  pfctx.strokeStyle = '#4e3525';
  pfctx.lineCap = 'round';
  for (let b = 0; b < 16; b++) {
    const bAng = (b / 16) * Math.PI * 2 + (pRng() - 0.5) * 0.35;
    const bLen = 175 + pRng() * 210;
    const ex = 512 + Math.cos(bAng) * bLen;
    const ey = 512 + Math.sin(bAng) * bLen * 0.90;
    pfctx.lineWidth = 4.5 + pRng() * 4.5;
    pfctx.beginPath();
    pfctx.moveTo(512, 512);
    pfctx.lineTo(ex, ey);
    pfctx.stroke();
    if (pRng() > 0.65) {
      pfctx.fillStyle = '#5c4129';
      pfctx.beginPath();
      pfctx.arc(ex * 0.85 + 512 * 0.15, ey * 0.85 + 512 * 0.15, 9 + pRng() * 5, 0, Math.PI * 2);
      pfctx.fill();
    }
  }

  // Radiating spiky 3-needle fascicle starbursts (distinct airy Monterey/Torrey Pine silhouette)
  const pineColors = ['#122916', '#1b3b1e', '#264f25', '#34642d', '#487635', '#5f8640'];
  for (let f = 0; f < 460; f++) {
    const ang = pRng() * Math.PI * 2;
    const rad = Math.pow(pRng(), 0.68) * 410;
    const fx = 512 + Math.cos(ang) * rad;
    const fy = 512 + Math.sin(ang) * rad * 0.90;
    const needles = 9 + Math.floor(pRng() * 8);
    const isOuter = rad > 250;
    for (let n = 0; n < needles; n++) {
      const nAng = ang + (pRng() - 0.5) * 2.2;
      const nLen = 32 + pRng() * 54;
      const colIdx = isOuter && pRng() > 0.4 ? 4 + (n % 2) : (f + n) % 4;
      pfctx.strokeStyle = pineColors[colIdx];
      pfctx.lineWidth = 1.8 + pRng() * 1.9;
      pfctx.beginPath();
      pfctx.moveTo(fx, fy);
      pfctx.lineTo(fx + Math.cos(nAng) * nLen, fy + Math.sin(nAng) * nLen);
      pfctx.stroke();
    }
  }
  const pineFoliageMap = new THREE.CanvasTexture(pCanvas);
  pineFoliageMap.colorSpace = THREE.SRGBColorSpace;
  pineFoliageMap.anisotropy = maxAnisotropy;

  // 6. 1024x1024 Deeply Furrowed Coastal Cypress & Pine Bark Albedo + Matching Normal Map
  const bkW = 1024;
  const barkH = new Float32Array(bkW * bkW);
  const barkBytes = new Uint8Array(bkW * bkW * 4);
  for (let y = 0; y < bkW; y++) {
    const v = y / bkW;
    for (let x = 0; x < bkW; x++) {
      const u = x / bkW;
      // Twisting helical vertical bark plates + deep dark crevices + weathered coastal sage lichen specks
      const warp = tileFbm(u, v * 0.5, 6, 2, 907) * 0.14;
      const plate = tileFbm(u + warp, v * 0.28, 18, 3, 911);
      const crevice = Math.pow(Math.abs(Math.sin((u + warp * 1.6) * Math.PI * 26)), 0.52);
      const fiber = tileNoise(u * 2.0, v * 0.45, 96, 929);
      const lichenMask = Math.max(0, (tileFbm(u, v, 10, 2, 953) - 0.63) * 3.0);
      const h = Math.min(1, Math.max(0, plate * 0.58 * crevice + fiber * 0.24 + 0.14));
      barkH[y * bkW + x] = h;

      // Full dynamic range: dark cinnamon-umber cracks (52) -> warm cedar mid-plates -> salt-bleached silver crests (216)
      const ridgeShade = 0.65 + h * 1.18;
      let r = 88 * ridgeShade + (h > 0.56 ? (h - 0.56) * 145 : 0);
      let g = 75 * ridgeShade + (h > 0.56 ? (h - 0.56) * 142 : 0);
      let b = 64 * ridgeShade + (h > 0.56 ? (h - 0.56) * 138 : 0);
      // Warm reddish-brown fissure undertone inside deep grooves
      if (h < 0.36) {
        r += (0.36 - h) * 65;
        g += (0.36 - h) * 22;
      }
      // Pale sea-sage coastal lichen patches on bark ridges
      if (lichenMask > 0.05 && h > 0.45) {
        const lMix = Math.min(0.68, lichenMask);
        r = r * (1 - lMix) + 178 * lMix;
        g = g * (1 - lMix) + 194 * lMix;
        b = b * (1 - lMix) + 150 * lMix;
      }
      const o = (y * bkW + x) * 4;
      barkBytes[o] = Math.round(Math.min(255, Math.max(0, r)));
      barkBytes[o + 1] = Math.round(Math.min(255, Math.max(0, g)));
      barkBytes[o + 2] = Math.round(Math.min(255, Math.max(0, b)));
      barkBytes[o + 3] = 255;
    }
  }
  const barkMap = new THREE.DataTexture(barkBytes, bkW, bkW, THREE.RGBAFormat);
  barkMap.wrapS = THREE.RepeatWrapping;
  barkMap.wrapT = THREE.RepeatWrapping;
  barkMap.generateMipmaps = true;
  barkMap.minFilter = THREE.LinearMipmapLinearFilter;
  barkMap.magFilter = THREE.LinearFilter;
  barkMap.colorSpace = THREE.SRGBColorSpace;
  barkMap.anisotropy = maxAnisotropy;
  barkMap.needsUpdate = true;

  const barkNormal = heightBufferToNormalTexture(barkH, bkW, bkW, 4.6);
  barkNormal.anisotropy = maxAnisotropy;

  // 6b. Woven Carbon-Fiber Crown Texture for Titanium Driver/Wood Heads
  const carbCanvas = document.createElement('canvas');
  carbCanvas.width = 128;
  carbCanvas.height = 128;
  const cCtx = carbCanvas.getContext('2d')!;
  cCtx.fillStyle = '#14181f';
  cCtx.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 8) {
    for (let x = 0; x < 128; x += 8) {
      cCtx.fillStyle = ((x + y) / 8) % 2 === 0 ? '#1d242e' : '#10141a';
      cCtx.fillRect(x, y, 7, 7);
    }
  }
  const carbonWeaveMap = new THREE.CanvasTexture(carbCanvas);
  carbonWeaveMap.wrapS = THREE.RepeatWrapping;
  carbonWeaveMap.wrapT = THREE.RepeatWrapping;
  carbonWeaveMap.repeat.set(6, 6);
  carbonWeaveMap.anisotropy = maxAnisotropy;
  carbonWeaveMap.colorSpace = THREE.SRGBColorSpace;

  // 7. High-Definition 512px Human Skin Albedo & Multi-Scale Dermal Pore Normal Map
  const skinW = 512;
  const skinCanvas = document.createElement('canvas');
  skinCanvas.width = skinW;
  skinCanvas.height = skinW;
  const skCtx = skinCanvas.getContext('2d')!;
  const skImg = skCtx.createImageData(skinW, skinW);
  const skinH = new Float32Array(skinW * skinW);
  for (let y = 0; y < skinW; y++) {
    for (let x = 0; x < skinW; x++) {
      const u = x / skinW;
      const v = y / skinW;
      const toneVar = tileFbm(u, v, 8, 3, 701);
      const pore = tileNoise(u, v, 96, 733);
      const micro = tileNoise(u, v, 192, 751);
      const crease = Math.sin((u * 0.7 + v) * Math.PI * 36) * 0.14;
      skinH[y * skinW + x] = pore * 0.50 + micro * 0.36 + crease;
      const idx = (y * skinW + x) * 4;
      skImg.data[idx] = Math.round(212 + (toneVar - 0.5) * 20 - pore * 6);
      skImg.data[idx + 1] = Math.round(161 + (toneVar - 0.5) * 18 - micro * 6);
      skImg.data[idx + 2] = Math.round(131 + (toneVar - 0.5) * 14 - pore * 5);
      skImg.data[idx + 3] = 255;
    }
  }
  skCtx.putImageData(skImg, 0, 0);
  const skinAlbedo = new THREE.CanvasTexture(skinCanvas);
  skinAlbedo.wrapS = THREE.RepeatWrapping;
  skinAlbedo.wrapT = THREE.RepeatWrapping;
  skinAlbedo.anisotropy = maxAnisotropy;
  skinAlbedo.colorSpace = THREE.SRGBColorSpace;
  const skinNormal = heightBufferToNormalTexture(skinH, skinW, skinW, 1.15);
  skinNormal.anisotropy = maxAnisotropy;

  // 8. High-Definition 512px Piqué Knit Polo Shirt, Gabardine Chino & Pebble Leather Maps
  const fabW = 512;
  const fabH = new Float32Array(fabW * fabW);
  const leatherH = new Float32Array(fabW * fabW);
  const poloCanvas = document.createElement('canvas');
  poloCanvas.width = fabW;
  poloCanvas.height = fabW;
  const pCtx = poloCanvas.getContext('2d')!;
  const pImg = pCtx.createImageData(fabW, fabW);

  const trCanvas = document.createElement('canvas');
  trCanvas.width = fabW;
  trCanvas.height = fabW;
  const tCtx = trCanvas.getContext('2d')!;
  const tImg = tCtx.createImageData(fabW, fabW);

  for (let y = 0; y < fabW; y++) {
    for (let x = 0; x < fabW; x++) {
      const u = x / fabW;
      const v = y / fabW;
      // Crisp piqué diamond knit + fine twill micro-thread relief
      const knitU = Math.sin(u * Math.PI * 128);
      const knitV = Math.sin(v * Math.PI * 128);
      const weave = 0.5 + 0.28 * knitU * knitV + 0.22 * tileNoise(u, v, 128, 809);
      const heather = tileFbm(u, v, 24, 3, 823);
      fabH[y * fabW + x] = weave;

      // Pebble grain leather relief for Cabretta glove, Tour shoes & belt
      const cell = tileNoise(u, v, 64, 907);
      const grain = tileNoise(u, v, 128, 919);
      leatherH[y * fabW + x] = Math.pow(cell, 0.72) * 0.72 + grain * 0.28;

      const idx = (y * fabW + x) * 4;
      // Crisp Coastal Tour Navy Piqué Polo
      const pShade = 0.84 + 0.20 * weave + (heather - 0.5) * 0.10;
      pImg.data[idx] = Math.round(25 * pShade);
      pImg.data[idx + 1] = Math.round(62 * pShade);
      pImg.data[idx + 2] = Math.round(108 * pShade);
      pImg.data[idx + 3] = 255;

      // Crisp Tailored Pebble Stone-Khaki Chino Gabardine Twill
      const twill = Math.sin((u + v) * Math.PI * 144) * 0.055;
      const tShade = 0.92 + 0.08 * weave + twill + (heather - 0.5) * 0.06;
      tImg.data[idx] = Math.round(218 * tShade);
      tImg.data[idx + 1] = Math.round(209 * tShade);
      tImg.data[idx + 2] = Math.round(189 * tShade);
      tImg.data[idx + 3] = 255;
    }
  }
  pCtx.putImageData(pImg, 0, 0);
  tCtx.putImageData(tImg, 0, 0);

  const poloAlbedo = new THREE.CanvasTexture(poloCanvas);
  poloAlbedo.wrapS = THREE.RepeatWrapping;
  poloAlbedo.wrapT = THREE.RepeatWrapping;
  poloAlbedo.repeat.set(6, 6);
  poloAlbedo.anisotropy = maxAnisotropy;
  poloAlbedo.colorSpace = THREE.SRGBColorSpace;

  const trouserAlbedo = new THREE.CanvasTexture(trCanvas);
  trouserAlbedo.wrapS = THREE.RepeatWrapping;
  trouserAlbedo.wrapT = THREE.RepeatWrapping;
  trouserAlbedo.repeat.set(7, 8);
  trouserAlbedo.anisotropy = maxAnisotropy;
  trouserAlbedo.colorSpace = THREE.SRGBColorSpace;

  const fabricNormal = heightBufferToNormalTexture(fabH, fabW, fabW, 1.75);
  fabricNormal.repeat.set(14, 14);
  fabricNormal.anisotropy = maxAnisotropy;

  const leatherNormal = heightBufferToNormalTexture(leatherH, fabW, fabW, 1.35);
  leatherNormal.repeat.set(16, 16);
  leatherNormal.anisotropy = maxAnisotropy;

  return {
    maxAnisotropy,
    ballAlbedo,
    ballNormal,
    grassDetailMap,
    grassNormal,
    sandNormal,
    rockNormal,
    cypressFoliageMap,
    pineFoliageMap,
    barkMap,
    barkNormal,
    carbonWeaveMap,
    skinAlbedo,
    skinNormal,
    poloAlbedo,
    trouserAlbedo,
    fabricNormal,
    leatherNormal,
    dispose: () => {
      ballAlbedo.dispose();
      ballNormal.dispose();
      grassDetailMap.dispose();
      grassNormal.dispose();
      sandNormal.dispose();
      rockNormal.dispose();
      cypressFoliageMap.dispose();
      pineFoliageMap.dispose();
      barkMap.dispose();
      barkNormal.dispose();
      carbonWeaveMap.dispose();
      skinAlbedo.dispose();
      skinNormal.dispose();
      poloAlbedo.dispose();
      trouserAlbedo.dispose();
      fabricNormal.dispose();
      leatherNormal.dispose();
    },
  };
}

/**
 * Photographic CC0 PBR ground textures (ambientCG, mirrored on GitHub) packed into two
 * 2048px quadrant atlases (lawn / rough / sand / rock) in public/textures/.
 * Atlasing keeps the terrain shader at ~13 fragment texture units — 8 separate samplers
 * exceeded the 16-unit WebGL limit once CSM shadow maps + IBL were counted, which made
 * the terrain program fail to link on many GPUs (ocean showed through instead).
 * Textures stream in async — callers fade their effect in via `set.loaded`.
 */
export interface PhotoTextureSet {
  colorAtlas: THREE.Texture;
  normalAtlas: THREE.Texture;
  loaded: boolean;
}

export function loadPhotoTextures(
  maxAnisotropy: number,
  onReady: (set: PhotoTextureSet) => void
): PhotoTextureSet {
  const manager = new THREE.LoadingManager();
  const loader = new THREE.TextureLoader(manager);
  const mk = (file: string, srgb: boolean): THREE.Texture => {
    const t = loader.load(`/textures/${file}`);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = maxAnisotropy;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
  };
  const set: PhotoTextureSet = {
    colorAtlas: mk('ground-color-atlas.jpg', true),
    normalAtlas: mk('ground-normal-atlas.jpg', false),
    loaded: false,
  };
  manager.onLoad = () => {
    set.loaded = true;
    onReady(set);
  };
  manager.onError = (url) => {
    // Leave photographic layer disabled on failure — procedural fallback stays fully intact
    console.warn('[PhotoTextures] failed to load', url);
  };
  return set;
}
