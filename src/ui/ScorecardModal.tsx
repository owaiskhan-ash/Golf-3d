import React, { useEffect, useState } from 'react';
import { Award, Cloud, Trophy, X } from 'lucide-react';
import { COURSE_HOLES } from '../course/courseData';
import type { DifficultyMode } from '../course/types';
import type { HoleRoundMeta } from '../engine/GolfEngine';
import type { CareerProfile } from '../storage/roundStorage';
import {
  fetchLeaderboard,
  isSupabaseConfigured,
  type LeaderboardEntry,
} from '../storage/supabaseSync';

interface ScorecardModalProps {
  open: boolean;
  difficulty: DifficultyMode;
  roundScores: Record<string, number>;
  roundMetas: Record<string, HoleRoundMeta>;
  careerProfile: CareerProfile;
  currentHoleId: string;
  onSelectHole: (id: string) => void;
  onClose: () => void;
}

export const ScorecardModal: React.FC<ScorecardModalProps> = ({
  open,
  difficulty,
  roundScores,
  roundMetas,
  careerProfile,
  currentHoleId,
  onSelectHole,
  onClose,
}) => {
  const [tab, setTab] = useState<'card' | 'career' | 'leaderboard'>('card');
  const [leaders, setLeaders] = useState<LeaderboardEntry[]>([]);
  const [loadingLeaders, setLoadingLeaders] = useState(false);

  const cloudEnabled = isSupabaseConfigured();

  useEffect(() => {
    if (!open || tab !== 'leaderboard' || !cloudEnabled) return;
    setLoadingLeaders(true);
    fetchLeaderboard(difficulty)
      .then((rows) => setLeaders(rows))
      .finally(() => setLoadingLeaders(false));
  }, [open, tab, difficulty, cloudEnabled]);

  if (!open) return null;

  const holes = COURSE_HOLES.filter((h) => !h.isDrivingRange);
  const totalPar = holes.reduce((a, h) => a + h.par, 0);
  const totalScore = holes.reduce((a, h) => a + (roundScores[h.id] ?? 0), 0);
  const playedPar = holes.reduce((a, h) => a + (roundScores[h.id] ? h.par : 0), 0);
  const diff = totalScore - playedPar;

  const totalPutts = holes.reduce((a, h) => a + (roundMetas[h.id]?.putts ?? 0), 0);
  const firHits = holes.filter((h) => h.par >= 4 && roundMetas[h.id]?.fairwayHit === true).length;
  const firPoss = holes.filter((h) => h.par >= 4 && roundScores[h.id] > 0).length;
  const girHits = holes.filter((h) => roundMetas[h.id]?.greenInRegulation).length;
  const girPoss = holes.filter((h) => roundScores[h.id] > 0).length;

  const lt = careerProfile.lifetime;
  const careerFir = lt.fairwaysPossible > 0 ? Math.round((lt.fairwaysHit / lt.fairwaysPossible) * 100) : 0;
  const careerGir = lt.greensPossible > 0 ? Math.round((lt.greensInReg / lt.greensPossible) * 100) : 0;
  const avgPutts = lt.holesPlayed > 0 ? (lt.totalPutts / lt.holesPlayed).toFixed(2) : '—';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-sm">
      <div className="hud-glass w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="rounded-xl bg-amber-500/20 p-2 text-amber-300">
              <Trophy className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-extrabold text-white">Monterey Coastal Links</h2>
              <p className="text-xs text-slate-400">
                9-Hole Championship · {difficulty.toUpperCase()} Pins · {careerProfile.playerName}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="mb-4 flex gap-1.5 rounded-2xl bg-white/5 p-1 text-xs font-bold">
          {(
            [
              { id: 'card', label: '9-Hole Scorecard' },
              { id: 'career', label: 'Career Stats & Bests' },
              { id: 'leaderboard', label: 'Leaderboard' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 rounded-xl py-1.5 transition ${
                tab === t.id ? 'bg-sky-500 text-slate-950' : 'text-slate-300 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'card' && (
          <>
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/60">
              <table className="w-full text-left text-xs">
                <thead className="bg-white/5 text-[10px] uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="px-3 py-2.5">Hole</th>
                    <th className="px-2 py-2.5">Name</th>
                    <th className="px-2 py-2.5 text-center">Yds</th>
                    <th className="px-2 py-2.5 text-center">Par</th>
                    <th className="px-2 py-2.5 text-center">FIR</th>
                    <th className="px-2 py-2.5 text-center">GIR</th>
                    <th className="px-2 py-2.5 text-center">Putts</th>
                    <th className="px-3 py-2.5 text-center">Score</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {holes.map((h) => {
                    const sc = roundScores[h.id];
                    const meta = roundMetas[h.id];
                    const d = sc ? sc - h.par : 0;
                    return (
                      <tr
                        key={h.id}
                        onClick={() => {
                          onSelectHole(h.id);
                          onClose();
                        }}
                        className={`cursor-pointer transition hover:bg-white/5 ${
                          h.id === currentHoleId ? 'bg-sky-500/10' : ''
                        }`}
                      >
                        <td className="px-3 py-2 font-bold text-white">#{h.holeNumber}</td>
                        <td className="px-2 py-2 font-semibold text-slate-100">{h.name}</td>
                        <td className="px-2 py-2 text-center tabular-nums text-slate-300">{h.yardage}</td>
                        <td className="px-2 py-2 text-center tabular-nums text-slate-300">{h.par}</td>
                        <td className="px-2 py-2 text-center text-[11px]">
                          {h.par < 4 || !sc ? (
                            <span className="text-slate-600">—</span>
                          ) : meta?.fairwayHit ? (
                            <span className="text-emerald-400 font-bold">✓</span>
                          ) : (
                            <span className="text-slate-500">✕</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center text-[11px]">
                          {!sc ? (
                            <span className="text-slate-600">—</span>
                          ) : meta?.greenInRegulation ? (
                            <span className="text-emerald-400 font-bold">✓</span>
                          ) : (
                            <span className="text-slate-500">✕</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center tabular-nums text-slate-300">
                          {sc ? meta?.putts ?? 0 : '—'}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {sc ? (
                            <span
                              className={`inline-flex h-6 w-6 items-center justify-center rounded-full font-extrabold tabular-nums ${
                                d < 0
                                  ? 'bg-emerald-500 text-slate-950'
                                  : d === 0
                                    ? 'bg-white/15 text-white'
                                    : 'bg-amber-500/25 text-amber-300'
                              }`}
                            >
                              {sc}
                            </span>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-white/5 font-bold text-white">
                  <tr>
                    <td className="px-3 py-2.5" colSpan={2}>
                      Total ({girPoss}/9)
                    </td>
                    <td className="px-2 py-2.5 text-center tabular-nums">
                      {holes.reduce((a, h) => a + h.yardage, 0)}
                    </td>
                    <td className="px-2 py-2.5 text-center tabular-nums">{totalPar}</td>
                    <td className="px-2 py-2.5 text-center tabular-nums text-slate-300">
                      {firPoss ? `${firHits}/${firPoss}` : '—'}
                    </td>
                    <td className="px-2 py-2.5 text-center tabular-nums text-slate-300">
                      {girPoss ? `${girHits}/${girPoss}` : '—'}
                    </td>
                    <td className="px-2 py-2.5 text-center tabular-nums text-slate-300">
                      {totalScore > 0 ? totalPutts : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums text-emerald-300">
                      {totalScore > 0 ? `${totalScore} (${diff === 0 ? 'E' : diff > 0 ? `+${diff}` : diff})` : '—'}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}

        {tab === 'career' && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2.5 text-center">
              <div className="rounded-2xl bg-white/5 p-3">
                <div className="text-[10px] uppercase text-slate-400">Holes Played</div>
                <div className="mt-1 text-xl font-black text-white tabular-nums">{lt.holesPlayed}</div>
              </div>
              <div className="rounded-2xl bg-white/5 p-3">
                <div className="text-[10px] uppercase text-slate-400">Fairways (FIR)</div>
                <div className="mt-1 text-xl font-black text-emerald-300 tabular-nums">{careerFir}%</div>
              </div>
              <div className="rounded-2xl bg-white/5 p-3">
                <div className="text-[10px] uppercase text-slate-400">Greens (GIR)</div>
                <div className="mt-1 text-xl font-black text-sky-300 tabular-nums">{careerGir}%</div>
              </div>
              <div className="rounded-2xl bg-white/5 p-3">
                <div className="text-[10px] uppercase text-slate-400">Avg Putts/Hole</div>
                <div className="mt-1 text-xl font-black text-white tabular-nums">{avgPutts}</div>
              </div>
              <div className="rounded-2xl bg-white/5 p-3">
                <div className="text-[10px] uppercase text-slate-400">Birdies / Eagles+</div>
                <div className="mt-1 text-xl font-black text-amber-300 tabular-nums">
                  {lt.birdies} / {lt.eaglesPlus}
                </div>
              </div>
              <div className="rounded-2xl bg-white/5 p-3">
                <div className="text-[10px] uppercase text-slate-400">Longest Drive</div>
                <div className="mt-1 text-xl font-black text-emerald-300 tabular-nums">
                  {lt.longestDriveYds > 0 ? `${lt.longestDriveYds}y` : '—'}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-3.5">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-amber-300">
                <Award className="h-4 w-4" />
                Best 9-Hole Rounds
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                {(['amateur', 'pro', 'tour'] as DifficultyMode[]).map((d) => {
                  const best = careerProfile.bestRoundByDifficulty[d];
                  return (
                    <div key={d} className="rounded-xl bg-slate-900/60 p-2.5">
                      <div className="text-[10px] uppercase text-slate-400">{d}</div>
                      <div className="mt-0.5 text-base font-extrabold text-white tabular-nums">
                        {best ? `${best} (${best - totalPar >= 0 ? `+${best - totalPar}` : best - totalPar})` : '—'}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {tab === 'leaderboard' && (
          <div className="space-y-3 text-xs">
            {!cloudEnabled ? (
              <div className="rounded-2xl border border-sky-400/20 bg-sky-500/10 p-4 text-slate-300">
                <div className="mb-1 flex items-center gap-2 font-bold text-sky-300">
                  <Cloud className="h-4 w-4" />
                  Local Personal Records Active
                </div>
                <p className="text-[11px] text-slate-300/90 leading-relaxed">
                  Personal hole records and 9-hole rounds are automatically saved locally. To enable
                  the shared global leaderboard across devices, set{' '}
                  <code className="rounded bg-black/30 px-1 py-0.5 text-sky-200">VITE_SUPABASE_URL</code>{' '}
                  and{' '}
                  <code className="rounded bg-black/30 px-1 py-0.5 text-sky-200">VITE_SUPABASE_ANON_KEY</code>{' '}
                  using <code className="rounded bg-black/30 px-1 py-0.5 text-sky-200">supabase/schema.sql</code>.
                </p>
              </div>
            ) : loadingLeaders ? (
              <div className="py-8 text-center text-slate-400">Loading {difficulty} leaderboard...</div>
            ) : leaders.length === 0 ? (
              <div className="py-8 text-center text-slate-400">
                No {difficulty} 9-hole rounds posted yet. Complete all 9 holes to set the pace!
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/60">
                <table className="w-full text-left">
                  <thead className="bg-white/5 text-[10px] uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="px-3 py-2">#</th>
                      <th className="px-3 py-2">Golfer</th>
                      <th className="px-2 py-2 text-center">FIR</th>
                      <th className="px-2 py-2 text-center">GIR</th>
                      <th className="px-2 py-2 text-center">Putts</th>
                      <th className="px-3 py-2 text-center">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {leaders.map((row, i) => (
                      <tr key={row.id ?? i}>
                        <td className="px-3 py-2 font-bold text-slate-400">{i + 1}</td>
                        <td className="px-3 py-2 font-semibold text-white">{row.player_name}</td>
                        <td className="px-2 py-2 text-center text-slate-300">{row.fairways_pct}%</td>
                        <td className="px-2 py-2 text-center text-slate-300">{row.gir_pct}%</td>
                        <td className="px-2 py-2 text-center text-slate-300">{row.putts}</td>
                        <td className="px-3 py-2 text-center font-extrabold text-emerald-300 tabular-nums">
                          {row.total_score} ({row.to_par === 0 ? 'E' : row.to_par > 0 ? `+${row.to_par}` : row.to_par})
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
