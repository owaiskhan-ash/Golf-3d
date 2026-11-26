import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  ChevronDown,
  Compass,
  Flag,
  Film,
  LifeBuoy,
  MapPin,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  Trophy,
  Undo2,
} from 'lucide-react';
import { COURSE_HOLES } from '../course/courseData';
import type { DifficultyMode } from '../course/types';
import type { EngineSnapshot } from '../engine/GolfEngine';
import type { CameraMode } from '../engine/CameraSystem';

interface TopBarProps {
  snap: EngineSnapshot;
  roundScores: Record<string, number>;
  onSelectHole: (id: string) => void;
  onCameraMode: (mode: CameraMode) => void;
  onDifficulty: (diff: DifficultyMode) => void;
  onToggleFlagstick: () => void;
  onMulligan: () => void;
  onUnplayableDrop: () => void;
  onReplayShot: () => void;
  onStopReplay: () => void;
  onResetTee: () => void;
  onOpenScorecard: () => void;
  onOpenSettings: () => void;
}

export const SURFACE_BADGES: Record<string, { label: string; color: string }> = {
  tee: { label: 'TEE', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/30' },
  fairway: { label: 'FAIRWAY', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/30' },
  fringe: { label: 'FRINGE', color: 'bg-lime-500/20 text-lime-300 border-lime-400/30' },
  green: { label: 'GREEN', color: 'bg-green-500/25 text-green-300 border-green-400/40' },
  rough: { label: 'ROUGH', color: 'bg-amber-500/20 text-amber-300 border-amber-400/30' },
  heavy_rough: { label: 'FESCUE', color: 'bg-orange-500/20 text-orange-300 border-orange-400/30' },
  bunker: { label: 'BUNKER', color: 'bg-yellow-500/20 text-yellow-200 border-yellow-400/40' },
  cliff_rock: { label: 'ROCK', color: 'bg-stone-500/30 text-stone-200 border-stone-400/40' },
  cart_path: { label: 'PATH', color: 'bg-slate-500/30 text-slate-200 border-slate-400/40' },
  water: { label: 'HAZARD', color: 'bg-sky-500/25 text-sky-200 border-sky-400/40' },
};

type OpenMenu = 'hole' | 'telemetry' | 'tools' | null;

export const TopBar: React.FC<TopBarProps> = ({
  snap,
  roundScores,
  onSelectHole,
  onCameraMode,
  onDifficulty,
  onToggleFlagstick,
  onMulligan,
  onUnplayableDrop,
  onReplayShot,
  onStopReplay,
  onResetTee,
  onOpenScorecard,
  onOpenSettings,
}) => {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  const {
    hole,
    distanceToPinYds,
    elevationToPinFt,
    lieSurface,
    lieSlopePct,
    lieUphillPct,
    lieSidePct,
    wind,
    aimYawRad,
    difficulty,
  } = snap;
  const distFeet = distanceToPinYds * 3;
  const showFeet = lieSurface === 'green' || distanceToPinYds < 25;
  const windMph = Math.round(wind.speedMps * 2.23694);
  const relWindDeg = ((wind.directionRad - aimYawRad) * 180) / Math.PI;
  const surfInfo = SURFACE_BADGES[lieSurface] ?? SURFACE_BADGES.fairway;

  const totalRoundStrokes = COURSE_HOLES.filter((h) => !h.isDrivingRange).reduce(
    (acc, h) => acc + (roundScores[h.id] ?? 0),
    0
  );
  const completedPar = COURSE_HOLES.filter((h) => !h.isDrivingRange && roundScores[h.id] > 0).reduce(
    (acc, h) => acc + h.par,
    0
  );
  const toPar = totalRoundStrokes - completedPar;
  const toParStr =
    completedPar === 0 ? 'E' : toPar === 0 ? 'E' : toPar > 0 ? `+${toPar}` : `${toPar}`;

  const camModes: Array<{ id: CameraMode; label: string }> = [
    { id: 'address', label: 'Tee / Ball' },
    { id: 'scout', label: 'Scout Orbit' },
    { id: 'green_read', label: 'Green Read' },
    { id: 'reverse', label: 'Reverse Pin' },
  ];

  const lieSlopeSummary =
    Math.abs(lieUphillPct) >= 1.5
      ? `${lieUphillPct > 0 ? '+' : ''}${lieUphillPct.toFixed(0)}%${lieUphillPct > 0 ? '↑' : '↓'}`
      : Math.abs(lieSidePct) >= 1.5
        ? `${Math.abs(lieSidePct).toFixed(0)}%${lieSidePct > 0 ? '←' : '→'}`
        : null;

  const toggle = (menu: OpenMenu) => setOpenMenu((cur) => (cur === menu ? null : menu));

  return (
    <div
      ref={barRef}
      className="pointer-events-none fixed top-0 left-0 right-0 z-30 flex items-start justify-between gap-2 p-3"
    >
      {/* Left: Hole & Course Dropdown */}
      <div className="pointer-events-auto relative">
        <button
          onClick={() => toggle('hole')}
          className={`hud-glass flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold text-white transition hover:border-sky-400/50 ${
            openMenu === 'hole' ? 'ring-1 ring-sky-400/60' : ''
          }`}
        >
          <span className="rounded-full bg-sky-500 px-2 py-0.5 text-[10px] font-black text-slate-950">
            {hole.isDrivingRange ? 'RANGE' : `H${hole.holeNumber}`}
          </span>
          <span className="tracking-tight">{hole.name}</span>
          {!hole.isDrivingRange && (
            <span className="text-[11px] font-medium text-slate-300 tabular-nums">
              · S{snap.strokesOnHole + 1} ({toParStr})
            </span>
          )}
          <ChevronDown
            className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
              openMenu === 'hole' ? 'rotate-180 text-sky-300' : ''
            }`}
          />
        </button>

        {openMenu === 'hole' && (
          <div className="hud-glass absolute top-full left-0 mt-2 w-80 rounded-2xl p-3 shadow-2xl">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                9-Hole Championship Links
              </span>
              {!hole.isDrivingRange && (
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                  Par {hole.par} · {hole.yardage}y
                </span>
              )}
            </div>
            <div className="grid grid-cols-5 gap-1.5 mb-2.5">
              {COURSE_HOLES.map((h) => {
                const active = h.id === hole.id;
                const sc = roundScores[h.id];
                return (
                  <button
                    key={h.id}
                    onClick={() => {
                      onSelectHole(h.id);
                      setOpenMenu(null);
                    }}
                    title={h.name}
                    className={`rounded-xl px-1.5 py-1.5 text-xs font-bold transition ${
                      active
                        ? 'bg-sky-500 text-slate-950 shadow-sm'
                        : sc
                          ? 'bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                          : 'bg-white/5 text-slate-300 hover:bg-white/15'
                    }`}
                  >
                    {h.isDrivingRange ? 'Lab' : `H${h.holeNumber}`}
                  </button>
                );
              })}
            </div>
            <div className="text-[11px] text-slate-300 mb-2.5">{hole.subtitle}</div>
            <div className="flex items-center justify-between border-t border-white/10 pt-2">
              <div className="text-[11px] text-slate-400">
                {hole.isDrivingRange ? (
                  'Practice Dispersion Lab'
                ) : (
                  <>
                    Stroke <span className="font-bold text-white">{snap.strokesOnHole + 1}</span> · Round{' '}
                    <span className="font-bold text-emerald-300">{toParStr}</span>
                  </>
                )}
              </div>
              <button
                onClick={() => {
                  setOpenMenu(null);
                  onOpenScorecard();
                }}
                className="flex items-center gap-1 rounded-lg bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-amber-300 hover:bg-amber-500/25"
              >
                <Trophy className="h-3 w-3" />
                Scorecard
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Center: Compact Pin, Lie & Wind Dropdown */}
      <div className="pointer-events-auto relative">
        <button
          onClick={() => toggle('telemetry')}
          className={`hud-glass flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold text-white transition hover:border-sky-400/50 ${
            openMenu === 'telemetry' ? 'ring-1 ring-sky-400/60' : ''
          }`}
        >
          <MapPin className="h-3.5 w-3.5 text-amber-300" />
          <span className="font-extrabold tabular-nums">
            {showFeet ? `${distFeet.toFixed(1)} ft` : `${Math.round(distanceToPinYds)} yds`}
          </span>
          <span className="text-slate-500">·</span>
          <span className={`rounded border px-1.5 py-0.2 text-[9px] font-bold tracking-wider ${surfInfo.color}`}>
            {surfInfo.label}
            {lieSlopeSummary ? ` ${lieSlopeSummary}` : ''}
          </span>
          <span className="text-slate-500">·</span>
          <span className="text-sky-300 tabular-nums">{windMph} mph</span>
          <ChevronDown
            className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
              openMenu === 'telemetry' ? 'rotate-180 text-sky-300' : ''
            }`}
          />
        </button>

        {openMenu === 'telemetry' && (
          <div className="hud-glass absolute top-full left-1/2 -translate-x-1/2 mt-2 w-80 rounded-2xl p-3.5 shadow-2xl">
            <div className="grid grid-cols-2 gap-2.5 mb-3">
              <div className="rounded-xl bg-white/5 p-2 text-center">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  To Pin
                </div>
                <div className="text-base font-extrabold text-white tabular-nums">
                  {showFeet ? `${distFeet.toFixed(1)} ft` : `${Math.round(distanceToPinYds)} yds`}
                </div>
              </div>
              <div className="rounded-xl bg-white/5 p-2 text-center">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Elevation
                </div>
                <div
                  className={`text-sm font-bold tabular-nums mt-0.5 ${
                    elevationToPinFt > 2
                      ? 'text-amber-300'
                      : elevationToPinFt < -2
                        ? 'text-sky-300'
                        : 'text-slate-200'
                  }`}
                >
                  {elevationToPinFt >= 0
                    ? `▲ +${Math.round(elevationToPinFt)}`
                    : `▼ ${Math.round(elevationToPinFt)}`}{' '}
                  ft
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2.5">
              <div>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wider ${surfInfo.color}`}
                  >
                    {surfInfo.label}
                  </span>
                  <span className="text-[10px] font-bold uppercase text-amber-300">
                    {difficulty}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-slate-300 tabular-nums">
                  {Math.abs(lieUphillPct) < 1
                    ? 'Flat Lie'
                    : lieUphillPct > 0
                      ? `Uphill +${lieUphillPct.toFixed(1)}%`
                      : `Downhill ${lieUphillPct.toFixed(1)}%`}
                  {' · '}
                  {Math.abs(lieSidePct) < 1
                    ? 'Level'
                    : lieSidePct > 0
                      ? `Ball Above ${lieSidePct.toFixed(1)}%`
                      : `Ball Below ${Math.abs(lieSidePct).toFixed(1)}%`}
                </div>
                <div className="mt-0.5 text-[10px] text-slate-400 tabular-nums">
                  Total Slope {lieSlopePct.toFixed(1)}% · Stimp {snap.difficulty === 'tour' ? '11.4' : snap.difficulty === 'pro' ? '10.0' : '8.7'} ft
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-slate-900/80">
                  <Compass className="h-3.5 w-3.5 text-slate-500 opacity-30" />
                  <div
                    className="absolute inset-0 flex items-center justify-center transition-transform duration-300"
                    style={{ transform: `rotate(${relWindDeg}deg)` }}
                  >
                    <div className="h-5 w-0.5 bg-gradient-to-t from-transparent via-sky-400 to-sky-300">
                      <div className="-ml-[3px] -mt-[1px] h-0 w-0 border-x-[3.5px] border-b-[6px] border-x-transparent border-b-sky-300" />
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[9px] font-semibold uppercase text-slate-400">Wind</div>
                  <div className="text-xs font-bold text-sky-300 tabular-nums">{windMph} mph</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right: Camera & Course Tools Dropdown */}
      <div className="pointer-events-auto relative">
        <button
          onClick={() => toggle('tools')}
          className={`hud-glass flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold text-white transition hover:border-sky-400/50 ${
            openMenu === 'tools' ? 'ring-1 ring-sky-400/60' : ''
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 text-sky-300" />
          <span>Menu</span>
          <ChevronDown
            className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
              openMenu === 'tools' ? 'rotate-180 text-sky-300' : ''
            }`}
          />
        </button>

        {openMenu === 'tools' && (
          <div className="hud-glass absolute top-full right-0 mt-2 w-64 rounded-2xl p-3 shadow-2xl">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              <Camera className="h-3 w-3" />
              Camera View
            </div>
            <div className="grid grid-cols-2 gap-1.5 mb-3">
              {camModes.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    onCameraMode(c.id);
                    setOpenMenu(null);
                  }}
                  className={`rounded-xl px-2.5 py-1.5 text-[11px] font-semibold transition ${
                    snap.cameraMode === c.id
                      ? 'bg-sky-500 text-slate-950'
                      : 'bg-white/5 text-slate-300 hover:bg-white/15'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Tour Mode & Pin Placement
            </div>
            <div className="grid grid-cols-3 gap-1 mb-3">
              {(['amateur', 'pro', 'tour'] as DifficultyMode[]).map((d) => (
                <button
                  key={d}
                  onClick={() => onDifficulty(d)}
                  className={`rounded-lg py-1 text-[10px] font-bold uppercase transition ${
                    difficulty === d
                      ? 'bg-amber-400 text-slate-950'
                      : 'bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>

            <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Course & Shot Tools
            </div>
            <div className="flex flex-col gap-1">
              <button
                onClick={onToggleFlagstick}
                className={`flex items-center justify-between rounded-xl px-2.5 py-1.5 text-xs font-medium transition ${
                  snap.flagstickInCup
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
              >
                <span className="flex items-center gap-2">
                  <Flag className="h-3.5 w-3.5" />
                  {snap.flagstickInCup ? 'Flagstick: In' : 'Flagstick: Out'}
                </span>
                <span className="text-[10px] opacity-70">F</span>
              </button>

              <button
                disabled={!snap.canMulligan}
                onClick={() => {
                  onMulligan();
                  setOpenMenu(null);
                }}
                className="flex items-center justify-between rounded-xl bg-white/5 px-2.5 py-1.5 text-xs font-medium text-sky-300 hover:bg-white/10 disabled:opacity-35"
              >
                <span className="flex items-center gap-2">
                  <Undo2 className="h-3.5 w-3.5" />
                  Mulligan (Undo Shot)
                </span>
                <span className="text-[10px] opacity-70">M</span>
              </button>

              {!hole.isDrivingRange && (
                <button
                  disabled={snap.playState !== 'ready'}
                  onClick={() => {
                    onUnplayableDrop();
                    setOpenMenu(null);
                  }}
                  className="flex items-center justify-between rounded-xl bg-white/5 px-2.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-white/10 disabled:opacity-35"
                >
                  <span className="flex items-center gap-2">
                    <LifeBuoy className="h-3.5 w-3.5" />
                    Unplayable Drop (+1)
                  </span>
                </button>
              )}

              <button
                disabled={!snap.canReplay && snap.playState !== 'replaying'}
                onClick={() => {
                  if (snap.playState === 'replaying') onStopReplay();
                  else onReplayShot();
                  setOpenMenu(null);
                }}
                className="flex items-center justify-between rounded-xl bg-white/5 px-2.5 py-1.5 text-xs font-medium text-emerald-300 hover:bg-white/10 disabled:opacity-35"
              >
                <span className="flex items-center gap-2">
                  <Film className="h-3.5 w-3.5" />
                  {snap.playState === 'replaying' ? 'Stop Replay' : 'Replay Last Shot'}
                </span>
                <span className="text-[10px] opacity-70">P</span>
              </button>

              <button
                onClick={() => {
                  onResetTee();
                  setOpenMenu(null);
                }}
                className="flex items-center justify-between rounded-xl bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/10"
              >
                <span className="flex items-center gap-2">
                  <RotateCcw className="h-3.5 w-3.5" />
                  Restart Hole
                </span>
                <span className="text-[10px] opacity-70">R</span>
              </button>

              <button
                onClick={() => {
                  setOpenMenu(null);
                  onOpenScorecard();
                }}
                className="flex items-center gap-2 rounded-xl bg-white/5 px-2.5 py-1.5 text-xs font-medium text-amber-300 hover:bg-white/10"
              >
                <Trophy className="h-3.5 w-3.5" />
                Scorecard & Leaderboard
              </button>

              <button
                onClick={() => {
                  setOpenMenu(null);
                  onOpenSettings();
                }}
                className="flex items-center gap-2 rounded-xl bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/10"
              >
                <Settings className="h-3.5 w-3.5" />
                Graphics, Wind & Time
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
