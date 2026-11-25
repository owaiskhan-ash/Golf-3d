import type { ClubCategory } from '../physics/clubs';
import type { SurfaceType } from '../physics/surfaces';

/**
 * Procedural Web Audio API Golf Sound Engine — zero external audio dependencies.
 * Synthesizes realistic titanium Driver compression crack, forged Iron turf snap,
 * bunker sand splash, putter tap, turf bounces, USGA cup rattle, water splash, and gentle coastal surf.
 */
export class AudioSystem {
  private ctx: AudioContext | null = null;
  private enabled = true;
  private ambientGain: GainNode | null = null;
  private ambientFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private ambientStarted = false;

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.ctx) {
      if (this.ambientGain) {
        this.ambientGain.gain.setTargetAtTime(enabled ? 0.045 : 0.0, this.ctx.currentTime, 0.15);
      }
      if (this.windGain) {
        this.windGain.gain.setTargetAtTime(enabled ? 0.022 : 0.0, this.ctx.currentTime, 0.15);
      }
    }
  }

  public setWindIntensity(speedMps: number): void {
    if (!this.ctx || !this.windGain || !this.windFilter) return;
    const norm = Math.min(1, Math.max(0, speedMps / 12.5));
    const targetGain = this.enabled ? 0.008 + norm * 0.048 : 0.0;
    const targetFreq = 260 + norm * 620;
    this.windGain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.35);
    this.windFilter.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.35);
  }

  private ensureContext(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    if (!this.ambientStarted) {
      this.startAmbientSurf();
    }
    return this.ctx;
  }

  private startAmbientSurf(): void {
    if (!this.ctx || this.ambientStarted) return;
    this.ambientStarted = true;

    // 4-second looping pink/brown surf noise modulated by slow ocean wave LFO
    const sr = this.ctx.sampleRate;
    const len = sr * 4;
    const buffer = this.ctx.createBuffer(1, len, sr);
    const data = buffer.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.02 * white) / 1.02;
      data[i] = lastOut * 2.8;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    this.ambientFilter = filter;

    const gain = this.ctx.createGain();
    gain.gain.value = this.enabled ? 0.045 : 0.0;
    this.ambientGain = gain;

    // Slow 0.14 Hz ocean swell modulation
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.14;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain);
    lfoGain.connect(this.ambientFilter.frequency);
    lfo.start();

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    src.start();

    // Subtle wind-rush bandpass channel modulated by coastal wind speed
    const windSrc = this.ctx.createBufferSource();
    windSrc.buffer = buffer;
    windSrc.loop = true;
    const wFilt = this.ctx.createBiquadFilter();
    wFilt.type = 'bandpass';
    wFilt.frequency.value = 420;
    wFilt.Q.value = 1.4;
    this.windFilter = wFilt;
    const wGain = this.ctx.createGain();
    wGain.gain.value = this.enabled ? 0.018 : 0.0;
    this.windGain = wGain;
    windSrc.connect(wFilt);
    wFilt.connect(wGain);
    wGain.connect(this.ctx.destination);
    windSrc.start();
  }

  public playStrike(category: ClubCategory, surface: SurfaceType, powerRatio: number): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const vol = Math.min(1, 0.25 + powerRatio * 0.65);

    if (category === 'putter') {
      // Crisp milled putter "tock"
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(620, now);
      osc.frequency.exponentialRampToValueAtTime(190, now + 0.045);
      gain.gain.setValueAtTime(0.32 * vol, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.06);
      return;
    }

    // Impact transient click + metallic resonance
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    if (category === 'wood' || category === 'hybrid') {
      // Titanium hollow driver resonance (~2.4 kHz + 420 Hz body thump)
      osc.type = 'sine';
      osc.frequency.setValueAtTime(2150, now);
      osc.frequency.exponentialRampToValueAtTime(680, now + 0.14);
      oscGain.gain.setValueAtTime(0.28 * vol, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    } else {
      // Solid forged iron compression click
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1180, now);
      osc.frequency.exponentialRampToValueAtTime(240, now + 0.07);
      oscGain.gain.setValueAtTime(0.35 * vol, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    }
    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.17);

    // Turf divot or bunker sand noise burst
    const dur = surface === 'bunker' ? 0.28 : 0.14;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const arr = buf.getChannelData(0);
    for (let i = 0; i < arr.length; i++) {
      arr[i] = (Math.random() * 2 - 1) * Math.exp(-i / (arr.length * 0.35));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = surface === 'bunker' ? 1600 : 920;
    filt.Q.value = surface === 'bunker' ? 0.7 : 1.1;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime((surface === 'bunker' ? 0.55 : 0.34) * vol, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    noise.connect(filt);
    filt.connect(nGain);
    nGain.connect(ctx.destination);
    noise.start(now);
  }

  public playBounce(surface: SurfaceType, speedMps: number): void {
    const ctx = this.ensureContext();
    if (!ctx || speedMps < 0.8) return;
    const now = ctx.currentTime;
    const vol = Math.min(0.45, speedMps * 0.022);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    const startFreq = surface === 'cart_path' || surface === 'cliff_rock' ? 980 : surface === 'bunker' ? 130 : 210;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.06);
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.075);
  }

  public playCupDrop(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    // Authentic multi-bounce plastic liner + metal cup rattle!
    const times = [0, 0.065, 0.13];
    const freqs = [1150, 1480, 920];
    times.forEach((offset, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freqs[idx], now + offset);
      osc.frequency.exponentialRampToValueAtTime(340, now + offset + 0.055);
      gain.gain.setValueAtTime(0.28 / (idx + 1), now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.06);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.065);
    });
  }

  public playWaterSplash(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dur = 0.55;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const arr = buf.getChannelData(0);
    for (let i = 0; i < arr.length; i++) {
      arr[i] = (Math.random() * 2 - 1) * Math.exp(-i / (arr.length * 0.4));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(1800, now);
    filt.frequency.exponentialRampToValueAtTime(350, now + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.45, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    noise.connect(filt);
    filt.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
  }

  public playTreeRustle(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dur = 0.34;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const arr = buf.getChannelData(0);
    for (let i = 0; i < arr.length; i++) {
      const env = Math.sin((i / arr.length) * Math.PI);
      arr[i] = (Math.random() * 2 - 1) * env;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(2400, now);
    filt.Q.value = 1.6;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    noise.connect(filt);
    filt.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
  }

  public playTrunkHit(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(290, now);
    osc.frequency.exponentialRampToValueAtTime(75, now + 0.09);
    gain.gain.setValueAtTime(0.42, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  public playPinClink(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const freqs = [1880, 2740];
    freqs.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, now);
      osc.frequency.exponentialRampToValueAtTime(f * 0.88, now + 0.16);
      gain.gain.setValueAtTime(idx === 0 ? 0.24 : 0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.19);
    });
  }

  public playGullCall(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.enabled) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1650, now);
    osc.frequency.exponentialRampToValueAtTime(2180, now + 0.09);
    osc.frequency.exponentialRampToValueAtTime(1420, now + 0.26);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.032, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.30);
  }

  public playHoleCelebration(scoreDiff: number): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const notes =
      scoreDiff <= -2
        ? [523.25, 659.25, 783.99, 1046.5]
        : scoreDiff === -1
          ? [523.25, 659.25, 783.99]
          : scoreDiff === 0
            ? [440, 554.37]
            : [392, 440];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const t0 = now + i * 0.085;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.11, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.42);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.44);
    });
  }
}
