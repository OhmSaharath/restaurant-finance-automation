"use client";

import React from "react";
import { Layers, Store, ArrowUpRight } from "lucide-react";
import { CoverflowCarousel, CoverflowSlide } from "@/components/ui/coverflow-carousel";
import { BranchFinancials } from "@/lib/data";
import { formatTHB } from "@/lib/utils";

interface BranchCardDeckProps {
  branches?: BranchFinancials[];
  activeBranchIndex?: number;
  onSelectBranchIndex?: (index: number) => void;
}

export function BranchCardDeck({
  branches,
  activeBranchIndex = 0,
  onSelectBranchIndex,
}: BranchCardDeckProps) {
  const branchList = branches || [];

  const slides: CoverflowSlide[] = branchList.map((b) => ({
    title: b.code,
    subtitle: b.name,
    meta: [
      {
        label: "Net Payout",
        value: formatTHB(b.netPayout),
      },
      { label: "Channel", value: b.dominantPlatform },
    ],
  }));

  const activeBranch = branchList[activeBranchIndex] || branchList[0];

  return (
    <div className="bg-[#131522] border border-white/5 rounded-3xl p-6 relative overflow-hidden flex flex-col justify-between h-full">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-white/5 flex items-center justify-center shrink-0">
            <Layers className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-200">
              Branch Liquidity Card Deck
            </h3>
            <p className="text-xs text-slate-400 truncate">
              Interactive 3D Physical Cards across restaurant network
            </p>
          </div>
        </div>
        <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
          {branchList.length} Active Branches
        </span>
      </div>

      {/* 21st.dev 3D Coverflow Carousel Centerpiece */}
      <div className="my-2">
        <CoverflowCarousel
          slides={slides}
          cardWidth="min(78vw, 340px)"
          showNavigation={true}
          showPagination={true}
          rotate={40}
          depth={0.55}
          gap={0.06}
          perspective={3.2}
          cardClassName="border border-white/30 shadow-[0_20px_40px_rgba(0,0,0,0.25)]"
        />
      </div>

      {/* Active Branch Detail Footer Bar */}
      {activeBranch && (
        <div className="pt-3 border-t border-white/10 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono font-bold text-slate-200 px-2 py-0.5 rounded-lg bg-white/10 text-[11px] shrink-0">
              {activeBranch.code}
            </span>
            <span className="text-slate-400 font-medium truncate max-w-[180px]">
              {activeBranch.name}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
            <span className="text-slate-400">Gross: {formatTHB(activeBranch.grossSales)}</span>
            <span className="text-emerald-400 font-bold">Net: {formatTHB(activeBranch.netPayout)}</span>
            <span className="text-slate-400 font-semibold">{activeBranch.orderCount} orders</span>
          </div>
        </div>
      )}
    </div>
  );
}
