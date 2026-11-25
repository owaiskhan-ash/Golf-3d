import * as THREE from 'three';

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  r: number;
  g: number;
  b: number;
}

export class ParticleEffectsSystem {
  private particles: Particle[] = [];
  private instancedMesh: THREE.InstancedMesh;
  private readonly maxParticles = 320;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(private readonly scene: THREE.Scene) {
    const geo = new THREE.DodecahedronGeometry(0.03, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.0,
    });
    this.instancedMesh = new THREE.InstancedMesh(geo, mat, this.maxParticles);
    this.instancedMesh.count = 0;
    this.instancedMesh.frustumCulled = false;
    this.scene.add(this.instancedMesh);
  }

  public emitTurfDivot(pos: { x: number; y: number; z: number }, aimYawRad: number, intensity = 1): void {
    const fwdX = Math.sin(aimYawRad);
    const fwdZ = -Math.cos(aimYawRad);
    const count = Math.round(28 * intensity);
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= this.maxParticles) this.particles.shift();
      const spread = (Math.random() - 0.5) * 0.9;
      const spd = (3.5 + Math.random() * 6.5) * intensity;
      const isSoil = Math.random() > 0.55;
      this.particles.push({
        x: pos.x + (Math.random() - 0.5) * 0.08,
        y: pos.y + 0.02,
        z: pos.z + (Math.random() - 0.5) * 0.08,
        vx: (fwdX + spread * 0.35) * spd,
        vy: 2.2 + Math.random() * 4.5 * intensity,
        vz: (fwdZ + spread * 0.35) * spd,
        life: 0,
        maxLife: 0.55 + Math.random() * 0.55,
        size: isSoil ? 0.55 + Math.random() * 0.65 : 0.4 + Math.random() * 0.5,
        r: isSoil ? 0.24 : 0.16,
        g: isSoil ? 0.18 : 0.42,
        b: isSoil ? 0.11 : 0.12,
      });
    }
  }

  public emitSandSplash(pos: { x: number; y: number; z: number }, dirYawRad: number, intensity = 1): void {
    const fwdX = Math.sin(dirYawRad);
    const fwdZ = -Math.cos(dirYawRad);
    const count = Math.round(52 * intensity);
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= this.maxParticles) this.particles.shift();
      const ang = Math.random() * Math.PI * 2;
      const radSpd = 0.8 + Math.random() * 3.8 * intensity;
      this.particles.push({
        x: pos.x + (Math.random() - 0.5) * 0.15,
        y: pos.y + 0.02,
        z: pos.z + (Math.random() - 0.5) * 0.15,
        vx: Math.cos(ang) * radSpd + fwdX * 2.5 * intensity,
        vy: 2.8 + Math.random() * 5.2 * intensity,
        vz: Math.sin(ang) * radSpd + fwdZ * 2.5 * intensity,
        life: 0,
        maxLife: 0.6 + Math.random() * 0.65,
        size: 0.45 + Math.random() * 0.85,
        r: 0.88,
        g: 0.82,
        b: 0.66,
      });
    }
  }

  public emitWaterSplash(pos: { x: number; y: number; z: number }): void {
    for (let i = 0; i < 72; i++) {
      if (this.particles.length >= this.maxParticles) this.particles.shift();
      const ang = Math.random() * Math.PI * 2;
      const spd = 1.2 + Math.random() * 4.5;
      this.particles.push({
        x: pos.x,
        y: 0.15,
        z: pos.z,
        vx: Math.cos(ang) * spd,
        vy: 4.0 + Math.random() * 7.5,
        vz: Math.sin(ang) * spd,
        life: 0,
        maxLife: 0.75 + Math.random() * 0.6,
        size: 0.75 + Math.random() * 1.4,
        r: 0.85,
        g: 0.94,
        b: 0.99,
      });
    }
  }

  public emitLeafBurst(pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }): void {
    for (let i = 0; i < 34; i++) {
      if (this.particles.length >= this.maxParticles) this.particles.shift();
      const ang = Math.random() * Math.PI * 2;
      const spd = 0.8 + Math.random() * 3.4;
      const isNeedle = Math.random() > 0.35;
      this.particles.push({
        x: pos.x + (Math.random() - 0.5) * 0.5,
        y: pos.y + (Math.random() - 0.5) * 0.4,
        z: pos.z + (Math.random() - 0.5) * 0.5,
        vx: Math.cos(ang) * spd + vel.x * 0.14,
        vy: (Math.random() - 0.25) * 2.4,
        vz: Math.sin(ang) * spd + vel.z * 0.14,
        life: 0,
        maxLife: 0.85 + Math.random() * 0.75,
        size: 0.42 + Math.random() * 0.45,
        r: isNeedle ? 0.14 : 0.28,
        g: isNeedle ? 0.34 : 0.24,
        b: isNeedle ? 0.15 : 0.12,
      });
    }
  }

  public emitRockSpark(pos: { x: number; y: number; z: number }): void {
    for (let i = 0; i < 20; i++) {
      if (this.particles.length >= this.maxParticles) this.particles.shift();
      const ang = Math.random() * Math.PI * 2;
      const spd = 1.5 + Math.random() * 4.5;
      this.particles.push({
        x: pos.x,
        y: pos.y,
        z: pos.z,
        vx: Math.cos(ang) * spd,
        vy: 1.8 + Math.random() * 4.0,
        vz: Math.sin(ang) * spd,
        life: 0,
        maxLife: 0.4 + Math.random() * 0.4,
        size: 0.35 + Math.random() * 0.4,
        r: 0.72,
        g: 0.68,
        b: 0.62,
      });
    }
  }

  public update(dt: number): void {
    if (this.particles.length === 0) {
      this.instancedMesh.count = 0;
      return;
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy -= 9.81 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
    }

    const count = Math.min(this.maxParticles, this.particles.length);
    for (let i = 0; i < count; i++) {
      const p = this.particles[i];
      const fade = 1 - p.life / p.maxLife;
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.scale.setScalar(p.size * (0.4 + 0.6 * fade));
      this.dummy.rotation.set(p.life * 4, p.life * 3, 0);
      this.dummy.updateMatrix();
      this.instancedMesh.setMatrixAt(i, this.dummy.matrix);
      this.color.setRGB(p.r, p.g, p.b);
      this.instancedMesh.setColorAt(i, this.color);
    }

    this.instancedMesh.count = count;
    this.instancedMesh.instanceMatrix.needsUpdate = true;
    if (this.instancedMesh.instanceColor) this.instancedMesh.instanceColor.needsUpdate = true;
  }

  public clear(): void {
    this.particles = [];
    this.instancedMesh.count = 0;
  }

  public dispose(): void {
    this.scene.remove(this.instancedMesh);
    this.instancedMesh.geometry.dispose();
    (this.instancedMesh.material as THREE.Material).dispose();
  }
}
