import React, { useState } from 'react';
import {
  Activity,
  ArrowUp,
  Camera,
  Crosshair,
  Eye,
  Film,
  Flag,
  FlipHorizontal2,
  Gauge,
  Hand,
  LifeBuoy,
  Menu,
  MousePointerClick,
  Move,
  Orbit,
  RotateCcw,
  Settings,
  Sliders,
  Trophy,
  Undo2,
  Wrench,
  X,
} from 'lucide-react';
import { COURSE_HOLES } from '../course/courseData';
import type { DifficultyMode } from '../course/types';
import type { EngineSnapshot } from '../engine/GolfEngine';
import type { CameraMode } from '../engine/CameraSystem';
import { SHOT_TYPE_PRESETS, type ShotTypeId } from '../physics/clubs';
import { SURFACE_BADGES } from './TopBar';
import { TelemetryPanel } from './TelemetryPanel';
import { Minimap } from './Minimap';
import type { SwingInputMode, SwingUiState } from './SwingControls';

interface MobileHudProps {
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
  onAimWorld: (x: number, z: number) => void;
  /** Live swing UI mirror + commands routed to SwingControls' imperative handle */
  swingUi: SwingUiState;
  onSetSwingMode: (m: SwingInputMode) => void;
  onSetShotType: (id: ShotTypeId) => void;
  onToggleProDrawer: () => void;
}

type DrawerSection = 'swing' | 'holes' | 'view' | 'data' | 'tools';

const SECTIONS: Array<{ id: DrawerSection; icon: React.ElementType; label: string }> = [
  { id: 'swing', icon: Crosshair, label: 'Swing' },
  { id: 'holes', icon: Flag, label: 'Holes' },
  { id: 'view', icon: Camera, label: 'View' },
  { id: 'data', icon: Activity, label: 'Data' },
  { id: 'tools', icon: Wrench, label: 'Tools' },
];

const SWING_MODES: Array<{
  id: SwingInputMode;
  label: string;
  desc: string;
  icon: React.ElementType;
}> = [
  { id: 'swipe_pull', label: 'Swipe', desc: 'Pull · tilt · release', icon: Hand },
  { id: 'three_click', label: '3-Click', desc: 'Classic timing taps', icon: MousePointerClick },
  { id: 'mouse_drag', label: 'Drag', desc: 'Pull the dock pad', icon: Move },
  { id: 'pro_sim', label: 'Pro Sim', desc: 'TrackMan sliders', icon: Sliders },
];

const CAM_MODES: Array<{ id: CameraMode; label: string; icon: React.ElementType }> = [
  { id: 'address', label: 'Tee / Ball', icon: Crosshair },
  { id: 'scout', label: 'Scout Orbit', icon: Orbit },
  { id: 'green_read', label: 'Green Read', icon: Eye },
  { id: 'reverse', label: 'Reverse Pin', icon: FlipHorizontal2 },
];

/**
 * Minimal, immersive mobile HUD: the viewport shows only a compact status
 * chip and a menu button, keeping full focus on the swing controls.
 * Everything else (holes, cameras, telemetry, map, tools) lives in a
 * slide-in side drawer organised by an icon rail.
 */
