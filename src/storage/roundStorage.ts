import type { DifficultyMode } from '../course/types';

export interface CareerLifetimeStats {
  roundsCompleted: number;
  holesPlayed: number;
  eaglesPlus: number;
  birdies: number;
  pars: number;
  bogeysPlus: number;
  fairwaysHit: number;
  fairwaysPossible: number;
  greensInReg: number;
  greensPossible: number;
  totalPutts: number;
  longestDriveYds: number;
}

export interface CareerProfile {
  playerName: string;
  holeBestScores: Record<string, number>;
  bestRoundByDifficulty: Partial<Record<DifficultyMode, number>>;
  lifetime: CareerLifetimeStats;
}

const STORAGE_KEY = 'coastal_links_career_v1';

const DEFAULT_PROFILE: CareerProfile = {
  playerName: 'Coastal Golfer',
  holeBestScores: {},
  bestRoundByDifficulty: {},
  lifetime: {
    roundsCompleted: 0,
    holesPlayed: 0,
    eaglesPlus: 0,
    birdies: 0,
    pars: 0,
    bogeysPlus: 0,
    fairwaysHit: 0,
    fairwaysPossible: 0,
    greensInReg: 0,
    greensPossible: 0,
    totalPutts: 0,
    longestDriveYds: 0,
  },
};

export function loadCareerProfile(): CareerProfile {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_PROFILE);
    const parsed = JSON.parse(raw) as Partial<CareerProfile>;
    return {
      playerName: parsed.playerName || DEFAULT_PROFILE.playerName,
      holeBestScores: parsed.holeBestScores ?? {},
      bestRoundByDifficulty: parsed.bestRoundByDifficulty ?? {},
      lifetime: { ...DEFAULT_PROFILE.lifetime, ...(parsed.lifetime ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_PROFILE);
  }
}

function saveCareerProfile(p: CareerProfile): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Ignore quota errors
  }
}

export function updatePlayerName(name: string): CareerProfile {
  const cur = loadCareerProfile();
  cur.playerName = name.trim().slice(0, 24) || 'Coastal Golfer';
  saveCareerProfile(cur);
  return cur;
}

export function recordHoleCompletion(params: {
  holeId: string;
  strokes: number;
  par: number;
  fairwayHit: boolean | null;
  greenInRegulation: boolean;
  putts: number;
  maxDriveYds?: number;
}): CareerProfile {
  const cur = loadCareerProfile();
  const prevBest = cur.holeBestScores[params.holeId];
  if (!prevBest || params.strokes < prevBest) {
    cur.holeBestScores[params.holeId] = params.strokes;
  }

  const diff = params.strokes - params.par;
  cur.lifetime.holesPlayed++;
  if (diff <= -2) cur.lifetime.eaglesPlus++;
  else if (diff === -1) cur.lifetime.birdies++;
  else if (diff === 0) cur.lifetime.pars++;
  else cur.lifetime.bogeysPlus++;

  if (params.fairwayHit !== null) {
    cur.lifetime.fairwaysPossible++;
    if (params.fairwayHit) cur.lifetime.fairwaysHit++;
  }
  cur.lifetime.greensPossible++;
  if (params.greenInRegulation) cur.lifetime.greensInReg++;
  cur.lifetime.totalPutts += params.putts;

  if (params.maxDriveYds && params.maxDriveYds > cur.lifetime.longestDriveYds) {
    cur.lifetime.longestDriveYds = Math.round(params.maxDriveYds);
  }

  saveCareerProfile(cur);
  return cur;
}

export function recordFullRoundCompletion(
  difficulty: DifficultyMode,
  totalStrokes: number
): CareerProfile {
  const cur = loadCareerProfile();
  cur.lifetime.roundsCompleted++;
  const prev = cur.bestRoundByDifficulty[difficulty];
  if (!prev || totalStrokes < prev) {
    cur.bestRoundByDifficulty[difficulty] = totalStrokes;
  }
  saveCareerProfile(cur);
  return cur;
}
