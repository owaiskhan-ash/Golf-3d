import type { DifficultyMode } from '../course/types';

export interface LeaderboardEntry {
  id?: string;
  player_name: string;
  difficulty: DifficultyMode;
  total_score: number;
  to_par: number;
  fairways_pct: number;
  gir_pct: number;
  putts: number;
  created_at?: string;
}

function getSupabaseEnv(): { url: string; anonKey: string } | null {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const url = env.VITE_SUPABASE_URL?.replace(/\/+$/, '');
  const anonKey = env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseEnv() !== null;
}

export async function fetchLeaderboard(
  difficulty?: DifficultyMode
): Promise<LeaderboardEntry[]> {
  const env = getSupabaseEnv();
  if (!env) return [];

  const filter = difficulty ? `&difficulty=eq.${encodeURIComponent(difficulty)}` : '';
  const endpoint = `${env.url}/rest/v1/coastal_leaderboard?select=id,player_name,difficulty,total_score,to_par,fairways_pct,gir_pct,putts,created_at${filter}&order=to_par.asc,putts.asc&limit=15`;

  try {
    const res = await fetch(endpoint, {
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${env.anonKey}`,
      },
    });
    if (!res.ok) return [];
    return (await res.json()) as LeaderboardEntry[];
  } catch {
    return [];
  }
}

export async function submitLeaderboardEntry(entry: LeaderboardEntry): Promise<boolean> {
  const env = getSupabaseEnv();
  if (!env) return false;

  try {
    const res = await fetch(`${env.url}/rest/v1/coastal_leaderboard`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.anonKey,
        Authorization: `Bearer ${env.anonKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(entry),
    });
    return res.ok;
  } catch {
    return false;
  }
}