export const MobileHud: React.FC<MobileHudProps> = ({
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
  onAimWorld,
  swingUi,
  onSetSwingMode,
  onSetShotType,
  onToggleProDrawer,
}) => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [section, setSection] = useState<DrawerSection>('swing');

  const { hole, distanceToPinYds, lieSurface, wind, aimYawRad, difficulty } = snap;
  const distFeet = distanceToPinYds * 3;
  const showFeet = lieSurface === 'green' || distanceToPinYds < 25;
  const windMph = Math.round(wind.speedMps * 2.23694);
  const relWindDeg = ((wind.directionRad - aimYawRad) * 180) / Math.PI;
  const surfInfo = SURFACE_BADGES[lieSurface] ?? SURFACE_BADGES.fairway;

  const close = () => setDrawerOpen(false);

  return (
    <>
      {/* ── Minimal on-course chrome: status chip + menu button ─────────── */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-30 flex items-start justify-between gap-2 px-2.5"
        style={{ paddingTop: 'max(10px, env(safe-area-inset-top))' }}
      >
        <div className="pointer-events-auto hud-glass flex min-w-0 items-center gap-2 rounded-2xl px-2.5 py-1.5">
          <span className="shrink-0 rounded-full bg-sky-500 px-1.5 py-0.5 text-[10px] font-black text-slate-950">
            {hole.isDrivingRange ? 'RANGE' : `H${hole.holeNumber}`}
          </span>
          <span className="whitespace-nowrap text-xs font-extrabold text-white tabular-nums">
            {showFeet ? `${distFeet.toFixed(1)} ft` : `${Math.round(distanceToPinYds)} yds`}
          </span>
          <span
            className={`hidden min-[380px]:inline-block rounded border px-1 py-0.5 text-[9px] font-bold tracking-wider ${surfInfo.color}`}
          >
            {surfInfo.label}
          </span>
          <span className="flex items-center gap-1">
            <span className="flex h-5 w-5 items-center justify-center rounded-full border border-white/15 bg-slate-900/80">
              <ArrowUp
                className="h-3 w-3 text-sky-300 transition-transform duration-300"
                style={{ transform: `rotate(${relWindDeg}deg)` }}
              />
            </span>
            <span className="text-[11px] font-bold text-sky-300 tabular-nums">{windMph}</span>
          </span>
        </div>

        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className="pointer-events-auto hud-glass flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-white transition active:scale-95"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {/* ── Icon-railed side drawer with everything else ────────────────── */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40">
          <div
            className="hud-fade-in absolute inset-0 bg-slate-950/60 backdrop-blur-[2px]"
            onClick={close}
          />
          <div className="drawer-slide-in hud-glass absolute inset-y-0 right-0 flex w-[min(340px,92vw)] flex-col border-l border-white/10">
            {/* Header */}
            <div
              className="flex items-center justify-between border-b border-white/10 px-3 py-2.5"
              style={{ paddingTop: 'max(10px, env(safe-area-inset-top))' }}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-extrabold text-white">
                  {hole.isDrivingRange ? 'Practice Range' : `Hole ${hole.holeNumber} · ${hole.name}`}
                </div>
                {!hole.isDrivingRange && (
                  <div className="text-[10px] font-semibold text-slate-400">
                    Par {hole.par} · {hole.yardage}y · Stroke {snap.strokesOnHole + 1}
                  </div>
                )}
              </div>
              <button
                onClick={close}
                aria-label="Close menu"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5 text-slate-300 transition hover:bg-white/10 active:scale-95"
              >
                <X className="h-4.5 w-4.5" />
              </button>
            </div>

            <div className="flex min-h-0 flex-1">
              {/* Icon rail */}
              <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-white/10 py-2">
                {SECTIONS.map((s) => {
                  const Icon = s.icon;
                  const active = section === s.id;
                  return (
                    <button
                      key={s.id}
                      onClick={() => setSection(s.id)}
                      aria-label={s.label}
                      className={`flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-xl transition active:scale-95 ${
                        active
                          ? 'bg-sky-500 text-slate-950 shadow'
                          : 'text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      <Icon className="h-4.5 w-4.5" />
                      <span className="text-[8px] font-bold uppercase tracking-wide">
                        {s.label}
                      </span>
                    </button>
                  );
                })}
              </nav>

              {/* Section content */}
              <div
                className="min-w-0 flex-1 overflow-y-auto p-3"
                style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
              >
                {section === 'swing' && (
                  <div>
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Swing Style
                    </div>
                    <div className="mb-4 grid grid-cols-2 gap-1.5">
                      {SWING_MODES.map((m) => {
                        const Icon = m.icon;
                        const active = swingUi.mode === m.id;
                        return (
                          <button
                            key={m.id}
                            onClick={() => {
                              onSetSwingMode(m.id);
                              if (m.id === 'swipe_pull') close();
                            }}
                            className={`flex flex-col items-start gap-1 rounded-xl px-3 py-2.5 text-left transition active:scale-95 ${
                              active ? 'bg-sky-500 text-slate-950' : 'bg-white/5 text-slate-300'
                            }`}
                          >
                            <span className="flex items-center gap-1.5 text-xs font-bold">
                              <Icon className="h-4 w-4" />
                              {m.label}
                            </span>
                            <span
                              className={`text-[9px] font-medium ${
                                active ? 'text-slate-800' : 'text-slate-500'
                              }`}
                            >
                              {m.desc}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {swingUi.mode === 'swipe_pull' && (
                      <div className="mb-4 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-[10px] text-emerald-200">
                        Pull back anywhere on the course — tilt to steer, release to strike.
                      </div>
                    )}

                    <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Shot Type
                    </div>
                    <div className="mb-4 grid grid-cols-3 gap-1.5">
                      {SHOT_TYPE_PRESETS.map((st) => {
                        const active = swingUi.shotType === st.id;
                        return (
                          <button
                            key={st.id}
                            onClick={() => onSetShotType(st.id)}
                            title={st.shortDesc}
                            className={`rounded-xl px-2 py-2 text-[11px] font-bold transition active:scale-95 ${
                              active ? 'bg-sky-500 text-slate-950' : 'bg-white/5 text-slate-300'
                            }`}
                          >
                            {st.label}
                          </button>
                        );
                      })}
                    </div>

                    <button
                      onClick={() => {
                        onToggleProDrawer();
                        close();
                      }}
                      className={`flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium transition active:scale-[0.98] ${
                        swingUi.proDrawerOpen
                          ? 'bg-amber-400/20 text-amber-300 ring-1 ring-amber-400/40'
                          : 'bg-white/5 text-slate-200'
                      }`}
                    >
                      <Sliders className="h-4 w-4" />
                      Shot Shaping {swingUi.proDrawerOpen ? '· Open' : ''}
                    </button>
                  </div>
                )}

                {section === 'holes' && (
                  <div>
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      9-Hole Championship Links
                    </div>
                    <div className="mb-3 grid grid-cols-4 gap-1.5">
                      {COURSE_HOLES.map((h) => {
                        const active = h.id === hole.id;
                        const sc = roundScores[h.id];
                        return (
                          <button
                            key={h.id}
                            onClick={() => {
                              onSelectHole(h.id);
                              close();
                            }}
                            title={h.name}
                            className={`rounded-xl px-1.5 py-2.5 text-xs font-bold transition active:scale-95 ${
                              active
                                ? 'bg-sky-500 text-slate-950 shadow-sm'
                                : sc
                                  ? 'bg-emerald-500/15 text-emerald-200'
                                  : 'bg-white/5 text-slate-300'
                            }`}
                          >
                            {h.isDrivingRange ? 'Lab' : `H${h.holeNumber}`}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mb-3 text-[11px] text-slate-300">{hole.subtitle}</div>
                    <button
                      onClick={() => {
                        close();
                        onOpenScorecard();
                      }}
                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500/15 px-3 py-2.5 text-xs font-semibold text-amber-300 transition active:scale-[0.98]"
                    >
                      <Trophy className="h-3.5 w-3.5" />
                      Scorecard & Leaderboard
                    </button>
                  </div>
                )}

                {section === 'view' && (
                  <div>
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Camera View
                    </div>
                    <div className="mb-4 grid grid-cols-2 gap-1.5">
                      {CAM_MODES.map((c) => {
                        const Icon = c.icon;
                        const active = snap.cameraMode === c.id;
                        return (
                          <button
                            key={c.id}
                            onClick={() => onCameraMode(c.id)}
                            className={`flex flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-[11px] font-semibold transition active:scale-95 ${
                              active ? 'bg-sky-500 text-slate-950' : 'bg-white/5 text-slate-300'
                            }`}
                          >
                            <Icon className="h-4 w-4" />
                            {c.label}
                          </button>
                        );
                      })}
                    </div>
                    {snap.cameraMode === 'scout' && (
                      <div className="mb-4 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-[10px] text-sky-200">
                        Hole overview — camera stays locked during play
                      </div>
                    )}

                    <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      On-Course Aids
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <button
                        onClick={onToggleFlagstick}
                        className={`flex min-h-[44px] items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium transition active:scale-[0.98] ${
                          snap.flagstickInCup
                            ? 'bg-amber-500/20 text-amber-300'
                            : 'bg-white/5 text-slate-300'
                        }`}
                      >
                        <Flag className="h-4 w-4" />
                        {snap.flagstickInCup ? 'Flagstick: In' : 'Flagstick: Out'}
                      </button>
                    </div>
                  </div>
                )}

                {section === 'data' && (
                  <div className="flex flex-col gap-3">
                    <TelemetryPanel snap={snap} inline />
                    <Minimap snap={snap} onAimWorld={onAimWorld} inline />
                  </div>
                )}

                {section === 'tools' && (
                  <div>
                    <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      <Gauge className="h-3 w-3" />
                      Tour Mode & Pin Placement
                    </div>
                    <div className="mb-4 grid grid-cols-3 gap-1">
                      {(['amateur', 'pro', 'tour'] as DifficultyMode[]).map((d) => (
                        <button
                          key={d}
                          onClick={() => onDifficulty(d)}
                          className={`rounded-lg py-2 text-[10px] font-bold uppercase transition active:scale-95 ${
                            difficulty === d
                              ? 'bg-amber-400 text-slate-950'
                              : 'bg-white/5 text-slate-300'
                          }`}
                        >
                          {d}
                        </button>
                      ))}
                    </div>

                    <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Course & Shot Tools
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <button
                        disabled={!snap.canMulligan}
                        onClick={() => {
                          onMulligan();
                          close();
                        }}
                        className="flex min-h-[44px] items-center gap-2.5 rounded-xl bg-white/5 px-3 py-2 text-xs font-medium text-sky-300 transition active:scale-[0.98] disabled:opacity-35"
                      >
                        <Undo2 className="h-4 w-4" />
                        Mulligan (Undo Shot)
                      </button>

                      {!hole.isDrivingRange && (
                        <button
                          disabled={snap.playState !== 'ready'}
                          onClick={() => {
                            onUnplayableDrop();
                            close();
                          }}
                          className="flex min-h-[44px] items-center gap-2.5 rounded-xl bg-white/5 px-3 py-2 text-xs font-medium text-amber-200 transition active:scale-[0.98] disabled:opacity-35"
                        >
                          <LifeBuoy className="h-4 w-4" />
                          Unplayable Drop (+1)
                        </button>
                      )}

                      <button
                        disabled={!snap.canReplay && snap.playState !== 'replaying'}
                        onClick={() => {
                          if (snap.playState === 'replaying') onStopReplay();
                          else onReplayShot();
                          close();
                        }}
                        className="flex min-h-[44px] items-center gap-2.5 rounded-xl bg-white/5 px-3 py-2 text-xs font-medium text-emerald-300 transition active:scale-[0.98] disabled:opacity-35"
                      >
                        <Film className="h-4 w-4" />
                        {snap.playState === 'replaying' ? 'Stop Replay' : 'Replay Last Shot'}
                      </button>

                      <button
                        onClick={() => {
                          onResetTee();
                          close();
                        }}
                        className="flex min-h-[44px] items-center gap-2.5 rounded-xl bg-white/5 px-3 py-2 text-xs font-medium text-slate-300 transition active:scale-[0.98]"
                      >
                        <RotateCcw className="h-4 w-4" />
                        Restart Hole
                      </button>

                      <button
                        onClick={() => {
                          close();
                          onOpenScorecard();
                        }}
                        className="flex min-h-[44px] items-center gap-2.5 rounded-xl bg-white/5 px-3 py-2 text-xs font-medium text-amber-300 transition active:scale-[0.98]"
                      >
                        <Trophy className="h-4 w-4" />
                        Scorecard & Leaderboard
                      </button>

                      <button
                        onClick={() => {
                          close();
                          onOpenSettings();
                        }}
                        className="flex min-h-[44px] items-center gap-2.5 rounded-xl bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 transition active:scale-[0.98]"
                      >
                        <Settings className="h-4 w-4" />
                        Graphics, Wind & Time
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
