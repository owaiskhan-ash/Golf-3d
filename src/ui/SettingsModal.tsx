import React from 'react';
import { Volume2, VolumeX, X, Sun, Wind, Activity, Sparkles, Hand, Gauge } from 'lucide-react';
import type { GraphicsQuality } from '../engine/PostProcessing';
import type { DifficultyMode } from '../course/types';
import { TIME_OF_DAY_PRESETS, type TimeOfDayPreset } from '../engine/SkyAtmosphere';
import { useIsMobile } from './useIsMobile';

interface SettingsModalProps {
  open: boolean;
  playerName: string;
  difficulty: DifficultyMode;
  timeOfDay: TimeOfDayPreset;
  windSpeedMph: number;
  windDirDeg: number;
  soundEnabled: boolean;
  aimPreviewEnabled: boolean;
  proTracerEnabled: boolean;
  /** Mobile swipe steering range (degrees, full shots). Putts scale to ~42%. */
  swipeSensitivityDeg: number;
  quality: GraphicsQuality;
  autoQuality: boolean;
  onPlayerNameChange: (name: string) => void;
  onDifficulty: (diff: DifficultyMode) => void;
  onTimeOfDay: (p: TimeOfDayPreset) => void;
  onWindChange: (mph: number, dirDeg: number) => void;
  onSoundToggle: (enabled: boolean) => void;
  onAimPreviewToggle: (enabled: boolean) => void;
  onProTracerToggle: (enabled: boolean) => void;
  onSwipeSensitivityChange: (deg: number) => void;
  onQuality: (q: GraphicsQuality) => void;
  onAutoQualityToggle: (enabled: boolean) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  playerName,
  difficulty,
  timeOfDay,
  windSpeedMph,
  windDirDeg,
  soundEnabled,
  aimPreviewEnabled,
  proTracerEnabled,
  swipeSensitivityDeg,
  quality,
  autoQuality,
  onPlayerNameChange,
  onDifficulty,
  onTimeOfDay,
  onWindChange,
  onSoundToggle,
  onAimPreviewToggle,
  onProTracerToggle,
  onSwipeSensitivityChange,
  onQuality,
  onAutoQualityToggle,
  onClose,
}) => {
  const isMobile = useIsMobile();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-sm">
      <div className="hud-glass w-full max-w-md max-h-[90vh] overflow-y-auto rounded-3xl p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-extrabold text-white">Environment & Simulation</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 text-xs">
          {/* Golfer Handle */}
          <div>
            <div className="mb-1.5 font-bold uppercase tracking-wider text-slate-300">
              Golfer Name (Scorecard / Leaderboard)
            </div>
            <input
              type="text"
              maxLength={24}
              value={playerName}
              onChange={(e) => onPlayerNameChange(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-sky-400"
              placeholder="Coastal Golfer"
            />
          </div>

          {/* Tour Difficulty */}
          <div>
            <div className="mb-2 flex items-center gap-1.5 font-bold uppercase tracking-wider text-slate-300">
              <Sparkles className="h-3.5 w-3.5 text-emerald-300" />
              <span>Course Setup & Difficulty</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { id: 'amateur', label: 'Amateur', desc: 'Arc On · 8.7 ft' },
                  { id: 'pro', label: 'Pro', desc: 'Arc On · 10 ft' },
                  { id: 'tour', label: 'Tour', desc: 'Sunday Pins' },
                ] as const
              ).map((d) => (
                <button
                  key={d.id}
                  onClick={() => onDifficulty(d.id)}
                  className={`rounded-xl px-2 py-2 text-center transition ${
                    difficulty === d.id
                      ? 'bg-amber-400 text-slate-950 font-bold'
                      : 'bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  <div className="font-bold">{d.label}</div>
                  <div className={`text-[9px] ${difficulty === d.id ? 'text-slate-900' : 'text-slate-400'}`}>
                    {d.desc}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Graphics Quality — the single biggest lever on frame rate */}
          <div>
            <div className="mb-2 flex items-center gap-1.5 font-bold uppercase tracking-wider text-slate-300">
              <Gauge className="h-3.5 w-3.5 text-sky-300" />
              <span>Graphics &amp; Performance</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  { id: 'ultra', label: 'Ultra', desc: 'Full detail · heavy' },
                  { id: 'high', label: 'High', desc: 'Balanced' },
                  { id: 'medium', label: 'Medium', desc: 'No AO/bloom' },
                  { id: 'low', label: 'Lighter', desc: 'Fastest' },
                ] as const
              ).map((q) => (
                <button
                  key={q.id}
                  onClick={() => onQuality(q.id)}
                  className={`rounded-xl px-2 py-2 text-center transition ${
                    quality === q.id
                      ? 'bg-sky-400 text-slate-950 font-bold'
                      : 'bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  <div className="font-bold">{q.label}</div>
                  <div className={`text-[9px] ${quality === q.id ? 'text-slate-900' : 'text-slate-400'}`}>
                    {q.desc}
                  </div>
                </button>
              ))}
            </div>
            <button
              onClick={() => onAutoQualityToggle(!autoQuality)}
              className={`mt-1.5 w-full rounded-xl py-2 font-semibold transition ${
                autoQuality ? 'bg-emerald-500/20 text-emerald-200' : 'bg-white/5 text-slate-400 hover:bg-white/10'
              }`}
            >
              {autoQuality ? 'Auto-tune: On (lowers quality if FPS drops)' : 'Auto-tune: Off'}
            </button>
            <p className="mt-1.5 text-[10px] leading-snug text-slate-400">
              Pick <span className="font-semibold text-sky-300">Lighter</span> for the smoothest
              frame rate: one shadow cascade, no post effects, fewer trees and grass, and the
              render resolution adapts automatically.
            </p>
          </div>

          {/* Atmosphere / Sun */}
          <div>
            <div className="mb-2 flex items-center gap-1.5 font-bold uppercase tracking-wider text-slate-300">
              <Sun className="h-3.5 w-3.5 text-amber-300" />
              <span>Coastal Lighting</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {(Object.keys(TIME_OF_DAY_PRESETS) as TimeOfDayPreset[]).map((key) => (
                <button
                  key={key}
                  onClick={() => onTimeOfDay(key)}
                  className={`rounded-xl px-3 py-2 text-left font-semibold transition ${
                    timeOfDay === key
                      ? 'bg-sky-500 text-slate-950'
                      : 'bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  {TIME_OF_DAY_PRESETS[key].label}
                </button>
              ))}
            </div>
          </div>

          {/* Live Wind Override */}
          <div className="rounded-2xl bg-white/5 p-3">
            <div className="mb-2 flex items-center gap-1.5 font-bold uppercase tracking-wider text-slate-300">
              <Wind className="h-3.5 w-3.5 text-sky-400" />
              <span>Pacific Wind Field</span>
            </div>
            <div className="space-y-2">
              <div>
                <div className="flex justify-between text-slate-300">
                  <span>Speed</span>
                  <span className="font-bold text-sky-300 tabular-nums">{Math.round(windSpeedMph)} mph</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={28}
                  value={windSpeedMph}
                  onChange={(e) => onWindChange(Number(e.target.value), windDirDeg)}
                  className="w-full"
                />
              </div>
              <div>
                <div className="flex justify-between text-slate-300">
                  <span>Direction</span>
                  <span className="font-bold text-white tabular-nums">{Math.round(windDirDeg)}°</span>
                </div>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  value={windDirDeg}
                  onChange={(e) => onWindChange(windSpeedMph, Number(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          </div>

          {/* Graphics — locked to ULTRA */}
          <div>
            <div className="mb-2 flex items-center justify-between font-bold uppercase tracking-wider text-slate-300">
              <span>Graphics & Grass Density</span>
              <span className="flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[9px] font-bold text-emerald-300">
                <Activity className="h-2.5 w-2.5" />
                ALWAYS ON
              </span>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-gradient-to-r from-emerald-500 to-sky-500 px-3 py-2.5 font-bold text-slate-950">
              <span className="uppercase">Ultra Photoreal</span>
              <span className="text-[10px] font-semibold opacity-80">4K shadows · Photo PBR turf · Cinematic post</span>
            </div>
          </div>

          {/* Mobile Swipe Steering Sensitivity */}
          {isMobile && (
            <div className="rounded-2xl bg-white/5 p-3">
              <div className="mb-2 flex items-center gap-1.5 font-bold uppercase tracking-wider text-slate-300">
                <Hand className="h-3.5 w-3.5 text-emerald-300" />
                <span>Swipe Steering</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Pull-tilt aim range</span>
                <span className="font-bold text-emerald-300 tabular-nums">
                  ±{swipeSensitivityDeg}°
                </span>
              </div>
              <input
                type="range"
                min={6}
                max={20}
                step={1}
                value={swipeSensitivityDeg}
                onChange={(e) => onSwipeSensitivityChange(Number(e.target.value))}
                className="w-full"
              />
              <div className="mt-1 text-[10px] text-slate-500">
                How far a full sideways tilt steers the shot. Putts scale down automatically.
              </div>
            </div>
          )}

          {/* Toggles */}
          <div className="grid grid-cols-3 gap-1.5 pt-1">
            <button
              onClick={() => onSoundToggle(!soundEnabled)}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-white/5 py-2.5 font-semibold text-slate-200 hover:bg-white/10"
            >
              {soundEnabled ? <Volume2 className="h-3.5 w-3.5 text-emerald-300" /> : <VolumeX className="h-3.5 w-3.5 text-slate-500" />}
              <span>{soundEnabled ? 'Audio' : 'Muted'}</span>
            </button>
            <button
              onClick={() => onAimPreviewToggle(!aimPreviewEnabled)}
              className="flex items-center justify-center rounded-xl bg-white/5 py-2.5 font-semibold text-slate-200 hover:bg-white/10"
            >
              <span>{aimPreviewEnabled ? 'Arc: On' : 'Arc: Off'}</span>
            </button>
            <button
              onClick={() => onProTracerToggle(!proTracerEnabled)}
              className="flex items-center justify-center rounded-xl bg-white/5 py-2.5 font-semibold text-slate-200 hover:bg-white/10"
            >
              <span>{proTracerEnabled ? 'Tracer: On' : 'Tracer: Off'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
