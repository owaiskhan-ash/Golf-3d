import * as THREE from 'three';
import type { Vec3 } from '../physics/aerodynamics';
import type { HoleTerrainSampler } from '../course/terrainSampler';

export class VisualAidsSystem {
  private tracerLine: THREE.Line | null = null;
  private tracerTube: THREE.Mesh | null = null;
  private previewLine: THREE.Line | null = null;
  private landingRing: THREE.Mesh;
  /** True while the mobile swipe gesture owns the landing ring (preview passes leave it alone). */
  private landingHintActive = false;
  private aimGroundLine: THREE.Line | null = null;
  private tracerHistory: THREE.Object3D[] = [];
  private dispersionMarkers: THREE.Mesh[] = [];
  public proTracerEnabled = true;

  constructor(private readonly scene: THREE.Scene) {
    const ringGeo = new THREE.RingGeometry(0.85, 1.2, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.landingRing = new THREE.Mesh(ringGeo, ringMat);
    this.landingRing.visible = false;
    this.scene.add(this.landingRing);
  }

  public updateAimPreview(
    points: Vec3[],
    landingPos: Vec3 | null,
    sampler: HoleTerrainSampler,
    isPutt: boolean,
    visible: boolean
  ): void {
    if (this.previewLine) {
      this.scene.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      (this.previewLine.material as THREE.Material).dispose();
      this.previewLine = null;
    }
    if (this.aimGroundLine) {
      this.scene.remove(this.aimGroundLine);
      this.aimGroundLine.geometry.dispose();
      (this.aimGroundLine.material as THREE.Material).dispose();
      this.aimGroundLine = null;
    }

    if (!visible || points.length < 2) {
      // Don't stomp the swipe landing hint — it owns the ring mid-gesture
      if (!this.landingHintActive) this.landingRing.visible = false;
      return;
    }

    const vecs = points.map((p) => new THREE.Vector3(p.x, p.y + (isPutt ? 0.015 : 0), p.z));
    const geo = new THREE.BufferGeometry().setFromPoints(vecs);
    const mat = new THREE.LineDashedMaterial({
      color: isPutt ? 0x34d399 : 0x7dd3fc,
      dashSize: isPutt ? 0.25 : 2.2,
      gapSize: isPutt ? 0.16 : 1.4,
      transparent: true,
      opacity: isPutt ? 0.85 : 0.65,
    });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    this.previewLine = line;
    this.scene.add(line);

    if (landingPos && !isPutt) {
      (this.landingRing.material as THREE.MeshBasicMaterial).color.set(0x38bdf8);
      const ly = sampler.getHeight(landingPos.x, landingPos.z) + 0.08;
      this.landingRing.position.set(landingPos.x, ly, landingPos.z);
      const n = sampler.getNormal(landingPos.x, landingPos.z);
      this.landingRing.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(n.x, n.y, n.z)
      );
      this.landingRing.visible = true;
    } else if (!this.landingHintActive) {
      this.landingRing.visible = false;
    }
  }

