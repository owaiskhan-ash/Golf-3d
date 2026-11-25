import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, Map as MapIcon } from 'lucide-react';
import { HoleTerrainSampler } from '../course/terrainSampler';
import type { EngineSnapshot } from '../engine/GolfEngine';
import { YARDS_TO_M } from '../physics/constants';

interface MinimapProps {
  snap: EngineSnapshot;
  onAimWorld: (x: number, z: number) => void;
}

export const Minimap: React.FC<MinimapProps> = ({ snap, onAimWorld }) => {
  const [open, setOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { hole, ballPos, cupPos, aimYawRad, selectedClub } = snap;

  // Bake static terrain overhead map whenever hole changes
  const terrainImage = useMemo(() => {
    const w = 180;
    const h = 240;
    const sampler = new HoleTerrainSampler(hole);
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    const { minX, maxX, minZ, maxZ } = hole.bounds;

    for (let py = 0; py < h; py++) {
      const z = minZ + (py / h) * (maxZ - minZ);
      for (let px = 0; px < w; px++) {
        const x = minX + (px / w) * (maxX - minX);
        const s = sampler.getSurfaceSample(x, z);
        const idx = (py * w + px) * 4;
        let r = 20, g = 46, b = 30;
        if (s.surface === 'water') {
          r = 12; g = 52; b = 88;
        } else if (s.surface === 'cliff_rock') {
          r = 78; g = 72; b = 64;
        } else if (s.surface === 'bunker') {
          r = 219; g = 204; b = 162;
        } else if (s.surface === 'green') {
          r = 66; g = 166; b = 74;
        } else if (s.surface === 'fringe') {
          r = 49; g = 132; b = 56;
        } else if (s.surface === 'fairway' || s.surface === 'tee') {
          r = 45; g = 118; b = 48;
        } else if (s.surface === 'rough') {
          r = 33; g = 74; b = 36;
        } else if (s.surface === 'cart_path') {
          r = 105; g = 98; b = 88;
        }
        img.data[idx] = r;
        img.data[idx + 1] = g;
        img.data[idx + 2] = b;
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return off;
  }, [hole]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const { minX, maxX, minZ, maxZ } = hole.bounds;
    const toPx = (wx: number, wz: number) => ({
      px: ((wx - minX) / (maxX - minX)) * w,
      py: ((wz - minZ) / (maxZ - minZ)) * h,
    });

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(terrainImage, 0, 0);

    const b = toPx(ballPos.x, ballPos.z);
    const c = toPx(cupPos.x, cupPos.z);

    // Predicted Carry target point along aim line
    const carryM = selectedClub.expectedCarryYds * YARDS_TO_M;
    const targetWorldX = ballPos.x + Math.sin(aimYawRad) * carryM;
    const targetWorldZ = ballPos.z - Math.cos(aimYawRad) * carryM;
    const t = toPx(targetWorldX, targetWorldZ);

    // Aim line
    ctx.save();
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.85)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(b.px, b.py);
    ctx.lineTo(t.px, t.py);
    ctx.stroke();
    ctx.restore();

    // Carry landing reticle
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(t.px, t.py, 5.5, 0, Math.PI * 2);
    ctx.stroke();

    // Extra Range Yardage Labels
    if (hole.extraTargets) {
      ctx.font = 'bold 9px Inter, sans-serif';
      ctx.textAlign = 'center';
      for (const et of hole.extraTargets) {
        const ep = toPx(et.x, et.z);
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(ep.px, ep.py, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(et.label, ep.px, ep.py - 5);
      }
    }

    // Cup / Flag icon
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(c.px, c.py, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Ball icon
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(b.px, b.py, 3.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#0ea5e9';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [open, terrainImage, hole, ballPos, cupPos, aimYawRad, selectedClub]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;
    const { minX, maxX, minZ, maxZ } = hole.bounds;
    const wx = minX + u * (maxX - minX);
    const wz = minZ + v * (maxZ - minZ);
    onAimWorld(wx, wz);
  };

  return (
    <div className="pointer-events-auto fixed bottom-3 left-3 z-20 flex flex-col items-start">
      {open && (
        <div className="hud-glass mb-2 flex flex-col overflow-hidden rounded-2xl p-2 shadow-2xl">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
              Hole Radar
            </span>
            <span className="text-[9px] text-sky-300">Click to Aim</span>
          </div>
          <canvas
            ref={canvasRef}
            width={180}
            height={240}
            onClick={handleClick}
            className="h-[210px] w-[158px] cursor-crosshair rounded-xl border border-white/10"
          />
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className={`hud-glass flex items-center gap-2 rounded-full px-3.5 py-2 text-xs font-semibold text-white transition hover:border-sky-400/50 ${
          open ? 'ring-1 ring-sky-400/60' : ''
        }`}
      >
        <MapIcon className="h-3.5 w-3.5 text-emerald-300" />
        <span>Hole Map</span>
        <ChevronUp
          className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
            open ? 'rotate-180 text-sky-300' : ''
          }`}
        />
      </button>
    </div>
  );
};
