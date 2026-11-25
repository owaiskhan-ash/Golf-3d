import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import { CLUB_BAG, type ClubSpec } from '../physics/clubs';
import { useIsMobile } from './useIsMobile';

interface ClubSelectorProps {
  selectedClub: ClubSpec;
  recommendedClubId: string;
  disabled: boolean;
  onSelectClub: (id: string) => void;
}

export const ClubSelector: React.FC<ClubSelectorProps> = ({
  selectedClub,
  recommendedClubId,
  disabled,
  onSelectClub,
}) => {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();

  return (
    <div
      className={`pointer-events-auto fixed z-30 flex flex-col items-end ${
        isMobile ? 'bottom-[6.5rem] right-2' : 'bottom-3 right-3'
      }`}
    >
      {open && (
        <div className="hud-glass mb-2 max-h-[340px] w-72 max-w-[86vw] overflow-y-auto rounded-2xl p-2">
          <div className="mb-1.5 flex items-center justify-between px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            <span>Tour Bag (15 Clubs)</span>
            <span>Carry · Loft</span>
          </div>
          <div className="grid grid-cols-1 gap-1">
            {CLUB_BAG.map((c) => {
              const isSelected = c.id === selectedClub.id;
              const isRec = c.id === recommendedClubId;
              return (
                <button
                  key={c.id}
                  disabled={disabled}
                  onClick={() => {
                    onSelectClub(c.id);
                    setOpen(false);
                  }}
                  className={`flex items-center justify-between rounded-xl px-2.5 py-1.5 text-left text-xs transition ${
                    isSelected
                      ? 'bg-sky-500 text-slate-950 font-bold'
                      : 'bg-white/5 text-slate-200 hover:bg-white/10'
                  } disabled:opacity-50`}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-7 font-extrabold">{c.shortName}</span>
                    <span className={isSelected ? 'text-slate-900' : 'text-slate-300'}>
                      {c.name.split(' (')[0]}
                    </span>
                    {isRec && (
                      <span
                        className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-bold uppercase ${
                          isSelected
                            ? 'bg-slate-950/20 text-slate-950'
                            : 'bg-emerald-500/20 text-emerald-300'
                        }`}
                      >
                        <Sparkles className="h-2.5 w-2.5" />
                        Caddie
                      </span>
                    )}
                  </div>
                  <span className="tabular-nums opacity-85">
                    {c.category === 'putter' ? 'Green' : `${c.expectedCarryYds}y`} · {c.loftDeg}°
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <button
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`hud-glass flex items-center gap-2.5 rounded-full px-3.5 py-2 text-left transition hover:border-sky-400/50 disabled:opacity-60 ${
          open ? 'ring-1 ring-sky-400/60' : ''
        }`}
      >
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-sky-500/25 text-[11px] font-black text-sky-300 ring-1 ring-sky-400/30">
          {selectedClub.shortName}
        </div>
        <span className="text-xs font-bold text-white tabular-nums">
          {selectedClub.category === 'putter' ? 'Putter' : `${selectedClub.expectedCarryYds}y`}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5 text-slate-400" />
        )}
      </button>
    </div>
  );
};
