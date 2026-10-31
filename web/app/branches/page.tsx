"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Inbox } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { LocationMap } from "@/components/ui/expand-map";
import { formatTHB } from "@/lib/utils";
import { getLiveBranchesPageData, BranchFinancials, TenantBrandOption } from "@/lib/data";

const toISODate = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export default function BranchesPage() {
  const [branches, setBranches] = useState<BranchFinancials[]>([]);
  const [brands, setBrands] = useState<TenantBrandOption[]>([]);
  const [selectedBrand, setSelectedBrand] = useState("ALL");
  const [activeBranch, setActiveBranch] = useState<BranchFinancials | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const load = async () => {
      // Trailing 30-day window.
      const now = new Date();
      const start = new Date(now);
      start.setDate(now.getDate() - 29);

      const data = await getLiveBranchesPageData(
        toISODate(start),
        toISODate(now),
        selectedBrand
      );
      if (!isMounted) return;
      setBranches(data.branches);
      setBrands(data.brands);
      if (data.branches.length > 0) setActiveBranch(data.branches[0]);
      setLoading(false);
    };

    load().catch(() => {
      if (isMounted) setLoading(false);
    });

    return () => {
      isMounted = false;
    };
  }, [selectedBrand]);

  const brandName = activeBranch?.brandName || "Workspace";
  const current = activeBranch || branches[0];
  const platforms = current && current.dominantPlatform ? [current.dominantPlatform] : [];

  // Loading state: centered spinner on the dark background.
  if (loading) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-emerald-400 animate-spin mx-auto mb-3" />
          <p className="text-xs font-semibold text-slate-400">Loading branch settlements...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-[#050505] text-slate-100 subtle-mesh-bg">
      <Sidebar brandName={brandName} />

      <main className="flex-1 w-full md:ml-64 px-4 md:px-8 py-6">
        <Header brandName={brandName} />

        <div className="mb-6 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link
                href="/"
                className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Overview</span>
              </Link>
            </div>
            <h1 className="text-xl font-bold text-slate-100 tracking-tight">
              Store Branches &amp; Geospatial Intelligence
            </h1>
            <p className="text-xs text-slate-400">
              Live store outlets and delivery pickup mapping
            </p>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="store-select" className="text-xs font-semibold text-slate-400">
              Store
            </label>
            <select
              id="store-select"
              value={selectedBrand}
              onChange={(e) => setSelectedBrand(e.target.value)}
              className="px-3 py-1.5 bg-[#12141a] border border-white/10 rounded-xl text-xs font-semibold text-slate-200 focus:outline-none"
            >
              <option value="ALL">All stores</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        </div>

        {branches.length === 0 ? (
          // Empty state: tenant has no settlement data for the window.
          // NEVER render hardcoded financial figures.
          <section className="flex flex-col items-center justify-center p-12 border border-zinc-800 rounded-3xl bg-zinc-950 text-center max-w-3xl mx-auto">
            <Inbox className="w-12 h-12 text-zinc-600 mb-4" />
            <h3 className="text-lg font-semibold text-zinc-200">
              No store branches with settlement data yet
            </h3>
            <p className="text-sm text-zinc-500 max-w-sm mt-1">
              Settlement records for this workspace will appear here once they are ingested.
            </p>
          </section>
        ) : (
          <>
            {/* Top Interactive Location Map */}
            {current && (
              <div className="mb-8">
                <LocationMap
                  location={current.name}
                  coordinates={current.coordinates || ""}
                  branchCode={current.code}
                  platforms={platforms}
                  className="h-[280px]"
                />
              </div>
            )}

            {/* Live Branches Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {branches.map((b) => {
                const isSelected = activeBranch?.code === b.code;
                return (
                  <div
                    key={b.code}
                    onClick={() => setActiveBranch(b)}
                    className={`dark-glass dark-glass-hover rounded-3xl p-5 border border-white/10 cursor-pointer flex flex-col justify-between transition-all ${
                      isSelected ? "ring-2 ring-emerald-500" : "hover:border-white/25"
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <span className="px-2.5 py-1 bg-emerald-500/20 text-emerald-300 rounded-xl text-xs font-mono font-bold border border-emerald-500/30">
                          {b.code}
                        </span>
                        <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                          {b.dominantPlatform}
                        </span>
                      </div>

                      <h3 className="text-sm font-bold text-slate-100 mb-1 line-clamp-1">
                        {b.name}
                      </h3>
                      <p className="text-[10px] text-slate-400 mb-1">
                        {b.brandName || "\u2014"}
                      </p>
                    </div>

                    <div className="pt-3 border-t border-white/10 space-y-1.5 text-xs mt-4">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Gross Sales:</span>
                        <span className="font-semibold text-slate-200">
                          {formatTHB(b.grossSales)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Net Payout:</span>
                        <span className="font-bold text-emerald-400">
                          {formatTHB(b.netPayout)}
                        </span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-slate-400">Order Volume:</span>
                        <span className="font-mono text-slate-300">
                          {b.orderCount} orders
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
