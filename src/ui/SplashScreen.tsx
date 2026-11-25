import React from 'react';
import { Flag } from 'lucide-react';

interface SplashScreenProps {
  /** Real loading progress, 0..1 */
  progress: number;
  label: string;
  /** Fades the splash out; the parent unmounts it after the transition. */
  done: boolean;
}

/**
 * Minimal, elegant boot splash. Progress is driven by the real loading tracker
 * (engine build → 13 MB golfer download → first rendered frame), never a timer.
 */
export const SplashScreen: React.FC<SplashScreenProps> = ({ progress, label, done }) => {
  const pct = Math.round(progress * 100);

  return (
    <div
      aria-hidden={done}
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center bg-slate-950 transition-opacity duration-700 ease-out ${
        done ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
    >
      {/* Soft emerald glow behind the emblem */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 62% 46% at 50% 42%, rgba(16,185,129,0.10), transparent 70%)',
        }}
      />

      {/* Emblem */}
      <div className="relative mb-7 flex h-16 w-16 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-500/10">
        <Flag className="h-6 w-6 text-emerald-300" />
        <div className="absolute inset-0 animate-ping rounded-full border border-emerald-400/20 [animation-duration:2.4s]" />
      </div>

      {/* Wordmark */}
      <div className="text-sm font-bold uppercase tracking-[0.38em] text-white">
        Monterey <span className="text-emerald-300">Links</span>
      </div>
      <div className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.22em] text-slate-500">
        Championship Coastal Golf
      </div>

      {/* Real progress */}
      <div className="mt-10 w-60 max-w-[70vw]">
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-emerald-300 to-sky-400 transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-3 flex items-center justify-between text-[10px] font-medium">
          <span className="uppercase tracking-[0.16em] text-slate-400">{label}…</span>
          <span className="tabular-nums text-slate-300">{pct}%</span>
        </div>
      </div>
    </div>
  );
};
