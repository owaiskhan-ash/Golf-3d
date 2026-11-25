import React from 'react';
import { Volume2, VolumeX, X, Sun, Wind, Activity, Sparkles } from 'lucide-react';
import type { DifficultyMode } from '../course/types';
import { TIME_OF_DAY_PRESETS, type TimeOfDayPreset } from '../engine/SkyAtmosphere';
import type { GraphicsQuality } from '../engine/PostProcessing';

interface SettingsModalProps {
  open: boolean;
  playerName: string;
  difficulty: DifficultyMode;
  timeOfDay: TimeOfDayPreset;
  quality: GraphicsQuality;
  autoQualityEnabled: boolean;
  windSpeedMph: number;
  windDirDeg: number;
  soundEnabled: boolean;
  aimPreviewEnabled: boolean;
  proTracerEnabled: boolean;
  onPlayerNameChange: (name: string) => void;
  onDifficulty: (diff: DifficultyMode) => void;
  onTimeOfDay: (p: TimeOfDayPreset) => void;
  onQuality: (q: GraphicsQuality) => void;
  onAutoQualityToggle: (enabled: boolean) => void;
  onWindChange: (mph: number, dirDeg: number) => void;
  onSoundToggle: (enabled: boolean) => void;
  onAimPreviewToggle: (enabled: boolean) => void;
  onProTracerToggle: (enabled: boolean) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  playerName,
  difficulty,
  timeOfDay,
  quality,
  autoQualityEnabled,
  windSpeedMph,
  windDirDeg,
  soundEnabled,
  aimPreviewEnabled,
  proTracerEnabled,
  onPlayerNameChange,
  onDifficulty,
  onTimeOfDay,
  onQuality,
  onAutoQualityToggle,
  onWindChange,
  onSoundToggle,
  onAimPreviewToggle,
  onProTracerToggle,
  onClose,
}) => {
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

          {/* Graphics Quality + Auto FPS Scaler */}
          <div>
            <div className="mb-2 flex items-center justify-between font-bold uppercase tracking-wider text-slate-300">
              <span>Graphics & Grass Density</span>
              <button
                onClick={() => onAutoQualityToggle(!autoQualityEnabled)}
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold transition ${
                  autoQualityEnabled ? 'bg-sky-500/20 text-sky-300' : 'bg-white/10 text-slate-400'
                }`}
              >
                <Activity className="h-2.5 w-2.5" />
                Auto FPS: {autoQualityEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(['ultra', 'high', 'medium'] as GraphicsQuality[]).map((q) => (
                <button
                  key={q}
                  onClick={() => onQuality(q)}
                  className={`rounded-xl py-2 font-bold uppercase transition ${
                    quality === q
                      ? 'bg-emerald-500 text-slate-950'
                      : 'bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

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
