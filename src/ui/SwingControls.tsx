import React, { useEffect, useRef, useState } from 'react';
import { ChevronUp, Crosshair, Film, Play, Sliders, RotateCw, RotateCcw, Square } from 'lucide-react';
import type { EngineSnapshot } from '../engine/GolfEngine';
import { SHOT_TYPE_PRESETS, type ShotTypeId } from '../physics/clubs';
import { useIsMobile } from './useIsMobile';

export interface ShotExecutionInput {
  powerRatio: number;
  clubPathDeg: number;
  faceAngleDeg: number;
  attackAngleDeltaDeg: number;
  dynamicLoftDeltaDeg: number;
  strikeOffsetXMm: number;
  strikeOffsetYMm: number;
}

interface SwingControlsProps {
  snap: EngineSnapshot;
  onAdjustAim: (deltaRad: number) => void;
  onUpdatePreview: (overrides: Partial<ShotExecutionInput>) => void;
  onExecuteShot: (input: ShotExecutionInput) => void;
  onReplayShot: () => void;
  onStopReplay: () => void;
  onContinueHoled: () => void;
}

type SwingInputMode = 'three_click' | 'mouse_drag' | 'pro_sim';

export const SwingControls: React.FC<SwingControlsProps> = ({
  snap,
  onAdjustAim,
  onUpdatePreview,
  onExecuteShot,
  onReplayShot,
  onStopReplay,
  onContinueHoled,
}) => {
  const [mode, setMode] = useState<SwingInputMode>('three_click');
  const [showProDrawer, setShowProDrawer] = useState(false);
  const [shotType, setShotType] = useState<ShotTypeId>('full');

  // Pro TrackMan Shaping Parameters
  const [proPowerPct, setProPowerPct] = useState(100);
  const [clubPathDeg, setClubPathDeg] = useState(0);
  const [faceAngleDeg, setFaceAngleDeg] = useState(0);
  const [attackAngleDeltaDeg, setAttackAngleDeltaDeg] = useState(0);
  const [dynamicLoftDeltaDeg, setDynamicLoftDeltaDeg] = useState(0);
  const [strikeOffsetXMm, setStrikeOffsetXMm] = useState(0);
  const [strikeOffsetYMm, setStrikeOffsetYMm] = useState(0);

  // 3-Click Timing Meter State
  const [clickStage, setClickStage] = useState<'idle' | 'power' | 'accuracy'>('idle');
  const [meterPower, setMeterPower] = useState(0); // 0..1.05
  const [meterAcc, setMeterAcc] = useState(0); // -1..+1 (0 is pure sweet spot)
  const lockedPowerRef = useRef(0.9);
  const animRef = useRef<number | null>(null);

  // Mouse-Drag Swing State
  const [dragActive, setDragActive] = useState(false);
  const [dragPullPct, setDragPullPct] = useState(0);
  const [dragPathTilt, setDragPathTilt] = useState(0);
  const dragStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  const isReady = snap.playState === 'ready';
  const isPutting = snap.selectedClub.category === 'putter';
  const isMobile = useIsMobile();

  // Auto-suggest putting power based on pin distance
  const distM = snap.distanceToPinYds * 0.9144;
  const suggestedPuttPct = Math.min(100, Math.max(12, Math.round(Math.sqrt(distM / 22) * 100)));

  useEffect(() => {
    if (isPutting) {
      setShotType('full');
      setProPowerPct(suggestedPuttPct);
      setDynamicLoftDeltaDeg(0);
      setAttackAngleDeltaDeg(0);
    } else if (snap.distanceToPinYds < 32 && snap.lieSurface !== 'tee') {
      const preset = SHOT_TYPE_PRESETS.find((p) => p.id === 'pitch')!;
      setShotType('pitch');
      setProPowerPct(Math.max(22, Math.min(68, Math.round(snap.distanceToPinYds * 1.45))));
      setDynamicLoftDeltaDeg(preset.dynamicLoftDeltaDeg);
      setAttackAngleDeltaDeg(preset.attackAngleDeltaDeg);
    } else {
      setShotType('full');
      setProPowerPct(100);
      setDynamicLoftDeltaDeg(0);
      setAttackAngleDeltaDeg(0);
    }
  }, [isPutting, snap.hole.id, snap.strokesOnHole]);

  const applyShotType = (id: ShotTypeId) => {
    setShotType(id);
    const p = SHOT_TYPE_PRESETS.find((s) => s.id === id) ?? SHOT_TYPE_PRESETS[0];
    setProPowerPct(p.defaultPowerPct);
    setDynamicLoftDeltaDeg(p.dynamicLoftDeltaDeg);
    setAttackAngleDeltaDeg(p.attackAngleDeltaDeg);
  };

  // Sync Pro Sim sliders to 3D aim preview arc
  useEffect(() => {
    onUpdatePreview({
      powerRatio: proPowerPct / 100,
      clubPathDeg,
      faceAngleDeg,
      attackAngleDeltaDeg,
      dynamicLoftDeltaDeg,
      strikeOffsetXMm,
      strikeOffsetYMm,
    });
  }, [
    proPowerPct,
    clubPathDeg,
    faceAngleDeg,
    attackAngleDeltaDeg,
    dynamicLoftDeltaDeg,
    strikeOffsetXMm,
    strikeOffsetYMm,
    snap.selectedClub.id,
    snap.aimYawRad,
  ]);

  // 3-Click Animation Loop
  useEffect(() => {
    if (clickStage === 'idle') {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      return;
    }

    let lastT = performance.now();
    let powerVal = 0.04;
    let powerDir = 1;
    let accVal = 0.95;
    let accDir = -1;

    const step = (now: number) => {
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;

      if (clickStage === 'power') {
        powerVal += powerDir * dt * (isPutting ? 0.85 : 1.05);
        if (powerVal >= 1.06) {
          powerVal = 1.06;
          powerDir = -1;
        } else if (powerVal <= 0.04) {
          powerVal = 0.04;
          powerDir = 1;
        }
        setMeterPower(powerVal);
      } else if (clickStage === 'accuracy') {
        accVal += accDir * dt * (isPutting ? 1.55 : 2.15);
        if (accVal <= -1.0) {
          // Missed window past far left -> auto-fire hook miss!
          triggerThreeClickStrike(lockedPowerRef.current, -0.75);
          return;
        }
        setMeterAcc(accVal);
      }
      animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [clickStage, isPutting]);

  const triggerThreeClickStrike = (powerRatio: number, accOffset: number) => {
    setClickStage('idle');
    setMeterPower(0);
    setMeterAcc(0);
    // accOffset in [-1, 1] maps smoothly to face-angle miss & strike quality
    const timingFaceErrDeg = accOffset * 5.5;
    const timingStrikeMm = accOffset * 8.5;
    onExecuteShot({
      powerRatio,
      clubPathDeg,
      faceAngleDeg: faceAngleDeg + timingFaceErrDeg,
      attackAngleDeltaDeg,
      dynamicLoftDeltaDeg,
      strikeOffsetXMm: strikeOffsetXMm + timingStrikeMm,
      strikeOffsetYMm,
    });
  };

  const handleThreeClickAction = () => {
    if (!isReady) return;
    if (clickStage === 'idle') {
      setClickStage('power');
    } else if (clickStage === 'power') {
      lockedPowerRef.current = Math.max(0.08, meterPower);
      setClickStage('accuracy');
    } else if (clickStage === 'accuracy') {
      triggerThreeClickStrike(lockedPowerRef.current, meterAcc);
    }
  };

  // Spacebar shortcut for 3-Click Swing & Arrow Keys for Aim
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space' && mode === 'three_click' && isReady) {
        e.preventDefault();
        handleThreeClickAction();
      } else if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
        onAdjustAim(-0.025);
      } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
        onAdjustAim(0.025);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Mouse Drag Handlers
  const handleDragPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isReady) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragActive(true);
    setDragPullPct(0);
    setDragPathTilt(0);
    dragStartRef.current = { x: e.clientX, y: e.clientY, time: performance.now() };
  };

  const handleDragPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragActive || !dragStartRef.current) return;
    const dy = e.clientY - dragStartRef.current.y; // pull DOWN = positive dy
    const dx = e.clientX - dragStartRef.current.x;
    const pct = Math.min(108, Math.max(0, (dy / 115) * 100));
    setDragPullPct(pct);
    setDragPathTilt(Math.max(-8, Math.min(8, (dx / 65) * 8)));
  };

  const handleDragPointerUp = () => {
    if (!dragActive) return;
    setDragActive(false);
    if (dragPullPct >= 10) {
      onExecuteShot({
        powerRatio: Math.max(0.08, dragPullPct / 100),
        clubPathDeg: clubPathDeg + dragPathTilt * 0.65,
        faceAngleDeg: faceAngleDeg + dragPathTilt * 0.25,
        attackAngleDeltaDeg,
        dynamicLoftDeltaDeg,
        strikeOffsetXMm,
        strikeOffsetYMm,
      });
    }
    setDragPullPct(0);
    setDragPathTilt(0);
  };

  const fireProShot = () => {
    if (!isReady) return;
    onExecuteShot({
      powerRatio: proPowerPct / 100,
      clubPathDeg,
      faceAngleDeg,
      attackAngleDeltaDeg,
      dynamicLoftDeltaDeg,
      strikeOffsetXMm,
      strikeOffsetYMm,
    });
  };

  const faceToPath = faceAngleDeg - clubPathDeg;
  const shapeLabel =
    Math.abs(faceToPath) < 1.0 && Math.abs(faceAngleDeg) < 1.2
      ? 'Straight'
      : faceToPath > 3.5
        ? 'Heavy Fade / Slice'
        : faceToPath > 1.0
          ? 'Controlled Fade'
          : faceToPath < -3.5
            ? 'Hard Draw / Hook'
            : 'Tour Draw';

  if (snap.playState === 'replaying') {
    return (
      <div className="pointer-events-auto fixed bottom-5 left-1/2 z-30 -translate-x-1/2">
        <div className="hud-glass flex items-center gap-3 rounded-full px-4 py-2 text-xs font-bold text-white shadow-2xl">
          <Film className="h-4 w-4 animate-pulse text-sky-300" />
          <span className="uppercase tracking-wider text-sky-200">Broadcast Replay</span>
          <button
            onClick={onStopReplay}
            className="flex items-center gap-1 rounded-full bg-rose-500/85 px-3 py-1 text-[11px] font-extrabold text-white hover:bg-rose-400"
          >
            <Square className="h-3 w-3 fill-current" />
            Exit
          </button>
        </div>
      </div>
    );
  }

  if (snap.playState === 'holed_out') {
    const scoreDiff = snap.strokesOnHole - snap.hole.par;
    const term =
      snap.strokesOnHole === 1
        ? 'HOLE IN ONE!'
        : scoreDiff <= -3
          ? 'ALBATROSS!'
          : scoreDiff === -2
            ? 'EAGLE!'
            : scoreDiff === -1
              ? 'BIRDIE!'
              : scoreDiff === 0
                ? 'PAR'
                : scoreDiff === 1
                  ? 'BOGEY'
                  : `+${scoreDiff}`;

    return (
      <div className="pointer-events-auto fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
        <div className="hud-glass flex flex-col items-center gap-3 rounded-3xl px-8 py-5 text-center shadow-2xl">
          <div className="text-xs font-bold uppercase tracking-widest text-emerald-300">
            Hole {snap.hole.holeNumber} · {snap.hole.name}
          </div>
          <div className="text-3xl font-black tracking-tight text-white">{term}</div>
          <div className="text-sm text-slate-300">
            Finished in <span className="font-bold text-white">{snap.strokesOnHole}</span> strokes (Par {snap.hole.par})
          </div>
          <div className="flex items-center gap-2 text-[11px] font-semibold">
            {snap.hole.par >= 4 && (
              <span
                className={`rounded-full px-2.5 py-0.5 ${
                  snap.holeMeta.fairwayHit
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : 'bg-white/10 text-slate-400'
                }`}
              >
                FIR {snap.holeMeta.fairwayHit ? '✓' : '✕'}
              </span>
            )}
            <span
              className={`rounded-full px-2.5 py-0.5 ${
                snap.holeMeta.greenInRegulation
                  ? 'bg-sky-500/20 text-sky-300'
                  : 'bg-white/10 text-slate-400'
              }`}
            >
              GIR {snap.holeMeta.greenInRegulation ? '✓' : '✕'}
            </span>
            <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-slate-200 tabular-nums">
              {snap.holeMeta.putts} {snap.holeMeta.putts === 1 ? 'Putt' : 'Putts'}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            {snap.canReplay && (
              <button
                onClick={onReplayShot}
                className="flex items-center gap-1.5 rounded-xl bg-white/10 px-4 py-2.5 text-xs font-bold text-sky-200 hover:bg-white/20"
              >
                <Film className="h-3.5 w-3.5" />
                Replay
              </button>
            )}
            <button
              onClick={onContinueHoled}
              className="rounded-xl bg-emerald-500 px-6 py-2.5 text-sm font-bold text-slate-950 shadow-lg transition hover:bg-emerald-400"
            >
              Continue to Next Hole
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed bottom-3 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-2">
      {snap.shotEventLabel && (
        <div className="rounded-full border border-amber-400/40 bg-slate-900/90 px-4 py-1 text-xs font-extrabold tracking-wide text-amber-300 shadow-lg backdrop-blur">
          {snap.shotEventLabel}
        </div>
      )}
      {/* Pro TrackMan Shot Shaping Drawer */}
      {(showProDrawer || mode === 'pro_sim') && (
        <div className="pointer-events-auto hud-glass w-[440px] max-w-[92vw] rounded-2xl p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sliders className="h-3.5 w-3.5 text-sky-400" />
              <span className="text-xs font-bold uppercase tracking-wider text-white">
                Pro TrackMan Shot Shaping
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-sky-500/20 px-2 py-0.5 text-[10px] font-bold text-sky-300">
                {shapeLabel}
              </span>
              <button
                onClick={() => {
                  setClubPathDeg(0);
                  setFaceAngleDeg(0);
                  setAttackAngleDeltaDeg(0);
                  setDynamicLoftDeltaDeg(0);
                  setStrikeOffsetXMm(0);
                  setStrikeOffsetYMm(0);
                }}
                className="text-[10px] text-slate-400 hover:text-white"
              >
                Zero
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
            <div>
              <div className="flex justify-between text-slate-300">
                <span>Swing Power</span>
                <span className="font-bold text-sky-300 tabular-nums">{proPowerPct}%</span>
              </div>
              <input
                type="range"
                min={10}
                max={112}
                value={proPowerPct}
                onChange={(e) => setProPowerPct(Number(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <div className="flex justify-between text-slate-300">
                <span>Club Path</span>
                <span className="font-bold text-white tabular-nums">
                  {clubPathDeg > 0 ? `+${clubPathDeg}° In-Out` : clubPathDeg < 0 ? `${clubPathDeg}° Out-In` : '0.0°'}
                </span>
              </div>
              <input
                type="range"
                min={-8}
                max={8}
                step={0.5}
                value={clubPathDeg}
                onChange={(e) => setClubPathDeg(Number(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <div className="flex justify-between text-slate-300">
                <span>Face Angle</span>
                <span className="font-bold text-white tabular-nums">
                  {faceAngleDeg > 0 ? `+${faceAngleDeg}° Open` : faceAngleDeg < 0 ? `${faceAngleDeg}° Closed` : '0.0°'}
                </span>
              </div>
              <input
                type="range"
                min={-8}
                max={8}
                step={0.5}
                value={faceAngleDeg}
                onChange={(e) => setFaceAngleDeg(Number(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <div className="flex justify-between text-slate-300">
                <span>Dynamic Loft</span>
                <span className="font-bold text-white tabular-nums">
                  {dynamicLoftDeltaDeg >= 0 ? `+${dynamicLoftDeltaDeg}°` : `${dynamicLoftDeltaDeg}°`}
                </span>
              </div>
              <input
                type="range"
                min={-6}
                max={8}
                step={0.5}
                value={dynamicLoftDeltaDeg}
                onChange={(e) => setDynamicLoftDeltaDeg(Number(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <div className="flex justify-between text-slate-300">
                <span>Attack Angle Δ</span>
                <span className="font-bold text-white tabular-nums">
                  {(snap.selectedClub.tourAttackAngleDeg + attackAngleDeltaDeg).toFixed(1)}°
                </span>
              </div>
              <input
                type="range"
                min={-5}
                max={5}
                step={0.5}
                value={attackAngleDeltaDeg}
                onChange={(e) => setAttackAngleDeltaDeg(Number(e.target.value))}
                className="w-full"
              />
            </div>

            {/* Interactive Clubface Sweet-Spot Strike Selector */}
            <div className="flex items-center justify-between gap-2 rounded-xl bg-white/5 px-2.5 py-1">
              <div>
                <div className="text-[10px] font-semibold text-slate-300">Face Strike</div>
                <div className="text-[10px] text-slate-400 tabular-nums">
                  {strikeOffsetXMm > 0 ? 'Toe' : strikeOffsetXMm < 0 ? 'Heel' : 'Center'} ({strikeOffsetXMm}mm)
                </div>
              </div>
              <div
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
                  const ny = 1 - ((e.clientY - r.top) / r.height) * 2;
                  setStrikeOffsetXMm(Math.round(nx * 14));
                  setStrikeOffsetYMm(Math.round(ny * 10));
                }}
                className="relative h-9 w-14 cursor-crosshair rounded border border-slate-500/60 bg-slate-800/80"
                title="Click clubface to test Heel/Toe gear effect"
              >
                <div className="absolute inset-x-2 top-1/2 h-px bg-slate-500/40" />
                <div className="absolute inset-y-1.5 left-1/2 w-px bg-slate-500/40" />
                <div
                  className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400 shadow"
                  style={{
                    left: `${50 + (strikeOffsetXMm / 14) * 45}%`,
                    top: `${50 - (strikeOffsetYMm / 10) * 45}%`,
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Swing Controller Dock — compact pill bar when idle, expanding seamlessly when clicked or swinging */}
      <div className="pointer-events-auto hud-glass flex flex-col gap-1.5 rounded-2xl px-3 py-2 max-w-[92vw]">
        {!isPutting && isReady && (
          <div className="flex flex-wrap items-center justify-center gap-1 border-b border-white/10 pb-1.5">
            {SHOT_TYPE_PRESETS.map((st) => (
              <button
                key={st.id}
                onClick={() => applyShotType(st.id)}
                title={st.shortDesc}
                className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold transition ${
                  shotType === st.id
                    ? 'bg-sky-500 text-slate-950'
                    : 'bg-white/5 text-slate-300 hover:bg-white/15'
                }`}
              >
                {st.label}
              </button>
            ))}
          </div>
        )}
        {showProDrawer && mode !== 'pro_sim' && (
          <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
            <div className="flex items-center gap-1 rounded-xl bg-white/5 p-0.5">
              {(
                [
                  { id: 'three_click', label: '3-Click' },
                  { id: 'mouse_drag', label: 'Drag Swing' },
                  { id: 'pro_sim', label: 'Pro Sim' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setMode(m.id);
                    setClickStage('idle');
                  }}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                    mode === m.id
                      ? 'bg-sky-500 text-slate-950'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-slate-400">Spacebar / Click to Hit</span>
          </div>
        )}

        {mode === 'pro_sim' && (
          <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
            <div className="flex items-center gap-1 rounded-xl bg-white/5 p-0.5">
              {(
                [
                  { id: 'three_click', label: '3-Click' },
                  { id: 'mouse_drag', label: 'Drag Swing' },
                  { id: 'pro_sim', label: 'Pro Sim' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setMode(m.id);
                    setClickStage('idle');
                  }}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                    mode === m.id
                      ? 'bg-sky-500 text-slate-950'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Slim Action Row */}
        {mode === 'three_click' && (
          <div className="flex items-center gap-2">
            {!(isMobile && clickStage !== 'idle') && (
              <div className="flex items-center gap-1">
                <button
                  disabled={!isReady}
                  onClick={() => onAdjustAim(-0.035)}
                  title="Aim Left (A / Left Arrow)"
                  className="rounded-lg bg-white/5 p-1.5 text-slate-300 hover:bg-white/15 disabled:opacity-40"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <span className="px-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Aim
                </span>
                <button
                  disabled={!isReady}
                  onClick={() => onAdjustAim(0.035)}
                  title="Aim Right (D / Right Arrow)"
                  className="rounded-lg bg-white/5 p-1.5 text-slate-300 hover:bg-white/15 disabled:opacity-40"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {clickStage !== 'idle' && (
              <div
                className={`relative h-8 ${isMobile ? 'w-40' : 'w-52 sm:w-64'} overflow-hidden rounded-xl border border-white/15 bg-slate-950/80`}
              >
                <div
                  className="absolute inset-y-0 bg-emerald-500/30 border-x border-emerald-400/60"
                  style={{ left: '10%', width: '10%' }}
                />
                <div
                  className="absolute inset-y-0 w-0.5 bg-amber-400/80"
                  style={{
                    left: `${Math.min(
                      95,
                      15 + (isPutting ? suggestedPuttPct : proPowerPct) * 0.8
                    )}%`,
                  }}
                />
                <div
                  className="absolute inset-y-1 rounded-lg bg-gradient-to-r from-sky-500 via-emerald-400 to-amber-400 transition-none"
                  style={{
                    left: '15%',
                    width: `${Math.max(0, meterPower) * 80}%`,
                    opacity: 0.9,
                  }}
                />
                {clickStage === 'accuracy' && (
                  <div
                    className="absolute inset-y-0 w-1.5 -translate-x-1/2 rounded bg-white shadow-[0_0_8px_#fff]"
                    style={{ left: `${15 + meterAcc * 14}%` }}
                  />
                )}
                <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-200/90">
                  <span>Sweet</span>
                  <span className="tabular-nums">
                    {clickStage === 'power'
                      ? `${Math.round(meterPower * 100)}%`
                      : 'Snap!'}
                  </span>
                </div>
              </div>
            )}

            <button
              disabled={!isReady}
              onClick={handleThreeClickAction}
              className="min-w-[84px] rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 shadow-lg transition hover:bg-emerald-400 active:scale-95 disabled:opacity-40"
            >
              {clickStage === 'idle'
                ? isPutting
                  ? 'Putt'
                  : 'Swing'
                : clickStage === 'power'
                  ? 'Set Power'
                  : 'Strike!'}
            </button>

            {!(isMobile && clickStage !== 'idle') && (
              <button
                onClick={() => setShowProDrawer((v) => !v)}
                className={`flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[11px] font-semibold transition ${
                  showProDrawer
                    ? 'bg-amber-400/20 text-amber-300 ring-1 ring-amber-400/40'
                    : 'bg-white/5 text-slate-300 hover:bg-white/15'
                }`}
                title="Swing Mode & Shot Shaping"
              >
                {!isMobile && <span>Controls</span>}
                <ChevronUp
                  className={`h-3 w-3 transition-transform ${showProDrawer ? 'rotate-180' : ''}`}
                />
              </button>
            )}
          </div>
        )}

        {mode === 'mouse_drag' && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <button
                disabled={!isReady}
                onClick={() => onAdjustAim(-0.035)}
                className="rounded-lg bg-white/5 p-1.5 text-slate-300 hover:bg-white/15 disabled:opacity-40"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <button
                disabled={!isReady}
                onClick={() => onAdjustAim(0.035)}
                className="rounded-lg bg-white/5 p-1.5 text-slate-300 hover:bg-white/15 disabled:opacity-40"
              >
                <RotateCw className="h-3.5 w-3.5" />
              </button>
            </div>
            <div
              onPointerDown={handleDragPointerDown}
              onPointerMove={handleDragPointerMove}
              onPointerUp={handleDragPointerUp}
              onPointerCancel={handleDragPointerUp}
              className={`relative flex h-10 ${isMobile ? 'w-44' : 'w-64'} cursor-grab items-center justify-between rounded-xl border px-3 transition select-none touch-none ${
                dragActive
                  ? 'cursor-grabbing border-emerald-400 bg-emerald-500/20'
                  : 'border-white/15 bg-slate-900/70 hover:border-sky-400/40'
              }`}
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <Crosshair className="h-3.5 w-3.5 text-sky-400" />
                <span>
                  {dragActive
                    ? `Pull ${Math.round(dragPullPct)}%`
                    : isReady
                      ? 'Pull Down & Release'
                      : 'Flying...'}
                </span>
              </div>
              <div className="h-2 w-16 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-gradient-to-r from-sky-400 to-emerald-400"
                  style={{ width: `${Math.min(100, dragPullPct)}%` }}
                />
              </div>
            </div>
            <button
              onClick={() => setShowProDrawer((v) => !v)}
              className={`flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[11px] font-semibold transition ${
                showProDrawer
                  ? 'bg-amber-400/20 text-amber-300 ring-1 ring-amber-400/40'
                  : 'bg-white/5 text-slate-300 hover:bg-white/15'
              }`}
            >
              {!isMobile && <span>Controls</span>}
              <ChevronUp
                className={`h-3 w-3 transition-transform ${showProDrawer ? 'rotate-180' : ''}`}
              />
            </button>
          </div>
        )}

        {mode === 'pro_sim' && (
          <div className="flex items-center gap-2">
            <button
              disabled={!isReady}
              onClick={() => onAdjustAim(-0.035)}
              className="rounded-lg bg-white/5 p-1.5 text-slate-300 hover:bg-white/15 disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              disabled={!isReady}
              onClick={() => onAdjustAim(0.035)}
              className="rounded-lg bg-white/5 p-1.5 text-slate-300 hover:bg-white/15 disabled:opacity-40"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
            <button
              disabled={!isReady}
              onClick={fireProShot}
              className="flex flex-1 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-sky-500 to-emerald-500 px-4 py-1.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 shadow-lg transition hover:brightness-110 active:scale-[0.99] disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              <span>
                Launch Shot ({proPowerPct}% · {shapeLabel})
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
