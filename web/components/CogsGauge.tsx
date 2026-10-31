"use client";

import React from "react";
import { ShieldCheck, AlertTriangle, ChefHat } from "lucide-react";
import { formatTHB, formatPercent } from "@/lib/utils";

interface CogsGaugeProps {
  currentCogsPct?: number;
  benchmarkPct?: number;
  totalCogsAmount?: number;
  realNetProfit?: number;
}

export function CogsGauge({
  currentCogsPct,
  benchmarkPct = 35.0,
  totalCogsAmount,
  realNetProfit,
}: CogsGaugeProps) {
  // No fabricated COGS: without live values we render an explicit empty state.
  const hasData =
    currentCogsPct !== undefined &&
    totalCogsAmount !== undefined &&
    realNetProfit !== undefined;
  if (!hasData) {
    return (
      <div className="bg-[#131522] border border-white/5 rounded-3xl p-6 h-full flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center">
              <ChefHat className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-200">
                COGS & Recipe Food Cost Ratio
              </h3>
              <p className="text-xs text-slate-400">
                BOM-level ingredient costing vs 35% safety threshold
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-col items-center justify-center my-10 text-center">
          <ChefHat className="w-10 h-10 text-zinc-600 mb-3" />
          <p className="text-sm font-semibold text-zinc-300">No data for this period.</p>
          <p className="text-xs text-zinc-500 mt-1">
            No COGS figures are available within the selected window.
          </p>
        </div>
      </div>
    );
  }
  const isHealthy = currentCogsPct <= benchmarkPct;

  return (
    <div className="bg-[#131522] border border-white/5 rounded-3xl p-6 h-full flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center">
              <ChefHat className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-200">
                COGS & Recipe Food Cost Ratio
              </h3>
              <p className="text-xs text-slate-400">
                BOM-level ingredient costing vs 35% safety threshold
              </p>
            </div>
          </div>
        </div>

        {/* Gauge Visual Presentation */}
        <div className="flex flex-col items-center justify-center my-4">
          <div className="relative w-40 h-24 flex items-end justify-center overflow-hidden">
            {/* Semicircle background */}
            <div className="w-40 h-40 rounded-full border-[14px] border-white/10 absolute top-0" />
            {/* Active Semicircle indicator */}
            <div
              className={`w-40 h-40 rounded-full border-[14px] ${
                isHealthy ? "border-emerald-500" : "border-rose-500"
              } absolute top-0`}
              style={{
                clipPath: "polygon(0 0, 100% 0, 100% 50%, 0 50%)",
                transform: `rotate(${Math.min(180, (currentCogsPct / 50) * 180)}deg)`,
              }}
            />
            <div className="text-center z-10 pb-1">
              <span className="text-2xl font-black text-slate-200 block leading-none">
                {currentCogsPct.toFixed(1)}%
              </span>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Actual Food Cost
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 mt-2">
            {isHealthy ? (
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-xs font-bold">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Optimal Profit Margin (Safe &lt; 35%)</span>
              </div>
            ) : (
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/30 text-xs font-bold">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>Food Cost Alert (&gt; 35% benchmark)</span>
              </div>
            )}
          </div>
        </div>

        {/* Cost & Profit Breakdown */}
        <div className="grid grid-cols-2 gap-3 pt-4 border-t border-white/10 text-xs">
          <div className="p-3 bg-white/5 rounded-2xl border border-white/10">
            <span className="text-slate-400 text-[11px] block">Total COGS:</span>
            <span className="font-bold text-slate-200 text-sm">
              {formatTHB(totalCogsAmount)}
            </span>
          </div>

          <div className="p-3 bg-emerald-500/10 rounded-2xl border border-emerald-500/20">
            <span className="text-emerald-400 text-[11px] block">Real Net Profit:</span>
            <span className="font-bold text-emerald-300 text-sm">
              {formatTHB(realNetProfit)}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 text-[11px] text-slate-400 text-center">
        Synchronized with Recipe BOM master ingredients catalog.
      </div>
    </div>
  );
}