  /**
   * Mobile swipe gesture: show ONLY a predicted-landing ring (no blue arc line).
   * Emerald tint distinguishes it from the desktop aim preview. Pass null to clear.
   */
  public updateLandingHint(landingPos: Vec3 | null, sampler: HoleTerrainSampler): void {
    this.landingHintActive = landingPos !== null;
    if (!landingPos) {
      this.landingRing.visible = false;
      return;
    }
    (this.landingRing.material as THREE.MeshBasicMaterial).color.set(0x34d399);
    const ly = sampler.getHeight(landingPos.x, landingPos.z) + 0.08;
    this.landingRing.position.set(landingPos.x, ly, landingPos.z);
    const n = sampler.getNormal(landingPos.x, landingPos.z);
    this.landingRing.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(n.x, n.y, n.z)
    );
    this.landingRing.visible = true;
  }

  public updateLiveTracer(points: Vec3[], keepRibbon = true): void {
    if (this.tracerLine) {
      this.scene.remove(this.tracerLine);
      this.tracerLine.geometry.dispose();
      (this.tracerLine.material as THREE.Material).dispose();
      this.tracerLine = null;
    }
    if (this.tracerTube) {
      this.scene.remove(this.tracerTube);
      this.tracerTube.geometry.dispose();
      (this.tracerTube.material as THREE.Material).dispose();
      this.tracerTube = null;
    }

    if (!this.proTracerEnabled || points.length < 2) return;

    const vecs = points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const geo = new THREE.BufferGeometry().setFromPoints(vecs);
    // Broadcast sky-cyan -> warm gold gradient vertex colors along flight arc
    const colors = new Float32Array(vecs.length * 3);
    const cStart = new THREE.Color(0x38bdf8);
    const cMid = new THREE.Color(0xfbbf24);
    const cEnd = new THREE.Color(0x34d399);
    const cTmp = new THREE.Color();
    for (let i = 0; i < vecs.length; i++) {
      const t = i / Math.max(1, vecs.length - 1);
      if (t < 0.5) cTmp.copy(cStart).lerp(cMid, t * 2);
      else cTmp.copy(cMid).lerp(cEnd, (t - 0.5) * 2);
      colors[i * 3] = cTmp.r;
      colors[i * 3 + 1] = cTmp.g;
      colors[i * 3 + 2] = cTmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    this.tracerLine = new THREE.Line(geo, mat);
    this.scene.add(this.tracerLine);

    if (keepRibbon && vecs.length >= 4) {
      const curve = new THREE.CatmullRomCurve3(vecs);
      const segs = Math.min(96, Math.max(16, vecs.length * 2));
      const tubeGeo = new THREE.TubeGeometry(curve, segs, 0.045, 5, false);
      const tubeMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
      });
      this.tracerTube = new THREE.Mesh(tubeGeo, tubeMat);
      this.scene.add(this.tracerTube);
    }
  }

  public archiveCurrentTracer(
    points: Vec3[],
    landingPos: Vec3 | null,
    sampler: HoleTerrainSampler,
    isRange: boolean
  ): void {
    this.updateLiveTracer([], false);
    if (!this.proTracerEnabled || points.length < 2) return;

    const maxArchived = isRange ? 6 : 1;
    while (this.tracerHistory.length >= maxArchived) {
      const old = this.tracerHistory.shift()!;
      this.scene.remove(old);
      if ((old as THREE.Mesh).geometry) (old as THREE.Mesh).geometry.dispose();
      if ((old as THREE.Mesh).material) ((old as THREE.Mesh).material as THREE.Material).dispose();
    }

    const vecs = points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const geo = new THREE.BufferGeometry().setFromPoints(vecs);
    const mat = new THREE.LineBasicMaterial({
      color: isRange ? 0x7dd3fc : 0xfbbf24,
      transparent: true,
      opacity: isRange ? 0.38 : 0.45,
      depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    this.tracerHistory.push(line);
    this.scene.add(line);

    // On Driving Range, drop persistent dispersion ground rings
    if (isRange && landingPos) {
      while (this.dispersionMarkers.length >= 12) {
        const oldM = this.dispersionMarkers.shift()!;
        this.scene.remove(oldM);
        oldM.geometry.dispose();
        (oldM.material as THREE.Material).dispose();
      }
      const markerGeo = new THREE.RingGeometry(0.45, 0.72, 24);
      markerGeo.rotateX(-Math.PI / 2);
      const markerMat = new THREE.MeshBasicMaterial({
        color: 0x34d399,
        transparent: true,
        opacity: 0.75,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(markerGeo, markerMat);
      const ly = sampler.getHeight(landingPos.x, landingPos.z) + 0.06;
      ring.position.set(landingPos.x, ly, landingPos.z);
      const n = sampler.getNormal(landingPos.x, landingPos.z);
      ring.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(n.x, n.y, n.z)
      );
      this.dispersionMarkers.push(ring);
      this.scene.add(ring);
    }
  }

  public clearTracers(clearHistory = false): void {
    this.updateLiveTracer([], false);
    if (clearHistory) {
      for (const obj of this.tracerHistory) {
        this.scene.remove(obj);
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
        if ((obj as THREE.Mesh).material) ((obj as THREE.Mesh).material as THREE.Material).dispose();
      }
      this.tracerHistory = [];
      for (const m of this.dispersionMarkers) {
        this.scene.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      this.dispersionMarkers = [];
    }
  }

  public getObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [this.landingRing, ...this.tracerHistory, ...this.dispersionMarkers];
    if (this.previewLine) out.push(this.previewLine);
    if (this.aimGroundLine) out.push(this.aimGroundLine);
    if (this.tracerLine) out.push(this.tracerLine);
    if (this.tracerTube) out.push(this.tracerTube);
    return out;
  }

  public dispose(): void {
    this.clearTracers(true);
    if (this.previewLine) {
      this.scene.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      (this.previewLine.material as THREE.Material).dispose();
    }
    this.scene.remove(this.landingRing);
    this.landingRing.geometry.dispose();
    (this.landingRing.material as THREE.Material).dispose();
  }
}
