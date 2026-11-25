import * as THREE from 'three';
import type { ClubCategory, ClubSpec } from '../physics/clubs';
import { BALL_RADIUS_M } from '../physics/constants';
import type { CourseTextureSet } from './ProceduralTextures';

export type SwingAnimPhase = 'idle' | 'walk_in' | 'address' | 'backswing' | 'downswing' | 'followthrough';

interface TubeSlice {
  t: number;     // 0..1 along bone axis (+Y local)
  rx: number;    // radius along X
  rz: number;    // radius along Z
  ox?: number;   // centerline offset X
  oz?: number;   // centerline offset Z
}

/**
 * Generates an anatomically contoured elliptical limb/torso mesh extending along +Y from y=0 to y=length.
 */
function createContouredLimbGeometry(
  length: number,
  slices: TubeSlice[],
  radialSegs = 16,
  capBottom = true,
  capTop = true
): THREE.BufferGeometry {
  const rows = slices.length;
  const cols = radialSegs + 1;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let r = 0; r < rows; r++) {
    const s = slices[r];
    const y = s.t * length;
    const ox = s.ox ?? 0;
    const oz = s.oz ?? 0;
    for (let c = 0; c < cols; c++) {
      const u = c / radialSegs;
      const theta = u * Math.PI * 2;
      positions.push(ox + Math.cos(theta) * s.rx, y, oz + Math.sin(theta) * s.rz);
      uvs.push(u, s.t);
    }
  }

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < radialSegs; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      indices.push(a, d, b);
      indices.push(b, d, e);
    }
  }

  if (capBottom) {
    const s0 = slices[0];
    const cIdx = positions.length / 3;
    positions.push(s0.ox ?? 0, s0.t * length, s0.oz ?? 0);
    uvs.push(0.5, 0);
    for (let c = 0; c < radialSegs; c++) {
      indices.push(cIdx, c, c + 1);
    }
  }
  if (capTop) {
    const sLast = slices[rows - 1];
    const cIdx = positions.length / 3;
    const base = (rows - 1) * cols;
    positions.push(sLast.ox ?? 0, sLast.t * length, sLast.oz ?? 0);
    uvs.push(0.5, 1);
    for (let c = 0; c < radialSegs; c++) {
      indices.push(cIdx, base + c + 1, base + c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Analytically sculpts an athletic adult male head from a high-res sphere:
 * flattened temples, defined cheekbones & jawline, chin, brow ridge & cranial back.
 * Local orientation: +X = face forward, +Y = crown up, ±Z = ears/temples.
 */
function createSculptedHeadGeometry(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.102, 28, 22);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const nx = v.x / 0.102;
    const ny = v.y / 0.102;
    const nz = v.z / 0.102;

    // Elongate height slightly (adult head ~23cm tall, ~15.5cm wide, ~19.5cm front-back)
    v.y *= 1.15;
    v.z *= 0.80;
    v.x *= 0.96;

    // Cranial occiput (fuller back of skull)
    if (nx < 0 && ny > -0.25) {
      v.x -= 0.012 * Math.exp(-ny * ny * 2.5);
    }

    // Taper jaw/mandible cleanly below cheeks
    if (ny < -0.15) {
      const jawT = THREE.MathUtils.clamp((-ny - 0.15) / 0.85, 0, 1);
      v.z *= 1 - 0.34 * jawT;
      if (nx > 0) {
        // Defined chin projection & jaw angle
        v.x += 0.010 * Math.sin(jawT * Math.PI * 0.75) * (1 - Math.abs(nz) * 0.6);
      } else {
        // Taper back of neck/jaw
        v.x += 0.024 * jawT;
      }
    }

    // Flatten temples & emphasize cheekbones slightly
    if (nx > 0.15 && ny > -0.25 && ny < 0.35 && Math.abs(nz) > 0.35) {
      const cheek = Math.exp(-Math.pow((ny - 0.02) / 0.22, 2)) * (1 - Math.abs(Math.abs(nz) - 0.62));
      v.z += Math.sign(nz) * Math.max(0, cheek) * 0.004;
    }

    // Subtle brow ridge & eye socket recess
    if (nx > 0.45) {
      const brow = Math.exp(-Math.pow((ny - 0.17) / 0.11, 2)) * (1 - nz * nz * 0.65);
      v.x += brow * 0.0055;
      const eyeSocket =
        Math.exp(-Math.pow((ny - 0.04) / 0.11, 2)) *
        Math.exp(-Math.pow((Math.abs(nz) - 0.32) / 0.18, 2));
      v.x -= eyeSocket * 0.0055;
    }

    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Exact 2-bone analytical Inverse Kinematics solver in rig-local space.
 * Returns the exact elbow/knee joint world position in rig-local space.
 */
function solveTwoBoneIK(
  root: THREE.Vector3,
  target: THREE.Vector3,
  len1: number,
  len2: number,
  poleHint: THREE.Vector3
): THREE.Vector3 {
  const diff = new THREE.Vector3().subVectors(target, root);
  const rawDist = diff.length();
  const maxReach = (len1 + len2) * 0.996;
  const minReach = Math.abs(len1 - len2) + 0.02;
  const dist = THREE.MathUtils.clamp(rawDist, minReach, maxReach);

  const dir = rawDist > 1e-5 ? diff.divideScalar(rawDist) : new THREE.Vector3(0, -1, 0);

  // Bend axis perpendicular to both bone vector & pole hint
  const bendPlane = new THREE.Vector3().copy(poleHint).sub(
    new THREE.Vector3().copy(dir).multiplyScalar(poleHint.dot(dir))
  );
  if (bendPlane.lengthSq() < 1e-6) {
    bendPlane.set(-1, 0, 0);
  } else {
    bendPlane.normalize();
  }

  // Law of cosines for shoulder/hip angle
  const cosAlpha = THREE.MathUtils.clamp(
    (len1 * len1 + dist * dist - len2 * len2) / (2 * len1 * dist),
    -1,
    1
  );
  const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));

  return new THREE.Vector3()
    .copy(root)
    .addScaledVector(dir, len1 * cosAlpha)
    .addScaledVector(bendPlane, len1 * sinAlpha);
}

const _upVec = new THREE.Vector3(0, 1, 0);
const _tmpDir = new THREE.Vector3();
const _tmpRight = new THREE.Vector3();
const _tmpFwd = new THREE.Vector3();
const _tmpMat = new THREE.Matrix4();

/**
 * Positions and orients a bone mesh whose local +Y runs from 0 to boneLength,
 * with local +X aligned as closely as possible to `facingHint`.
 */
function orientLimbMesh(
  obj: THREE.Object3D,
  from: THREE.Vector3,
  to: THREE.Vector3,
  facingHint?: THREE.Vector3
): void {
  obj.position.copy(from);
  _tmpDir.subVectors(to, from);
  const len = _tmpDir.length();
  if (len < 1e-5) return;
  _tmpDir.divideScalar(len);

  if (facingHint) {
    // Make local +Y = _tmpDir, local +X ~ facingHint
    _tmpRight.crossVectors(facingHint, _tmpDir);
    if (_tmpRight.lengthSq() < 1e-6) {
      obj.quaternion.setFromUnitVectors(_upVec, _tmpDir);
      return;
    }
    _tmpRight.normalize(); // local +Z
    _tmpFwd.crossVectors(_tmpDir, _tmpRight).normalize(); // local +X
    _tmpMat.makeBasis(_tmpFwd, _tmpDir, _tmpRight);
    obj.quaternion.setFromRotationMatrix(_tmpMat);
  } else {
    obj.quaternion.setFromUnitVectors(_upVec, _tmpDir);
  }
}

export class GolferRig {
  public readonly root = new THREE.Group();

  // Articulated anatomical bone meshes & groups
  private pelvisGroup = new THREE.Group();
  private chestGroup = new THREE.Group();
  private headGroup = new THREE.Group();

  private leftThighMesh!: THREE.Mesh;
  private leftShinMesh!: THREE.Mesh;
  private leftFootGroup!: THREE.Group;

  private rightThighMesh!: THREE.Mesh;
  private rightShinMesh!: THREE.Mesh;
  private rightFootGroup!: THREE.Group;

  private leftUpperArmGroup!: THREE.Group;
  private leftForearmMesh!: THREE.Mesh;
  private leftHandGroup!: THREE.Group;

  private rightUpperArmGroup!: THREE.Group;
  private rightForearmMesh!: THREE.Mesh;
  private rightHandGroup!: THREE.Group;

  private clubMount = new THREE.Group();
  private activeClubGroup: THREE.Group | null = null;
  private currentClubCategory: ClubCategory = 'wood';

  // Exact biomechanical segment lengths (1.80 m athletic build)
  private readonly thighLen = 0.435;
  private readonly shinLen = 0.415;
  private readonly ankleHeight = 0.088;
  private readonly upperArmLen = 0.315;
  private readonly forearmLen = 0.285;

  constructor(private readonly textures: CourseTextureSet) {
    this.buildAnatomy();
    this.root.add(this.clubMount);
    this.setClubModel('wood', 10.5);
  }

  private buildAnatomy(): void {
    const skinMat = new THREE.MeshPhysicalMaterial({
      map: this.textures.skinAlbedo,
      normalMap: this.textures.skinNormal,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughness: 0.56,
      metalness: 0.0,
      sheen: 0.25,
      sheenRoughness: 0.7,
      sheenColor: new THREE.Color(0xf2c2a8),
      clearcoat: 0.06,
      clearcoatRoughness: 0.6,
    });

    const shirtMat = new THREE.MeshPhysicalMaterial({
      map: this.textures.poloAlbedo,
      normalMap: this.textures.fabricNormal,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.78,
      metalness: 0.0,
      sheen: 0.35,
      sheenRoughness: 0.85,
      sheenColor: new THREE.Color(0x4b6b8f),
    });

    const collarMat = new THREE.MeshStandardMaterial({
      color: 0x162f4c,
      normalMap: this.textures.fabricNormal,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.75,
    });

    const pantsMat = new THREE.MeshPhysicalMaterial({
      map: this.textures.trouserAlbedo,
      normalMap: this.textures.fabricNormal,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughness: 0.82,
      metalness: 0.0,
      sheen: 0.18,
      sheenRoughness: 0.9,
    });

    const beltMat = new THREE.MeshStandardMaterial({ color: 0x2c1e16, roughness: 0.45 });
    const buckleMat = new THREE.MeshStandardMaterial({
      color: 0xc8ced4,
      metalness: 0.88,
      roughness: 0.22,
    });
    const shoeWhiteMat = new THREE.MeshPhysicalMaterial({
      color: 0xf4f3ef,
      roughness: 0.36,
      clearcoat: 0.28,
      clearcoatRoughness: 0.35,
    });
    const shoeAccentMat = new THREE.MeshStandardMaterial({ color: 0x182e4a, roughness: 0.48 });
    const shoeSoleMat = new THREE.MeshStandardMaterial({ color: 0x22252a, roughness: 0.75 });
    const gloveMat = new THREE.MeshStandardMaterial({ color: 0xfafaf6, roughness: 0.52 });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x2b2019, roughness: 0.86 });
    const capMat = new THREE.MeshStandardMaterial({
      color: 0xf6f4ee,
      normalMap: this.textures.fabricNormal,
      normalScale: new THREE.Vector2(0.4, 0.4),
      roughness: 0.74,
    });
    const capNavyMat = new THREE.MeshStandardMaterial({
      color: 0x162e49,
      normalMap: this.textures.fabricNormal,
      normalScale: new THREE.Vector2(0.4, 0.4),
      roughness: 0.72,
    });

    // ------------------------------------------------------------------
    // 1. LOWER BODY: Tailored Performance Chinos + Tour Golf Shoes
    // ------------------------------------------------------------------
    const thighSlices: TubeSlice[] = [
      { t: 0.0, rx: 0.064, rz: 0.062 }, // Knee joint
      { t: 0.18, rx: 0.072, rz: 0.069, ox: 0.004 },
      { t: 0.55, rx: 0.088, rz: 0.084, ox: 0.008 }, // Muscular quad/hamstring swell
      { t: 0.85, rx: 0.095, rz: 0.092, ox: 0.003 },
      { t: 1.0, rx: 0.092, rz: 0.090 }, // Hip socket
    ];
    const thighGeo = createContouredLimbGeometry(this.thighLen, thighSlices, 16);

    const shinSlices: TubeSlice[] = [
      { t: 0.0, rx: 0.044, rz: 0.042 }, // Ankle cuff
      { t: 0.10, rx: 0.056, rz: 0.055 }, // Trouser cuff opening
      { t: 0.45, rx: 0.064, rz: 0.062 },
      { t: 0.72, rx: 0.068, rz: 0.065, ox: -0.006 }, // Calf curve
      { t: 1.0, rx: 0.063, rz: 0.061 }, // Knee
    ];
    const shinGeo = createContouredLimbGeometry(this.shinLen, shinSlices, 16);

    this.leftThighMesh = new THREE.Mesh(thighGeo, pantsMat);
    this.rightThighMesh = new THREE.Mesh(thighGeo, pantsMat);
    this.leftShinMesh = new THREE.Mesh(shinGeo, pantsMat);
    this.rightShinMesh = new THREE.Mesh(shinGeo, pantsMat);

    for (const m of [this.leftThighMesh, this.rightThighMesh, this.leftShinMesh, this.rightShinMesh]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.root.add(m);
    }

    const buildGolfShoe = (): THREE.Group => {
      const g = new THREE.Group();
      // Sock ankle shaft connecting cleanly into trouser hem
      const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.040, 0.041, 0.08, 12), gloveMat);
      sock.position.set(0, -0.025, 0);
      g.add(sock);

      // Molded rubber cleat sole (sits flush at y = -ankleHeight = -0.088)
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.255, 0.018, 0.098), shoeSoleMat);
      sole.position.set(0.058, -this.ankleHeight + 0.009, 0);
      sole.castShadow = true;
      g.add(sole);

      // Cushioned EVA midsole
      const mid = new THREE.Mesh(new THREE.BoxGeometry(0.248, 0.016, 0.094), shoeWhiteMat);
      mid.position.set(0.058, -this.ankleHeight + 0.024, 0);
      g.add(mid);

      // Sculpted heel counter + toe vamp
      const heel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.048, 0.058, 14), shoeWhiteMat);
      heel.position.set(-0.022, -this.ankleHeight + 0.052, 0);
      heel.castShadow = true;
      g.add(heel);

      const instep = new THREE.Mesh(
        new THREE.SphereGeometry(0.047, 14, 10),
        shoeWhiteMat
      );
      instep.scale.set(2.35, 0.68, 0.98);
      instep.position.set(0.072, -this.ankleHeight + 0.044, 0);
      instep.castShadow = true;
      g.add(instep);

      // Classic Tour navy saddle stripe & laces
      const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.042, 0.095), shoeAccentMat);
      saddle.position.set(0.042, -this.ankleHeight + 0.050, 0);
      saddle.rotation.z = -0.18;
      g.add(saddle);

      for (let i = 0; i < 3; i++) {
        const lace = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.042, 6), gloveMat);
        lace.rotation.x = Math.PI / 2;
        lace.position.set(0.052 + i * 0.016, -this.ankleHeight + 0.072 - i * 0.005, 0);
        g.add(lace);
      }

      return g;
    };

    this.leftFootGroup = buildGolfShoe();
    this.rightFootGroup = buildGolfShoe();
    this.root.add(this.leftFootGroup, this.rightFootGroup);

    // ------------------------------------------------------------------
    // 2. PELVIS, BELT, ATHLETIC TORSO, COLLAR & HEAD
    // ------------------------------------------------------------------
    this.root.add(this.pelvisGroup);

    // Sculpted Pelvis & Glutes (y = -0.05 .. +0.11 relative to hip pivot)
    const pelvisMesh = new THREE.Mesh(
      createContouredLimbGeometry(
        0.16,
        [
          { t: 0.0, rx: 0.112, rz: 0.165, ox: -0.005 },
          { t: 0.45, rx: 0.118, rz: 0.172, ox: -0.008 }, // Glute projection
          { t: 1.0, rx: 0.106, rz: 0.155, ox: 0.002 },
        ],
        20
      ),
      pantsMat
    );
    pelvisMesh.position.y = -0.04;
    pelvisMesh.castShadow = true;
    this.pelvisGroup.add(pelvisMesh);

    // Leather Golf Belt & Brushed Steel Buckle
    const beltMesh = new THREE.Mesh(
      createContouredLimbGeometry(
        0.036,
        [
          { t: 0.0, rx: 0.110, rz: 0.159 },
          { t: 1.0, rx: 0.109, rz: 0.158 },
        ],
        20
      ),
      beltMat
    );
    beltMesh.position.y = 0.095;
    this.pelvisGroup.add(beltMesh);

    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.042, 0.062), buckleMat);
    buckle.position.set(0.111, 0.113, 0);
    this.pelvisGroup.add(buckle);

    // Upper Torso / Ribcage Group (pivots at waist y = 0.12 for X-Factor coil)
    this.chestGroup.position.set(0, 0.12, 0);
    this.pelvisGroup.add(this.chestGroup);

    // Athletic tapered ribcage & chest (broader lats/pecs, fitted waist)
    const torsoSlices: TubeSlice[] = [
      { t: 0.0, rx: 0.106, rz: 0.154 }, // Waist tuck
      { t: 0.28, rx: 0.114, rz: 0.164, ox: 0.005 },
      { t: 0.64, rx: 0.128, rz: 0.205, ox: 0.012 }, // Pectorals + lats
      { t: 0.88, rx: 0.118, rz: 0.218, ox: 0.004 }, // Broad shoulder line
      { t: 1.0, rx: 0.082, rz: 0.155 }, // Trapezius / collar base
    ];
    const torsoMesh = new THREE.Mesh(
      createContouredLimbGeometry(0.41, torsoSlices, 24),
      shirtMat
    );
    torsoMesh.castShadow = true;
    torsoMesh.receiveShadow = true;
    this.chestGroup.add(torsoMesh);

    // Ribbed Fold-Over Polo Collar & 3-Button Placket
    const collarRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.072, 0.018, 10, 20),
      collarMat
    );
    collarRing.rotation.x = Math.PI / 2;
    collarRing.position.set(0.005, 0.405, 0);
    collarRing.scale.set(1.02, 1.15, 1.0);
    collarRing.castShadow = true;
    this.chestGroup.add(collarRing);

    const placket = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.13, 0.036), collarMat);
    placket.position.set(0.118, 0.345, 0);
    placket.rotation.z = 0.22;
    this.chestGroup.add(placket);

    for (let b = 0; b < 3; b++) {
      const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.006, 8), gloveMat);
      btn.rotation.z = Math.PI / 2;
      btn.position.set(0.126 - b * 0.004, 0.375 - b * 0.032, 0);
      this.chestGroup.add(btn);
    }

    // Neck + Anatomically Sculpted Head + Hair + Tour Cap
    this.headGroup.position.set(0.005, 0.41, 0);
    this.chestGroup.add(this.headGroup);

    const neckMesh = new THREE.Mesh(
      createContouredLimbGeometry(
        0.105,
        [
          { t: 0.0, rx: 0.056, rz: 0.056 },
          { t: 0.55, rx: 0.049, rz: 0.048, ox: 0.003 },
          { t: 1.0, rx: 0.052, rz: 0.050, ox: 0.008 },
        ],
        16
      ),
      skinMat
    );
    neckMesh.castShadow = true;
    this.headGroup.add(neckMesh);

    const headCenter = new THREE.Group();
    headCenter.position.set(0.012, 0.175, 0);
    this.headGroup.add(headCenter);

    const skullMesh = new THREE.Mesh(createSculptedHeadGeometry(), skinMat);
    skullMesh.castShadow = true;
    headCenter.add(skullMesh);

    // Sculpted Nose Bridge & Tip
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.042, 10), skinMat);
    nose.rotation.z = -Math.PI * 0.36;
    nose.position.set(0.098, -0.004, 0);
    nose.scale.set(0.95, 1.0, 0.85);
    headCenter.add(nose);

    // Left & Right Ears
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), skinMat);
      ear.scale.set(0.65, 1.35, 0.42);
      ear.position.set(-0.008, -0.002, side * 0.082);
      headCenter.add(ear);
    }

    // Eyebrows & Natural Eyes (sclera + dark iris)
    const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xf4f2ee, roughness: 0.3 });
    const irisMat = new THREE.MeshStandardMaterial({ color: 0x261d17, roughness: 0.25 });
    for (const side of [-1, 1]) {
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.007, 0.028), hairMat);
      brow.position.set(0.091, 0.025, side * 0.028);
      brow.rotation.y = side * -0.18;
      headCenter.add(brow);

      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.010, 10, 8), eyeWhiteMat);
      eye.scale.set(0.6, 0.72, 1.0);
      eye.position.set(0.088, 0.009, side * 0.027);
      headCenter.add(eye);

      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.0055, 8, 6), irisMat);
      pupil.position.set(0.093, 0.009, side * 0.027);
      headCenter.add(pupil);
    }

    // Subtle Jaw/Temple/Nape Hair under Golf Cap
    const hairBack = new THREE.Mesh(
      new THREE.SphereGeometry(0.104, 16, 12, Math.PI * 0.48, Math.PI * 1.04, Math.PI * 0.25, Math.PI * 0.56),
      hairMat
    );
    hairBack.scale.set(0.95, 1.06, 0.81);
    hairBack.position.set(-0.004, 0.008, 0);
    headCenter.add(hairBack);

    // Fitted 6-Panel Tour Golf Cap + Arched Visor Brim
    const capCrown = new THREE.Mesh(
      new THREE.SphereGeometry(0.108, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.54),
      capMat
    );
    capCrown.scale.set(1.01, 1.08, 0.84);
    capCrown.position.set(-0.002, 0.018, 0);
    capCrown.castShadow = true;
    headCenter.add(capCrown);

    const capCrest = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.024, 0.034), capNavyMat);
    capCrest.position.set(0.102, 0.056, 0);
    capCrest.rotation.z = 0.25;
    headCenter.add(capCrest);

    // Curved ergonomic cap visor (built from bent cylinder sector)
    const visorGeo = new THREE.CylinderGeometry(0.135, 0.145, 0.007, 20, 1, false, -0.78, 1.56);
    const visor = new THREE.Mesh(visorGeo, capNavyMat);
    visor.position.set(0.022, 0.026, 0);
    visor.rotation.y = Math.PI / 2;
    visor.rotation.x = 0.14;
    visor.scale.set(0.84, 1, 1.18);
    visor.castShadow = true;
    headCenter.add(visor);

    // ------------------------------------------------------------------
    // 3. ARTICULATED TWO-BONE IK ARMS, POLO SLEEVES, GLOVED & BARE HANDS
    // ------------------------------------------------------------------
    const upperArmSlices: TubeSlice[] = [
      { t: 0.0, rx: 0.054, rz: 0.054 }, // Shoulder deltoid cap
      { t: 0.35, rx: 0.052, rz: 0.050 }, // Sleeve hem (polo sleeve covers top 55%)
      { t: 0.65, rx: 0.048, rz: 0.046 },
      { t: 1.0, rx: 0.039, rz: 0.038 }, // Elbow joint
    ];

    const buildUpperArmGroup = (): THREE.Group => {
      const g = new THREE.Group();
      // Polo short sleeve (covers top 58% of upper arm)
      const sleeve = new THREE.Mesh(
        createContouredLimbGeometry(this.upperArmLen * 0.60, upperArmSlices.slice(0, 3), 14),
        shirtMat
      );
      sleeve.castShadow = true;
      g.add(sleeve);

      // Bare bicep/tricep below sleeve to elbow
      const bare = new THREE.Mesh(
        createContouredLimbGeometry(
          this.upperArmLen * 0.45,
          [
            { t: 0.0, rx: 0.045, rz: 0.043 },
            { t: 0.55, rx: 0.043, rz: 0.041 },
            { t: 1.0, rx: 0.038, rz: 0.037 },
          ],
          14
        ),
        skinMat
      );
      bare.position.y = this.upperArmLen * 0.55;
      bare.castShadow = true;
      g.add(bare);
      return g;
    };

    const forearmSlices: TubeSlice[] = [
      { t: 0.0, rx: 0.039, rz: 0.038 }, // Elbow
      { t: 0.28, rx: 0.044, rz: 0.040 }, // Muscular forearm swell
      { t: 0.72, rx: 0.033, rz: 0.028 },
      { t: 1.0, rx: 0.028, rz: 0.022 }, // Anatomical oval wrist
    ];
    const forearmGeo = createContouredLimbGeometry(this.forearmLen, forearmSlices, 14);

    this.leftUpperArmGroup = buildUpperArmGroup();
    this.rightUpperArmGroup = buildUpperArmGroup();
    this.leftForearmMesh = new THREE.Mesh(forearmGeo, skinMat);
    this.rightForearmMesh = new THREE.Mesh(forearmGeo, skinMat);
    this.leftForearmMesh.castShadow = true;
    this.rightForearmMesh.castShadow = true;

    // Sport GPS Golf Watch on Lead Wrist
    const watch = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.016, 12), shoeSoleMat);
    watch.position.y = this.forearmLen - 0.028;
    this.leftForearmMesh.add(watch);

    const buildHand = (gloved: boolean): THREE.Group => {
      const h = new THREE.Group();
      const mat = gloved ? gloveMat : skinMat;
      // Palm
      const palm = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.072, 0.052), mat);
      palm.position.set(0, 0.036, 0);
      palm.castShadow = true;
      h.add(palm);

      // 4 Curled Fingers wrapping around grip
      for (let f = 0; f < 4; f++) {
        const finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.0075, 0.038, 3, 6), mat);
        finger.position.set(0.016, 0.048 - f * 0.013, 0.014);
        finger.rotation.z = -Math.PI * 0.42;
        h.add(finger);
      }

      // Thumb angled down shaft
      const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.0085, 0.035, 3, 6), mat);
      thumb.position.set(0.014, 0.068, -0.016);
      thumb.rotation.x = 0.35;
      h.add(thumb);

      return h;
    };

    this.leftHandGroup = buildHand(true); // Cabretta white leather glove on lead hand
    this.rightHandGroup = buildHand(false);

    this.root.add(
      this.leftUpperArmGroup,
      this.rightUpperArmGroup,
      this.leftForearmMesh,
      this.rightForearmMesh,
      this.leftHandGroup,
      this.rightHandGroup
    );
  }

  private getShaftLength(category: ClubCategory): number {
    return category === 'wood' ? 1.15 : category === 'hybrid' ? 1.07 : category === 'putter' ? 0.91 : 1.00;
  }

  public setClubModel(category: ClubCategory, loftDeg: number): void {
    if (this.activeClubGroup && this.currentClubCategory === category) return;
    this.currentClubCategory = category;

    if (this.activeClubGroup) {
      this.clubMount.remove(this.activeClubGroup);
      this.activeClubGroup.traverse((o) => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
        if ((o as THREE.Mesh).material) ((o as THREE.Mesh).material as THREE.Material).dispose();
      });
    }

    const club = new THREE.Group();
    const gripMat = new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.88 });
    const shaftMat = new THREE.MeshStandardMaterial({
      color: category === 'wood' || category === 'hybrid' ? 0x2a2f37 : 0xd0d7e0,
      metalness: category === 'wood' ? 0.35 : 0.90,
      roughness: category === 'wood' ? 0.35 : 0.20,
    });
    const chromeMat = new THREE.MeshStandardMaterial({
      color: 0xdce2e8,
      metalness: 0.92,
      roughness: 0.18,
    });
    const titaniumMat = new THREE.MeshPhysicalMaterial({
      color: 0x181f28,
      metalness: 0.72,
      roughness: 0.24,
      clearcoat: 0.7,
    });

    const shaftLen = this.getShaftLength(category);

    // Textured Tour Velvet Grip
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.0145, 0.0115, 0.27, 12), gripMat);
    grip.position.y = -0.055;
    club.add(grip);

    // Stepped / Graphite Tapered Shaft
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0062, 0.0048, shaftLen - 0.16, 10),
      shaftMat
    );
    shaft.position.y = -0.18 - (shaftLen - 0.16) * 0.5;
    shaft.castShadow = true;
    club.add(shaft);

    const hosel = new THREE.Mesh(new THREE.CylinderGeometry(0.0068, 0.0068, 0.042, 10), gripMat);
    hosel.position.y = -shaftLen + 0.015;
    club.add(hosel);

    // Clubhead centered cleanly at y = -shaftLen so shaft tip meets turf right behind ball
    if (category === 'wood' || category === 'hybrid') {
      const s = category === 'wood' ? 1.0 : 0.74;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.054 * s, 18, 12), titaniumMat);
      head.scale.set(1.18, 0.58, 1.02);
      head.position.set(0.032 * s, -shaftLen, 0.022 * s);
      head.castShadow = true;
      club.add(head);

      const face = new THREE.Mesh(
        new THREE.BoxGeometry(0.090 * s, 0.046 * s, 0.010),
        chromeMat
      );
      face.position.set(0.032 * s, -shaftLen, -0.028 * s);
      face.rotation.x = THREE.MathUtils.degToRad(loftDeg * 0.55);
      club.add(face);
    } else if (category === 'putter') {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.102, 0.024, 0.028), chromeMat);
      blade.position.set(0.036, -shaftLen, 0.0);
      blade.castShadow = true;
      club.add(blade);
    } else {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.080, 0.042, 0.015), chromeMat);
      blade.position.set(0.032, -shaftLen, 0.002);
      blade.rotation.x = THREE.MathUtils.degToRad(loftDeg * 0.45);
      blade.castShadow = true;
      club.add(blade);
    }

    this.clubMount.add(club);
    this.activeClubGroup = club;
  }

  /**
   * Computes full-body PGA Tour biomechanics + exact 2-bone IK for legs, arms, hands, and club.
   */
  public updatePose(
    ballPos: { x: number; y: number; z: number },
    aimYawRad: number,
    club: ClubSpec,
    visible: boolean,
    animPhase: SwingAnimPhase,
    phaseT: number,
    clubPathDeg: number
  ): void {
    this.root.visible = visible;
    if (!visible) return;

    this.setClubModel(club.category, club.loftDeg);

    const isPutt = club.category === 'putter';
    const isWood = club.category === 'wood' || club.category === 'hybrid';
    const shaftLen = this.getShaftLength(club.category);

    // Calibrate stance distance so clubhead sole rests right behind ball at address
    const standDist = isWood ? 0.94 : club.category === 'hybrid' ? 0.85 : isPutt ? 0.56 : 0.76;
    const ballZOffset = isWood ? -0.08 : isPutt ? -0.04 : 0.0;
    const stanceHalfW = isWood ? 0.245 : isPutt ? 0.165 : 0.195;

    const leftX = -Math.cos(aimYawRad);
    const leftZ = -Math.sin(aimYawRad);
    this.root.position.set(
      ballPos.x + leftX * standDist - Math.sin(aimYawRad) * ballZOffset,
      ballPos.y - BALL_RADIUS_M,
      ballPos.z + leftZ * standDist + Math.cos(aimYawRad) * ballZOffset
    );
    this.root.rotation.y = -aimYawRad + THREE.MathUtils.degToRad(clubPathDeg * 0.45);

    // ------------------------------------------------------------------
    // 1. BIOMECHANICAL KINEMATICS (Hips, Chest Coil, Arm Elevation, Wrists)
    // ------------------------------------------------------------------
    let hipTurnY = 0;
    let chestTurnY = 0;
    let hipSwayZ = 0;
    let trailHeelLift = 0;
    let armSweep = 0;      // + = backswing across trail chest/up, - = follow-through over lead shoulder
    let wristCock = 0;     // + = wrist hinge up in backswing, - = follow-through hinge
    let faceRoll = 0;
    let headTrackTarget = 0;

    if (animPhase === 'address' || animPhase === 'idle') {
      // Quiet athletic setup
    } else if (animPhase === 'backswing') {
      const e = THREE.MathUtils.smoothstep(phaseT, 0, 1);
      if (isPutt) {
        armSweep = e * 0.24;
        chestTurnY = -e * 0.10;
      } else {
        hipTurnY = -e * 0.66;       // ~38 deg hip turn
        chestTurnY = -e * 1.48;     // ~85 deg shoulder coil (X-factor!)
        hipSwayZ = e * 0.025;
        armSweep = e * 1.0;         // Raise hands to chest-high Tour top position
        wristCock = Math.pow(e, 0.78) * 1.32;
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
        hipTurnY = THREE.MathUtils.lerp(-0.66, 0.48, hipLead);
        chestTurnY = THREE.MathUtils.lerp(-1.48, 0.22, e);
        hipSwayZ = THREE.MathUtils.lerp(0.025, -0.065, hipLead);
        trailHeelLift = hipLead * 0.36;
        armSweep = THREE.MathUtils.lerp(1.0, -0.03, e);
        wristCock = THREE.MathUtils.lerp(1.32, 0.04, lagRelease);
        faceRoll = THREE.MathUtils.lerp(0.42, 0.0, lagRelease);
      }
    } else if (animPhase === 'followthrough') {
      const e = 1 - Math.pow(1 - phaseT, 2.2);
      if (isPutt) {
        armSweep = THREE.MathUtils.lerp(-0.02, -0.26, e);
        chestTurnY = THREE.MathUtils.lerp(0.02, 0.14, e);
      } else {
        hipTurnY = THREE.MathUtils.lerp(0.48, 1.32, e);
        chestTurnY = THREE.MathUtils.lerp(0.22, 1.48, e);
        hipSwayZ = THREE.MathUtils.lerp(-0.065, -0.095, e);
        trailHeelLift = THREE.MathUtils.lerp(0.36, 1.0, e);
        armSweep = THREE.MathUtils.lerp(-0.03, -1.0, e);
        wristCock = THREE.MathUtils.lerp(0.04, -1.08, Math.min(1, e * 1.4));
        faceRoll = THREE.MathUtils.lerp(0.0, -0.62, e);
        headTrackTarget = THREE.MathUtils.smoothstep(phaseT, 0.22, 0.82);
      }
    }

    // ------------------------------------------------------------------
    // 2. PELVIS, TORSO, SPINE TILT & HEAD ORIENTATION
    // ------------------------------------------------------------------
    const hipHeight = isPutt ? 0.89 : isWood ? 0.88 : 0.87;
    const hipBackX = isPutt ? -0.05 : -0.085;
    const pelvisCenter = new THREE.Vector3(hipBackX, hipHeight, hipSwayZ);
    this.pelvisGroup.position.copy(pelvisCenter);

    const forwardSpineTilt = isPutt ? -0.58 : isWood ? -0.44 : -0.52;
    const sideSpineTilt = isPutt ? -0.05 : -0.10 - Math.max(0, -hipSwayZ) * 0.9;

    this.pelvisGroup.rotation.set(0, hipTurnY, 0, 'YXZ');
    this.chestGroup.rotation.order = 'YXZ';
    this.chestGroup.rotation.set(
      sideSpineTilt,
      chestTurnY - hipTurnY,
      forwardSpineTilt
    );

    const netChestY = chestTurnY;
    this.headGroup.rotation.order = 'YXZ';
    this.headGroup.rotation.set(
      -sideSpineTilt * 0.7,
      THREE.MathUtils.lerp(-netChestY * 0.92, 0.45, headTrackTarget),
      THREE.MathUtils.lerp(-forwardSpineTilt * 0.42 - 0.54, 0.22, headTrackTarget)
    );

    this.root.updateMatrixWorld(true);

    // ------------------------------------------------------------------
    // 3. PLANTED FEET & 2-BONE KNEE-FLEX LEG IK
    // ------------------------------------------------------------------
    const leadFootPos = new THREE.Vector3(-0.015, this.ankleHeight, -stanceHalfW);
    this.leftFootGroup.position.copy(leadFootPos);
    this.leftFootGroup.rotation.set(0, 0.30, 0);

    const trailLiftY = trailHeelLift * 0.085;
    const trailPivotZ = stanceHalfW - trailHeelLift * 0.035;
    const trailFootPos = new THREE.Vector3(
      0.01 + trailHeelLift * 0.04,
      this.ankleHeight + trailLiftY,
      trailPivotZ
    );
    this.rightFootGroup.position.copy(trailFootPos);
    this.rightFootGroup.rotation.set(
      -trailHeelLift * 0.42,
      -0.10 + trailHeelLift * 0.65,
      -trailHeelLift * 0.45,
      'YXZ'
    );

    const rootInvMat = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const toRigLocal = (worldPos: THREE.Vector3) => worldPos.applyMatrix4(rootInvMat);

    const leadHipLocal = toRigLocal(
      new THREE.Vector3(0.0, -0.02, -0.102).applyMatrix4(this.pelvisGroup.matrixWorld)
    );
    const trailHipLocal = toRigLocal(
      new THREE.Vector3(0.0, -0.02, 0.102).applyMatrix4(this.pelvisGroup.matrixWorld)
    );

    const leadStraight = animPhase === 'followthrough' ? 0.55 : animPhase === 'downswing' ? phaseT * 0.4 : 0;
    const leadKneePole = new THREE.Vector3(1.0 - leadStraight * 0.4, 0.15, -0.22);
    const trailKneePole = new THREE.Vector3(0.95, 0.10, -trailHeelLift * 0.75 + 0.15);

    const leadKneeLocal = solveTwoBoneIK(leadHipLocal, leadFootPos, this.thighLen, this.shinLen, leadKneePole);
    const trailKneeLocal = solveTwoBoneIK(trailHipLocal, trailFootPos, this.thighLen, this.shinLen, trailKneePole);

    const kneeFace = new THREE.Vector3(1, 0, 0);
    orientLimbMesh(this.leftThighMesh, leadKneeLocal, leadHipLocal, kneeFace);
    orientLimbMesh(this.leftShinMesh, leadFootPos, leadKneeLocal, kneeFace);
    orientLimbMesh(this.rightThighMesh, trailKneeLocal, trailHipLocal, kneeFace);
    orientLimbMesh(this.rightShinMesh, trailFootPos, trailKneeLocal, kneeFace);

    // ------------------------------------------------------------------
    // 4. CHEST-ANCHORED SWING HANDS + CLUB SHAFT + 2-BONE ARM IK
    // ------------------------------------------------------------------
    const leadShoulderLocal = toRigLocal(
      new THREE.Vector3(0.01, 0.355, -0.195).applyMatrix4(this.chestGroup.matrixWorld)
    );
    const trailShoulderLocal = toRigLocal(
      new THREE.Vector3(0.01, 0.355, 0.195).applyMatrix4(this.chestGroup.matrixWorld)
    );

    // Compute grip center in chestGroup local coordinates so arms stay naturally below 0.59m max reach!
    const addrGripInChest = new THREE.Vector3(
      isPutt ? 0.23 : 0.27,
      isPutt ? -0.03 : -0.035,
      -0.01
    );

    let gripInChest: THREE.Vector3;
    if (isPutt) {
      gripInChest = new THREE.Vector3(
        addrGripInChest.x,
        addrGripInChest.y + Math.abs(armSweep) * 0.06,
        addrGripInChest.z + armSweep * 0.36
      );
    } else if (armSweep >= 0) {
      // Backswing: hands elevate cleanly up in front of trail shoulder (lead arm wide/straight, trail elbow folds ~90°)
      const t = armSweep;
      gripInChest = new THREE.Vector3(
        THREE.MathUtils.lerp(addrGripInChest.x, 0.26, t),
        THREE.MathUtils.lerp(addrGripInChest.y, 0.32, t),
        THREE.MathUtils.lerp(addrGripInChest.z, 0.14, t)
      );
    } else {
      // Follow-through: hands swing forward and high over lead shoulder
      const t = -armSweep;
      gripInChest = new THREE.Vector3(
        THREE.MathUtils.lerp(addrGripInChest.x, 0.32, t),
        THREE.MathUtils.lerp(addrGripInChest.y, 0.34, t),
        THREE.MathUtils.lerp(addrGripInChest.z, -0.16, t)
      );
    }

    const gripCenterLocal = toRigLocal(gripInChest.clone().applyMatrix4(this.chestGroup.matrixWorld));

    const addrGripLocal = toRigLocal(addrGripInChest.clone().applyMatrix4(this.chestGroup.matrixWorld));
    const ballLocal = new THREE.Vector3(standDist, 0.015, 0.0);

    const chestQuat = new THREE.Quaternion().setFromRotationMatrix(this.chestGroup.matrixWorld);
    const rootInvQuat = new THREE.Quaternion().setFromRotationMatrix(rootInvMat);
    const chestToRootQuat = rootInvQuat.multiply(chestQuat);

    const chestShaftDir = new THREE.Vector3(0.70, -0.71, 0.0).normalize();
    let shaftDir = chestShaftDir.clone().applyQuaternion(chestToRootQuat);

    // At address & impact, aim shaft cleanly through ballLocal; during swing, apply wrist cock + arm sweep
    const impactAlign = 1 - Math.min(1, Math.abs(armSweep) * 2.5);
    const exactAddrShaft = new THREE.Vector3().subVectors(ballLocal, addrGripLocal).normalize();
    shaftDir.lerp(exactAddrShaft, impactAlign).normalize();

    if (isPutt) {
      // Negative angle around +X sweeps the putter head backward (+Z) on backswing and forward (-Z) on follow-through!
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

    // Fine-tune grip height along shaft near address/impact so clubhead sits flush at ball height
    if (impactAlign > 0.5) {
      const distToBall = gripCenterLocal.distanceTo(ballLocal);
      const gripAdjust = Math.max(-0.04, Math.min(0.05, shaftLen - distToBall));
      gripCenterLocal.addScaledVector(shaftDir, -gripAdjust * impactAlign);
    }

    const shaftUp = shaftDir.clone().negate();
    this.clubMount.position.copy(gripCenterLocal);
    const clubX = new THREE.Vector3().crossVectors(shaftUp, new THREE.Vector3(0, 0, 1));
    if (clubX.lengthSq() < 1e-5) clubX.set(1, 0, 0);
    clubX.normalize();
    const clubZ = new THREE.Vector3().crossVectors(clubX, shaftUp).normalize();
    this.clubMount.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(clubX, shaftUp, clubZ));
    this.clubMount.rotateOnAxis(new THREE.Vector3(0, 1, 0), faceRoll);

    // Exact grip hand positions along shaft (Lead hand top, Trail hand 8 cm below)
    const leadHandPos = gripCenterLocal.clone().addScaledVector(shaftUp, 0.035);
    const trailHandPos = gripCenterLocal.clone().addScaledVector(shaftUp, -0.045);

    // Transform elbow hints cleanly with chest orientation so elbows never invert behind ribcage!
    const leadElbowHint = new THREE.Vector3(-0.25, -0.35, -0.85).applyQuaternion(chestToRootQuat);
    const trailElbowHint = new THREE.Vector3(-0.55, -0.45, 0.75).applyQuaternion(chestToRootQuat);

    const leadElbowLocal = solveTwoBoneIK(
      leadShoulderLocal,
      leadHandPos,
      this.upperArmLen,
      this.forearmLen,
      leadElbowHint
    );
    const trailElbowLocal = solveTwoBoneIK(
      trailShoulderLocal,
      trailHandPos,
      this.upperArmLen,
      this.forearmLen,
      trailElbowHint
    );

    const armFace = new THREE.Vector3(1, 0, 0);
    orientLimbMesh(this.leftUpperArmGroup, leadShoulderLocal, leadElbowLocal, armFace);
    orientLimbMesh(this.leftForearmMesh, leadElbowLocal, leadHandPos, armFace);
    orientLimbMesh(this.rightUpperArmGroup, trailShoulderLocal, trailElbowLocal, armFace);
    orientLimbMesh(this.rightForearmMesh, trailElbowLocal, trailHandPos, armFace);

    const handFace = clubX.clone();
    orientLimbMesh(this.leftHandGroup, leadHandPos, leadHandPos.clone().addScaledVector(shaftDir, 0.08), handFace);
    orientLimbMesh(this.rightHandGroup, trailHandPos, trailHandPos.clone().addScaledVector(shaftDir, 0.08), handFace);
  }

  public dispose(): void {
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
      if ((o as THREE.Mesh).material) {
        const m = (o as THREE.Mesh).material;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else m.dispose();
      }
    });
  }
}
