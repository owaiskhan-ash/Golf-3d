import React, { useEffect, useRef, useState } from 'react';
import { COURSE_HOLES } from './course/courseData';
import type { DifficultyMode } from './course/types';
import { GolfEngine, type EngineSnapshot, type HoleRoundMeta } from './engine/GolfEngine';
import { loadingTracker, type LoadingState } from './engine/loadingTracker';
import type { GraphicsQuality } from './engine/PostProcessing';
import type { TimeOfDayPreset } from './engine/SkyAtmosphere';
import {
  loadCareerProfile,
  recordFullRoundCompletion,
  recordHoleCompletion,
  updatePlayerName,
  type CareerProfile,
} from './storage/roundStorage';
import { submitLeaderboardEntry } from './storage/supabaseSync';
import { ClubSelector } from './ui/ClubSelector';
import { Minimap } from './ui/Minimap';
import { MobileHud } from './ui/MobileHud';
import { ScorecardModal } from './ui/ScorecardModal';
import { SettingsModal } from './ui/SettingsModal';
import { SplashScreen } from './ui/SplashScreen';
import { SwingControls, type SwingControlsHandle, type SwingUiState } from './ui/SwingControls';
import { TelemetryPanel } from './ui/TelemetryPanel';
import { TopBar } from './ui/TopBar';
import { useIsMobile } from './ui/useIsMobile';

