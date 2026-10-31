"use client";

import React, { useRef, useEffect, useState, useCallback } from "react";
import {
  TrendingUp,
  ShieldCheck,
  ArrowUpRight,
  Layers,
  Sparkles,
  Receipt,
  CheckCircle2,
  DollarSign,
  Activity,
  Percent,
  TrendingDown
} from "lucide-react";

// Morphing blob trail engine constants
const TRAIL_MAX_POINTS = 60;
const TRAIL_HEAD_R = 140;
const TRAIL_NOISE_AMP = 44;
const TRAIL_BLOB_PTS = 24;
const TRAIL_FADE_SPEED = 0.92;
const TRAIL_SAMPLE_DIST = 8;

interface TrailPoint {
  x: number;
  y: number;
  alpha: number;
  noiseSeed: number;
  radius: number;
}

export interface PosterStageProps {
  onOpenAuth?: () => void;
}

export const PosterStage: React.FC<PosterStageProps> = ({ onOpenAuth }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<TrailPoint[]>([]);
  const lastSampleRef = useRef<{ x: number; y: number }>({ x: -999, y: -999 });
  const mouseRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const rafRef = useRef<number | null>(null);

  // 3D Card tilt state
  const [tilt, setTilt] = useState<{ rx: number; ry: number }>({ rx: 0, ry: 0 });
  const [isRevealed, setIsRevealed] = useState(false);

  // Handle pointer movements
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement> | PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    mouseRef.current = { x, y, active: true };

    // Calculate distance from last sample
    const dx = x - lastSampleRef.current.x;
    const dy = y - lastSampleRef.current.y;
    const dist = Math.hypot(dx, dy);

    if (dist >= TRAIL_SAMPLE_DIST) {
      lastSampleRef.current = { x, y };

      // Add new trail point
      const newPoint: TrailPoint = {
        x,
        y,
        alpha: 1.0,
        noiseSeed: Math.random() * 100,
        radius: TRAIL_HEAD_R,
      };

      trailRef.current.unshift(newPoint);
      if (trailRef.current.length > TRAIL_MAX_POINTS) {
        trailRef.current.pop();
      }
    }

    // 3D tilt calculation relative to center
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const rx = ((y - cy) / cy) * -12;
    const ry = ((x - cx) / cx) * 14;
    setTilt({ rx, ry });

    // Check proximity to center emblem for reveal trigger
    const distFromCenter = Math.hypot(x - cx, y - cy);
    if (distFromCenter < 280) {
      setIsRevealed(true);
    } else {
      setIsRevealed(false);
    }
  }, []);

  // Main Canvas Render Loop (60 FPS Trigonometric Noise Blob Engine)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const handleResize = () => {
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.scale(dpr, dpr);
    };

    handleResize();
    window.addEventListener("resize", handleResize);

    let time = 0;

    const render = () => {
      time += 0.025;
      ctx.clearRect(0, 0, width, height);

      const trail = trailRef.current;

      // Update and decay trail points
      for (let i = trail.length - 1; i >= 0; i--) {
        const pt = trail[i];
        pt.alpha *= TRAIL_FADE_SPEED;
        if (pt.alpha < 0.008) {
          trail.splice(i, 1);
        }
      }

      // If trail has points, render the organic 24-point harmonic noise blobs
      if (trail.length > 0) {
        // Render glowing background trails
        for (let i = trail.length - 1; i >= 0; i--) {
          const pt = trail[i];
          const scale = pt.alpha;
          const currentRadius = Math.max(15, pt.radius * Math.pow(scale, 0.7));

          // 24-Point Harmonic Noise Blob computation
          const blobCoords: { x: number; y: number }[] = [];
          for (let k = 0; k < TRAIL_BLOB_PTS; k++) {
            const theta = (k / TRAIL_BLOB_PTS) * Math.PI * 2;

            // Harmonic sin/cos trigonometric noise formula
            const noise =
              (Math.sin(theta * 3 + time * 2.5 + pt.noiseSeed) * 0.65 +
               Math.cos(theta * 4 - time * 2.0 + pt.noiseSeed * 1.5) * 0.35) *
              TRAIL_NOISE_AMP *
              scale;

            const r = Math.max(8, currentRadius + noise);
            const bx = pt.x + Math.cos(theta) * r;
            const by = pt.y + Math.sin(theta) * r;
            blobCoords.push({ x: bx, y: by });
          }

          // Draw organic smoothed path
          ctx.beginPath();
          if (blobCoords.length > 0) {
            const first = blobCoords[0];
            ctx.moveTo(first.x, first.y);
            for (let k = 0; k < blobCoords.length; k++) {
              const current = blobCoords[k];
              const next = blobCoords[(k + 1) % blobCoords.length];
              const midX = (current.x + next.x) / 2;
              const midY = (current.y + next.y) / 2;
              ctx.quadraticCurveTo(current.x, current.y, midX, midY);
            }
          }
          ctx.closePath();

          // Outer Emerald Bioluminescent Glow
          const gradGlow = ctx.createRadialGradient(
            pt.x,
            pt.y,
            currentRadius * 0.2,
            pt.x,
            pt.y,
            currentRadius * 1.4
          );
          gradGlow.addColorStop(0, `rgba(52, 211, 153, ${0.28 * scale})`);
          gradGlow.addColorStop(0.5, `rgba(16, 185, 129, ${0.14 * scale})`);
          gradGlow.addColorStop(1, `rgba(16, 185, 129, 0)`);

          ctx.fillStyle = gradGlow;
          ctx.fill();

          // Organic Pearlescent Contour Line
          ctx.strokeStyle = `rgba(167, 243, 208, ${0.35 * scale})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }

        // Inner Core Bioluminescent Head Ring
        const head = trail[0];
        if (head && head.alpha > 0.1) {
          const coreGrad = ctx.createRadialGradient(
            head.x,
            head.y,
            0,
            head.x,
            head.y,
            TRAIL_HEAD_R * 0.75
          );
          coreGrad.addColorStop(0, `rgba(255, 255, 255, ${0.35 * head.alpha})`);
          coreGrad.addColorStop(0.35, `rgba(52, 211, 153, ${0.25 * head.alpha})`);
          coreGrad.addColorStop(1, "rgba(5, 150, 105, 0)");

          ctx.beginPath();
          ctx.arc(head.x, head.y, TRAIL_HEAD_R * 0.75, 0, Math.PI * 2);
          ctx.fillStyle = coreGrad;
          ctx.fill();
        }
      }

      rafRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", handleResize);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      onPointerMove={handlePointerMove}
      className="stage absolute inset-0 w-full h-full overflow-hidden select-none cursor-crosshair bg-[#0a0d14]"
    >
      {/* Subtle radial grid background */}
      <div
        className="absolute inset-0 pointer-events-none opacity-20"
        style={{
          backgroundImage: `
            radial-gradient(circle at center, rgba(16, 185, 129, 0.08) 0%, transparent 65%),
            radial-gradient(circle at 1px 1px, rgba(255, 255, 255, 0.05) 1px, transparent 0)
          `,
          backgroundSize: "100%, 32px 32px"
        }}
      />

      {/* Canvas Mask & Trail Layer (z-2) */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none z-[2]"
      />

      {/* Central Visual Stack: Layer 1 (Holographic Chaos) vs Layer 2 (Emerald Ledger) */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[2]">
        <div
          className="animate-orb-subject relative w-[340px] sm:w-[420px] md:w-[480px] h-[480px] sm:h-[540px] transition-transform duration-300 ease-out"
          style={{
            transform: `perspective(1000px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
            transformStyle: "preserve-3d",
          }}
        >
          {/* Ambient Glow Aura */}
          <div className="animate-orb-glow absolute -inset-8 bg-gradient-to-tr from-emerald-500/15 via-emerald-400/5 to-transparent rounded-[48px] blur-3xl -z-10 pointer-events-none" />

          {/* FRONT LAYER (DEFAULT): Holographic delivery settlement stack showing chaotic GP deduction tags, ad fees, and platform splits. */}
          <div
            className={`absolute inset-0 rounded-[36px] bg-gradient-to-b from-[#11141b] via-[#0d1016] to-[#07090d] border border-white/10 shadow-[0_30px_90px_rgba(0,0,0,0.9),inset_0_1px_1px_rgba(255,255,255,0.15)] p-7 flex flex-col justify-between overflow-hidden transition-all duration-700 ${
              isRevealed ? "opacity-15 scale-[0.98] blur-[2px]" : "opacity-100 scale-100"
            }`}
          >
            {/* Top Identity bar */}
            <div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-300 shadow-inner">
                    <Activity className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                      Active Ingestion
                    </p>
                    <h3 className="text-xs font-extrabold text-white tracking-tight">
                      Holographic Settlement Stack
                    </h3>
                  </div>
                </div>

                <div className="px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-[9px] font-bold text-amber-300 flex items-center gap-1">
                  <TrendingDown className="w-3 h-3" />
                  Awaiting settlement data
                </div>
              </div>

              {/* GP Deduction Tags and Split Previews */}
              <div className="mt-8 space-y-3">
                <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/5 shadow-inner">
                  <div className="flex justify-between items-center text-xs text-slate-400 mb-1">
                    <span>Raw Gross Revenue</span>
                    <span className="text-slate-500 font-mono font-bold">—</span>
                  </div>
                  <div className="w-full bg-white/5 h-1.5 rounded-full overflow-hidden mt-2">
                    <div className="bg-gradient-to-r from-red-500 to-amber-500 h-full w-0" />
                  </div>
                </div>

                {/* Chaotic GP Deduction Splits */}
                <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/5 shadow-inner space-y-2.5">
                  <div className="flex justify-between items-center text-[11px] text-slate-500">
                    <span>Delivery Platforms GP Deductions</span>
                    <span className="text-slate-500 font-mono font-semibold">—</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2 rounded-xl bg-red-500/[0.03] border border-red-500/10 flex items-center justify-between">
                      <span className="text-[10px] text-red-300 font-medium">Grab Commission</span>
                      <span className="text-[10px] font-mono text-slate-500">—</span>
                    </div>
                    <div className="p-2 rounded-xl bg-amber-500/[0.03] border border-amber-500/10 flex items-center justify-between">
                      <span className="text-[10px] text-amber-300 font-medium">LINE MAN GP</span>
                      <span className="text-[10px] font-mono text-slate-500">—</span>
                    </div>
                    <div className="p-2 rounded-xl bg-violet-500/[0.03] border border-violet-500/10 flex items-center justify-between">
                      <span className="text-[10px] text-violet-300 font-medium">Merchant Promo</span>
                      <span className="text-[10px] font-mono text-slate-500">—</span>
                    </div>
                    <div className="p-2 rounded-xl bg-blue-500/[0.03] border border-blue-500/10 flex items-center justify-between">
                      <span className="text-[10px] text-blue-300 font-medium">In-App Ad Fees</span>
                      <span className="text-[10px] font-mono text-slate-500">—</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom Status */}
            <div className="pt-4 border-t border-white/5 flex items-center justify-between text-xs text-slate-500">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                Connect a data source to begin reconciliation
              </span>
              <span className="font-mono text-[10px] text-slate-600">CHAOTIC GP MATRIX</span>
            </div>
          </div>

          {/* REVEAL LAYER (UNDER MORPH TRAIL): live workspace ledger with no seeded figures */}
          <div
            className={`absolute inset-0 rounded-[36px] bg-gradient-to-b from-[#061d12] via-[#04150d] to-[#020a06] border border-emerald-500/35 shadow-[0_30px_90px_rgba(16,185,129,0.25),inset_0_1px_2px_rgba(52,211,153,0.5)] p-7 flex flex-col justify-between overflow-hidden transition-all duration-700 ${
              isRevealed
                ? "opacity-100 scale-100 pointer-events-auto"
                : "opacity-0 scale-[0.96] pointer-events-none"
            }`}
          >
            {/* Holographic matrix lines */}
            <div
              className="absolute inset-0 opacity-10 pointer-events-none"
              style={{
                backgroundImage: "radial-gradient(circle at 1px 1px, rgba(52,211,153,0.7) 1px, transparent 0)",
                backgroundSize: "16px 16px"
              }}
            />

            {/* Top Identity bar */}
            <div className="relative z-10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center text-emerald-300 shadow-lg shadow-emerald-500/25">
                    <Sparkles className="w-4 h-4 text-emerald-300" />
                  </div>
                  <div>
                    <p className="text-[10px] font-extrabold uppercase tracking-widest text-emerald-400">
                      Live reconciliation workspace
                    </p>
                    <h3 className="text-xs font-extrabold text-white tracking-tight">
                      Audited Net Ledger
                    </h3>
                  </div>
                </div>

                <span className="px-2.5 py-1 rounded-full bg-emerald-400/10 border border-emerald-400/30 text-[9px] font-extrabold text-emerald-300 flex items-center gap-1.5 shadow-sm">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  No data fabricated
                </span>
              </div>

              {/* Big Profit Number Display */}
              <div className="mt-8 p-5 rounded-2xl bg-emerald-950/30 border border-emerald-400/20 backdrop-blur-md shadow-xl">
                <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-300/80">
                  Live net payout
                </p>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-3xl sm:text-4xl font-black text-white font-mono tracking-tight">
                    —
                  </span>
                  <span className="text-xs font-extrabold text-emerald-400 flex items-center bg-emerald-500/10 px-2 py-0.5 rounded-lg border border-emerald-400/20">
                    <ArrowUpRight className="w-3.5 h-3.5 mr-0.5" />
                    Connect a workspace
                  </span>
                </div>

                {/* Micro Breakdown Bars */}
                <div className="mt-5 pt-4 border-t border-emerald-500/20 grid grid-cols-3 gap-2 text-[10px]">
                  <div>
                    <p className="text-emerald-400/60 font-medium">Gross Sales</p>
                    <p className="font-extrabold text-slate-500 font-mono mt-0.5">—</p>
                  </div>
                  <div>
                    <p className="text-emerald-400/60 font-medium">Audited GP</p>
                    <p className="font-extrabold text-slate-500 font-mono mt-0.5">—</p>
                  </div>
                  <div>
                    <p className="text-emerald-400/60 font-medium">Reconciled</p>
                    <p className="font-extrabold text-slate-500 font-mono mt-0.5">—</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom Call to Action inside Reveal */}
            <div className="relative z-10 pt-4 border-t border-emerald-500/20 flex items-center justify-between">
              <span className="text-xs text-emerald-300/90 font-semibold">
                Live figures appear after your first settlement sync
              </span>
              <button
                onClick={onOpenAuth}
                className="px-4 py-2 rounded-xl bg-emerald-400 hover:bg-emerald-300 text-slate-950 font-black text-xs shadow-lg shadow-emerald-500/35 hover:shadow-emerald-400/50 transition-all pointer-events-auto flex items-center gap-1.5 cursor-pointer"
              >
                <span>Enter Terminal</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
