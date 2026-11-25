import React, { useState } from 'react';
import { Activity, ChevronDown, BarChart3 } from 'lucide-react';
import type { EngineSnapshot } from '../engine/GolfEngine';

interface TelemetryPanelProps {
  snap: EngineSnapshot;
  /** Render un-positioned (full width) so the panel can live inside the mobile side drawer. */
  inline?: boolean;
}

export const TelemetryPanel: React.FC<TelemetryPanelProps> = ({ snap, inline = false }) => {
  const [open, setOpen] = useState(false);
  const { liveBallStats, lastTelemetry } = snap;
  const rootCls = inline
    ? 'pointer-events-auto flex w-full flex-col items-stretch'
    : 'pointer-events-auto fixed top-14 left-3 z-20 flex flex-col items-start';

  if (liveBallStats) {
    return (
      <div className={rootCls}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="hud-glass flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-bold text-sky-300 transition hover:border-sky-400/50"
        >
          <Activity className="h-3.5 w-3.5 animate-pulse" />
          <span className="tabular-nums">
            {liveBallStats.speedMph.toFixed(0)} mph · {liveBallStats.distFromShotStartYds.toFixed(0)}y
          </span>
          <ChevronDown
            className={`h-3 w-3 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>

        {open && (
          <div className={`hud-glass mt-1.5 ${inline ? 'w-full' : 'w-60'} rounded-2xl p-3`}>
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-sky-300">
              <Activity className="h-3.5 w-3.5 animate-pulse" />
              <span>Live Flight Radar</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-white/5 p-1.5">
                <div className="text-[9px] uppercase text-slate-400">Speed</div>
                <div className="text-sm font-extrabold text-white tabular-nums">
                  {liveBallStats.speedMph.toFixed(0)}{' '}
                  <span className="text-[9px] font-normal">mph</span>
                </div>
              </div>
              <div className="rounded-lg bg-white/5 p-1.5">
                <div className="text-[9px] uppercase text-slate-400">Height</div>
                <div className="text-sm font-extrabold text-white tabular-nums">
                  {liveBallStats.heightFt.toFixed(0)}{' '}
                  <span className="text-[9px] font-normal">ft</span>
                </div>
              </div>
              <div className="rounded-lg bg-white/5 p-1.5">
                <div className="text-[9px] uppercase text-slate-400">Dist</div>
                <div className="text-sm font-extrabold text-emerald-300 tabular-nums">
                  {liveBallStats.distFromShotStartYds.toFixed(0)}{' '}
                  <span className="text-[9px] font-normal">y</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (!lastTelemetry) return null;

  const curveText =
    Math.abs(lastTelemetry.curveOfflineYds) < 1.2
      ? 'Online'
      : lastTelemetry.curveOfflineYds > 0
        ? `${lastTelemetry.curveOfflineYds.toFixed(1)}y R`
        : `${Math.abs(lastTelemetry.curveOfflineYds).toFixed(1)}y L`;

  return (
    <div className={rootCls}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`hud-glass flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold text-white transition hover:border-sky-400/50 ${
          open ? 'ring-1 ring-sky-400/60' : ''
        }`}
      >
        <BarChart3 className="h-3.5 w-3.5 text-sky-300" />
        <span className="tabular-nums">
          Shot Data · {lastTelemetry.totalYds.toFixed(0)}y
        </span>
        <ChevronDown
          className={`h-3 w-3 text-slate-400 transition-transform ${open ? 'rotate-180 text-sky-300' : ''}`}
        />
      </button>

      {open && (
        <div className={`hud-glass mt-1.5 ${inline ? 'w-full' : 'w-64'} rounded-2xl p-3 shadow-2xl`}>
          {snap.hole.isDrivingRange && snap.rangeStats.shots > 0 && (
            <div className="mb-2.5 rounded-xl border border-sky-400/20 bg-sky-500/10 p-2">
              <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-sky-300">
                Range Session ({snap.rangeStats.shots} shots)
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-center text-[10px]">
                <div>
                  <div className="text-slate-400">Avg Carry</div>
                  <div className="font-bold text-white tabular-nums">
                    {snap.rangeStats.avgCarryYds.toFixed(0)}y
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Avg Off</div>
                  <div className="font-bold text-amber-300 tabular-nums">
                    ±{snap.rangeStats.avgOfflineYds.toFixed(1)}y
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Closest</div>
                  <div className="font-bold text-emerald-300 tabular-nums">
                    {snap.rangeStats.bestToPinYds !== null
                      ? `${snap.rangeStats.bestToPinYds.toFixed(1)}y`
                      : '—'}
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-sky-300">
              TrackMan Shot Data
            </span>
            <span className="text-[10px] font-semibold text-slate-400">
              {lastTelemetry.clubName.split(' (')[0]}
            </span>
          </div>

          {lastTelemetry.waterPenalty && (
            <div className="mb-2 rounded-lg bg-rose-500/20 px-2 py-1 text-[11px] font-bold text-rose-300 border border-rose-400/30">
              Ocean Hazard · +1 Penalty Drop
            </div>
          )}

          <div className="grid grid-cols-3 gap-1.5 text-center">
            <div className="rounded-lg bg-white/5 p-1.5">
              <div className="text-[9px] uppercase text-slate-400">Carry</div>
              <div className="text-xs font-extrabold text-white tabular-nums">
                {lastTelemetry.carryYds.toFixed(1)}y
              </div>
            </div>
            <div className="rounded-lg bg-white/5 p-1.5">
              <div className="text-[9px] uppercase text-slate-400">Total</div>
              <div className="text-xs font-extrabold text-emerald-300 tabular-nums">
                {lastTelemetry.totalYds.toFixed(1)}y
              </div>
            </div>
            <div className="rounded-lg bg-white/5 p-1.5">
              <div className="text-[9px] uppercase text-slate-400">Curve</div>
              <div className="text-xs font-extrabold text-amber-300 tabular-nums">{curveText}</div>
            </div>
            <div className="rounded-lg bg-white/5 p-1.5">
              <div className="text-[9px] uppercase text-slate-400">Ball Spd</div>
              <div className="text-xs font-bold text-white tabular-nums">
                {lastTelemetry.ballSpeedMph.toFixed(1)}
              </div>
            </div>
            <div className="rounded-lg bg-white/5 p-1.5">
              <div className="text-[9px] uppercase text-slate-400">Smash</div>
              <div className="text-xs font-bold text-white tabular-nums">
                {lastTelemetry.smashFactor.toFixed(2)}
              </div>
            </div>
            <div className="rounded-lg bg-white/5 p-1.5">
              <div className="text-[9px] uppercase text-slate-400">Launch</div>
              <div className="text-xs font-bold text-white tabular-nums">
                {lastTelemetry.launchAngleDeg.toFixed(1)}°
              </div>
            </div>
            <div className="rounded-lg bg-white/5 p-1.5">
              <div className="text-[9px] uppercase text-slate-400">Spin</div>
              <div className="text-xs font-bold text-sky-300 tabular-nums">
                {Math.round(lastTelemetry.spinRpm)}
              </div>
            </div>
            <div className="rounded-lg bg-white/5 p-1.5">
              <div className="text-[9px] uppercase text-slate-400">Apex</div>
              <div className="text-xs font-bold text-white tabular-nums">
                {Math.round(lastTelemetry.apexFt)}ft
              </div>
            </div>
            <div className="rounded-lg bg-white/5 p-1.5">
              <div className="text-[9px] uppercase text-slate-400">Land</div>
              <div className="text-xs font-bold text-white tabular-nums">
                {lastTelemetry.landingAngleDeg.toFixed(0)}°
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