export const App: React.FC = () => {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<GolfEngine | null>(null);
  const recordedHoleKeysRef = useRef<Set<string>>(new Set());
  const submittedRoundRef = useRef(false);

  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [roundScores, setRoundScores] = useState<Record<string, number>>({});
  const [roundMetas, setRoundMetas] = useState<Record<string, HoleRoundMeta>>({});
  const [careerProfile, setCareerProfile] = useState<CareerProfile>(() => loadCareerProfile());

  const [scorecardOpen, setScorecardOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDayPreset>('coastal_noon');
  const [quality, setQuality] = useState<GraphicsQuality>('ultra');
  const [autoQualityEnabled, setAutoQualityEnabled] = useState(true);
  const [difficulty, setDifficulty] = useState<DifficultyMode>('pro');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [aimPreviewEnabled, setAimPreviewEnabled] = useState(true);
  const [proTracerEnabled, setProTracerEnabled] = useState(true);
  const isMobile = useIsMobile();
  const [splash, setSplash] = useState<LoadingState>({
    progress: 0.04,
    label: 'Warming up',
    done: false,
  });
  const [splashGone, setSplashGone] = useState(false);
  // Swing UI mirror + imperative handle so the mobile side menu can drive swing settings
  const swingControlsRef = useRef<SwingControlsHandle>(null);
  const [swingUi, setSwingUi] = useState<SwingUiState>({
    mode: 'swipe_pull',
    shotType: 'full',
    proDrawerOpen: false,
  });

  // Mobile gameplay: lock the camera (the swipe-to-swing gesture owns the touchscreen)
  // and hide the blue aim-trace line so the viewport stays clean and immersive.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.setCameraLocked(isMobile);
    eng.setAimPreviewSuppressed(isMobile);
  }, [isMobile]);

  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return;

    // Subscribe BEFORE engine construction so the splash catches every real milestone
    const unsubLoading = loadingTracker.subscribe(setSplash);

    const engine = new GolfEngine(container);
    engineRef.current = engine;

    const unsub = engine.subscribe((next) => {
      setSnap(next);
      setQuality(next.qualityLevel);
      setDifficulty(next.difficulty);
      setProTracerEnabled(next.proTracerEnabled);
      setAimPreviewEnabled(engine.showAimPreview);

      if (next.playState === 'holed_out' && !next.hole.isDrivingRange) {
        setRoundScores((prevScores) => {
          const updatedScores = {
            ...prevScores,
            [next.hole.id]: next.strokesOnHole,
          };
          setRoundMetas((prevMetas) => {
            const updatedMetas = {
              ...prevMetas,
              [next.hole.id]: next.holeMeta,
            };

            const completionKey = `${next.hole.id}:${next.strokesOnHole}:${next.holeMeta.putts}`;
            if (!recordedHoleKeysRef.current.has(completionKey)) {
              recordedHoleKeysRef.current.add(completionKey);
              const updatedProfile = recordHoleCompletion({
                holeId: next.hole.id,
                strokes: next.strokesOnHole,
                par: next.hole.par,
                fairwayHit: next.holeMeta.fairwayHit,
                greenInRegulation: next.holeMeta.greenInRegulation,
                putts: next.holeMeta.putts,
                maxDriveYds: next.lastTelemetry?.totalYds,
              });
              setCareerProfile(updatedProfile);

              // Check full 9-hole round completion
              const playableHoles = COURSE_HOLES.filter((h) => !h.isDrivingRange);
              const allDone = playableHoles.every((h) => updatedScores[h.id] > 0);
              if (allDone && !submittedRoundRef.current) {
                submittedRoundRef.current = true;
                const totalScore = playableHoles.reduce((a, h) => a + updatedScores[h.id], 0);
                const totalPar = playableHoles.reduce((a, h) => a + h.par, 0);
                const firHits = playableHoles.filter(
                  (h) => h.par >= 4 && updatedMetas[h.id]?.fairwayHit
                ).length;
                const firPoss = playableHoles.filter((h) => h.par >= 4).length;
                const girHits = playableHoles.filter(
                  (h) => updatedMetas[h.id]?.greenInRegulation
                ).length;
                const totalPutts = playableHoles.reduce(
                  (a, h) => a + (updatedMetas[h.id]?.putts ?? 0),
                  0
                );
                const afterRound = recordFullRoundCompletion(next.difficulty, totalScore);
                setCareerProfile(afterRound);
                submitLeaderboardEntry({
                  player_name: afterRound.playerName,
                  difficulty: next.difficulty,
                  total_score: totalScore,
                  to_par: totalScore - totalPar,
                  fairways_pct: firPoss > 0 ? Math.round((firHits / firPoss) * 100) : 0,
                  gir_pct: Math.round((girHits / playableHoles.length) * 100),
                  putts: totalPutts,
                });
              }
            }
            return updatedMetas;
          });
          return updatedScores;
        });
      }
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'KeyG') {
        const cur = engine.greenGridVisible;
        engine.setGreenGridVisible(!cur);
      } else if (e.code === 'KeyF') {
        engine.toggleFlagstick();
      } else if (e.code === 'KeyR') {
        engine.resetToTee();
      } else if (e.code === 'KeyC') {
        engine.resetCameraOrbit();
      } else if (e.code === 'KeyM') {
        engine.takeMulligan();
      } else if (e.code === 'KeyP') {
        if (engine.playState === 'replaying') engine.stopReplay();
        else engine.replayLastShot();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      unsub();
      unsubLoading();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // Fade the splash out once real loading completes, then unmount it
  useEffect(() => {
    if (!splash.done) return;
    const t = setTimeout(() => setSplashGone(true), 750);
    return () => clearTimeout(t);
  }, [splash.done]);

  const handleContinueHoled = () => {
    const eng = engineRef.current;
    if (!eng) return;
    const playableHoles = COURSE_HOLES.filter((h) => !h.isDrivingRange);
    const curIdx = playableHoles.findIndex((h) => h.id === eng.hole.id);
    if (curIdx >= 0 && curIdx < playableHoles.length - 1) {
      eng.loadHole(playableHoles[curIdx + 1].id);
    } else {
      setScorecardOpen(true);
    }
  };

  return (
    <div className="relative h-dvh w-screen overflow-hidden bg-slate-950">
      {/* Live 3D WebGL Viewport */}
      <div ref={viewportRef} className="absolute inset-0 h-full w-full" />

      {/* Boot splash — tracks real engine/asset loading, fades out when ready */}
      {!splashGone && (
        <SplashScreen progress={splash.progress} label={splash.label} done={splash.done} />
      )}

      {snap && (
        <>
          {isMobile ? (
            /* Immersive mobile HUD: minimal viewport, everything under icon side menu */
            <MobileHud
              snap={snap}
              roundScores={roundScores}
              onSelectHole={(id) => engineRef.current?.loadHole(id)}
              onCameraMode={(m) => engineRef.current?.setCameraMode(m)}
              onDifficulty={(d) => engineRef.current?.setDifficulty(d)}
              onToggleGreenGrid={() =>
                engineRef.current?.setGreenGridVisible(!snap.greenGridVisible)
              }
              onToggleFlagstick={() => engineRef.current?.toggleFlagstick()}
              onMulligan={() => engineRef.current?.takeMulligan()}
              onUnplayableDrop={() => engineRef.current?.takeUnplayableDrop()}
              onReplayShot={() => engineRef.current?.replayLastShot()}
              onStopReplay={() => engineRef.current?.stopReplay()}
              onResetTee={() => engineRef.current?.resetToTee()}
              onOpenScorecard={() => setScorecardOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
              onAimWorld={(x, z) => engineRef.current?.setAimTowardsWorld(x, z)}
              swingUi={swingUi}
              onSetSwingMode={(m) => swingControlsRef.current?.setMode(m)}
              onSetShotType={(id) => swingControlsRef.current?.applyShotType(id)}
              onToggleProDrawer={() => swingControlsRef.current?.toggleProDrawer()}
            />
          ) : (
            <>
              <TopBar
                snap={snap}
                roundScores={roundScores}
                onSelectHole={(id) => engineRef.current?.loadHole(id)}
                onCameraMode={(m) => engineRef.current?.setCameraMode(m)}
                onDifficulty={(d) => engineRef.current?.setDifficulty(d)}
                onToggleGreenGrid={() =>
                  engineRef.current?.setGreenGridVisible(!snap.greenGridVisible)
                }
                onToggleFlagstick={() => engineRef.current?.toggleFlagstick()}
                onMulligan={() => engineRef.current?.takeMulligan()}
                onUnplayableDrop={() => engineRef.current?.takeUnplayableDrop()}
                onReplayShot={() => engineRef.current?.replayLastShot()}
                onStopReplay={() => engineRef.current?.stopReplay()}
                onResetTee={() => engineRef.current?.resetToTee()}
                onOpenScorecard={() => setScorecardOpen(true)}
                onOpenSettings={() => setSettingsOpen(true)}
              />

              <TelemetryPanel snap={snap} />

              <Minimap
                snap={snap}
                onAimWorld={(x, z) => engineRef.current?.setAimTowardsWorld(x, z)}
              />
            </>
          )}

          <SwingControls
            ref={swingControlsRef}
            snap={snap}
            onAdjustAim={(d) => engineRef.current?.adjustAim(d)}
            onUpdatePreview={(ov) => engineRef.current?.updatePreviewArc(ov)}
            onExecuteShot={(input) => engineRef.current?.executeShot(input)}
            onReplayShot={() => engineRef.current?.replayLastShot()}
            onStopReplay={() => engineRef.current?.stopReplay()}
            onContinueHoled={handleContinueHoled}
            onUiStateChange={setSwingUi}
          />

          <ClubSelector
            selectedClub={snap.selectedClub}
            recommendedClubId={snap.recommendedClubId}
            disabled={snap.playState !== 'ready'}
            onSelectClub={(id) => engineRef.current?.setClub(id)}
            lifted={!(isMobile && swingUi.mode === 'swipe_pull')}
          />

          {/* Camera Controls, Golfer-Locked Orbit Reset & Auto-FPS Note (desktop — mobile shows hints in the side menu) */}
          {!isMobile &&
            (snap.cameraMode === 'scout' ? (
              <div className="pointer-events-none fixed top-14 right-3 z-20 rounded-full bg-slate-900/75 px-3 py-1 text-[11px] text-sky-200 border border-sky-400/30 backdrop-blur">
                Drag to orbit · Right-drag to pan · Scroll to zoom
              </div>
            ) : snap.cameraMode === 'address' && snap.cameraOrbited ? (
              <button
                onClick={() => engineRef.current?.resetCameraOrbit()}
                className="fixed top-14 right-3 z-20 rounded-full bg-slate-900/85 hover:bg-slate-800 px-3 py-1 text-[11px] font-medium text-emerald-200 border border-emerald-400/40 backdrop-blur shadow-lg transition cursor-pointer"
                title="Reset view behind golfer (or double-click / press C)"
              >
                Reset View (C)
              </button>
            ) : snap.autoQualityNote ? (
              <div className="pointer-events-none fixed top-14 right-3 z-20 rounded-full bg-slate-900/75 px-3 py-1 text-[10px] text-amber-200 border border-amber-400/30 backdrop-blur">
                {snap.autoQualityNote}
              </div>
            ) : null)}

          <ScorecardModal
            open={scorecardOpen}
            difficulty={difficulty}
            roundScores={roundScores}
            roundMetas={roundMetas}
            careerProfile={careerProfile}
            currentHoleId={snap.hole.id}
            onSelectHole={(id) => engineRef.current?.loadHole(id)}
            onClose={() => setScorecardOpen(false)}
          />

          <SettingsModal
            open={settingsOpen}
            playerName={careerProfile.playerName}
            difficulty={difficulty}
            timeOfDay={timeOfDay}
            quality={quality}
            autoQualityEnabled={autoQualityEnabled}
            windSpeedMph={snap.wind.speedMps * 2.23694}
            windDirDeg={(snap.wind.directionRad * 180) / Math.PI}
            soundEnabled={soundEnabled}
            aimPreviewEnabled={aimPreviewEnabled}
            proTracerEnabled={proTracerEnabled}
            onPlayerNameChange={(name) => setCareerProfile(updatePlayerName(name))}
            onDifficulty={(d) => {
              setDifficulty(d);
              engineRef.current?.setDifficulty(d);
            }}
            onTimeOfDay={(p) => {
              setTimeOfDay(p);
              engineRef.current?.setTimeOfDay(p);
            }}
            onQuality={(q) => {
              setQuality(q);
              engineRef.current?.setGraphicsQuality(q);
            }}
            onAutoQualityToggle={(en) => {
              setAutoQualityEnabled(en);
              engineRef.current?.setAutoQualityEnabled(en);
            }}
            onWindChange={(mph, deg) => engineRef.current?.setWind(mph, deg)}
            onSoundToggle={(en) => {
              setSoundEnabled(en);
              engineRef.current?.audio.setEnabled(en);
            }}
            onAimPreviewToggle={(en) => {
              setAimPreviewEnabled(en);
              engineRef.current?.setAimPreviewVisible(en);
            }}
            onProTracerToggle={(en) => {
              setProTracerEnabled(en);
              engineRef.current?.setProTracerEnabled(en);
            }}
            onClose={() => setSettingsOpen(false)}
          />
        </>
      )}
    </div>
  );
};

export default App;
