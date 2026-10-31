"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { formatTHB } from "@/lib/utils";
import { TrendingUp, Loader2, AlertTriangle, CalendarDays } from "lucide-react";

/* =============================================================================
   Daily P&L — per-day profit & loss (gross -> deductions -> net -> cogs -> profit)
   ----------------------------------------------------------------------------
   Reads /api/analytics/daily-pnl (tenant proxy to FastAPI). Each row keeps
   actual itemized COGS separate from a historical weighted estimate.
   Defaults to the CURRENT MONTH (1st -> today); a date-range picker lets the
   user override the window.
   ============================================================================= */

interface DailyRow {
  date: string;
  gross_sales: string;
  deductions: string;
  net_sale: string;
  cogs: string;
  net_profit: string;
  cogs_source: "itemized" | "statistical_estimated" | "benchmark_estimated";
  cogs_ratio?: string;
  platform_coverage?: "complete" | "partial";
}

function num(v: string | undefined): number {
  const n = parseFloat(v || "0");
  return isNaN(n) ? 0 : n;
}

function fmtDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt.getTime())) return d;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(dt);
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function cogsLabel(source: DailyRow["cogs_source"]): string {
  if (source === "itemized") return "Actual cost";
  if (source === "statistical_estimated") return "Statistical estimate";
  return "Benchmark estimate";
}

/** Local (UTC+7) today, then the 1st of the current month. */
function currentMonthRange(): { start: string; end: string } {
  const nowUtc7 = new Date(Date.now() + 7 * 3600 * 1000);
  const start = new Date(nowUtc7.getFullYear(), nowUtc7.getMonth(), 1);
  return { start: toISO(start), end: toISO(nowUtc7) };
}

export default function DailyPnlPage() {
  const initialRange = currentMonthRange();
  const [rows, setRows] = useState<DailyRow[] | null>(null);
  const [foodCostRatio, setFoodCostRatio] = useState<string | null>(null);
  const [foodCostRatioSource, setFoodCostRatioSource] = useState<"historical_weighted" | "benchmark" | null>(null);
  const [foodCostSampleDays, setFoodCostSampleDays] = useState(0);
  const [completePlatformDays, setCompletePlatformDays] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editable inputs vs applied window (so we re-fetch only on Apply).
  const [startDate, setStartDate] = useState(initialRange.start);
  const [endDate, setEndDate] = useState(initialRange.end);
  const [appliedStart, setAppliedStart] = useState(initialRange.start);
  const [appliedEnd, setAppliedEnd] = useState(initialRange.end);
  const [branches, setBranches] = useState<{ branch_id: string; branch_name: string }[]>([]);
  const [branchId, setBranchId] = useState("");
  type BrandOpt = { id: string; name: string };
  const [brands, setBrands] = useState<BrandOpt[]>([]);
  const [brandId, setBrandId] = useState("");

  const load = useCallback(async (start: string, end: string, branch: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = `start_date=${start}&end_date=${end}${branch ? `&branch_id=${branch}` : ""}${brandId ? `&brand_id=${brandId}` : ""}`;
      const res = await fetch(`/api/analytics/daily-pnl?${qs}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.message || body?.detail || "Could not load daily P&L.");
        return;
      }
      setRows(Array.isArray(body.daily) ? body.daily : []);
      setFoodCostRatio(typeof body.food_cost_ratio === "string" ? body.food_cost_ratio : null);
      setFoodCostRatioSource(body.food_cost_ratio_source === "historical_weighted" ? "historical_weighted" : body.food_cost_ratio_source === "benchmark" ? "benchmark" : null);
      setFoodCostSampleDays(Number(body.food_cost_sample_days || 0));
      setCompletePlatformDays(Number(body.complete_platform_days || 0));
    } catch (err: any) {
      setError(err?.message || "Could not load daily P&L.");
    } finally {
      setLoading(false);
    }
  }, [brandId]);

  useEffect(() => {
    load(appliedStart, appliedEnd, branchId);
  }, [load, appliedStart, appliedEnd, branchId]);

  // Load the user's brand (store) set once for the Store dropdown.
  // Degrades gracefully (no store dropdown) if the endpoint omits `brands`.
  useEffect(() => {
    let active = true;
    fetch("/api/analytics/branches?brand_id=ALL", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (active && j && Array.isArray(j.brands)) {
          setBrands(j.brands.map((b: any) => ({ id: b.id, name: b.name })));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Load branch options scoped to the selected store (re-fetch on brand change).
  useEffect(() => {
    let active = true;
    const scope = brandId || "ALL";
    fetch(`/api/analytics/branches?brand_id=${scope}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!active) return;
        if (j && Array.isArray(j.branches)) {
          setBranches(
            j.branches.map((b: any) => ({
              branch_id: b.branch_id,
              branch_name: b.branch_name,
            }))
          );
        } else {
          setBranches([]);
        }
      })
      .catch(() => {
        if (active) setBranches([]);
      });
    return () => {
      active = false;
    };
  }, [brandId]);

  const applyDateRange = () => {
    if (startDate && endDate && startDate > endDate) return;
    setAppliedStart(startDate);
    setAppliedEnd(endDate);
  };

  const totals = (rows || []).reduce(
    (acc, r) => ({
      gross: acc.gross + num(r.gross_sales),
      ded: acc.ded + num(r.deductions),
      net: acc.net + num(r.net_sale),
      cogs: acc.cogs + num(r.cogs),
      profit: acc.profit + num(r.net_profit),
    }),
    { gross: 0, ded: 0, net: 0, cogs: 0, profit: 0 }
  );

  const itemizedDays = (rows || []).filter((r) => r.cogs_source === "itemized").length;
  const estimatedDays = (rows || []).length - itemizedDays;

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <Sidebar />
      <div className="md:ml-64 p-8">
        <Header settlementPeriod="Daily breakdown" />

        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
              <TrendingUp className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Daily P&L</h2>
              <p className="text-xs text-slate-400">
                Gross → platform deductions → net payout → food cost → net profit, per day
              </p>
            </div>
          </div>

          {/* Store filter + branch filter + date range picker */}
          <div className="flex flex-wrap items-end gap-2 w-full md:w-auto">
            {brands.length > 0 && (
              <label className="flex flex-col gap-1 flex-1 min-w-[140px]">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">Store</span>
                <select
                  value={brandId}
                  onChange={(e) => {
                    setBrandId(e.target.value);
                    setBranchId("");
                  }}
                  className="bg-[#131522] border border-white/10 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500/50 [color-scheme:dark]"
                >
                  <option value="">Default store</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">Branch</span>
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="bg-[#131522] border border-white/10 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500/50 [color-scheme:dark]"
              >
                <option value="">All branches</option>
                {branches.map((b) => (
                  <option key={b.branch_id} value={b.branch_id}>
                    {b.branch_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">From</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="bg-[#131522] border border-white/10 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500/50 [color-scheme:dark]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">To</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="bg-[#131522] border border-white/10 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500/50 [color-scheme:dark]"
              />
            </label>
            <button
              onClick={applyDateRange}
              className="px-4 py-2 rounded-xl bg-emerald-500 text-[#052e1d] text-sm font-bold hover:bg-emerald-400 transition-colors"
            >
              Apply
            </button>
          </div>
        </div>

        {/* Summary cards */}
        {rows && rows.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
            {[
              { label: "Gross Sales", value: totals.gross, cls: "text-slate-200" },
              { label: "Deductions", value: totals.ded, cls: "text-rose-300" },
              { label: "Net Payout", value: totals.net, cls: "text-sky-300" },
              { label: estimatedDays > 0 ? "COGS (incl. estimate)" : "COGS (food cost)", value: totals.cogs, cls: "text-amber-300" },
              { label: estimatedDays > 0 ? "Net Profit (estimated)" : "Net Profit", value: totals.profit, cls: totals.profit >= 0 ? "text-emerald-300" : "text-rose-300" },
            ].map((c) => (
              <div key={c.label} className="p-4 bg-[#131522] border border-white/5 rounded-2xl">
                <span className="text-[11px] text-slate-400 block">{c.label}</span>
                <span className={`font-bold text-base ${c.cls}`}>{formatTHB(c.value)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Coverage note */}
        {rows && rows.length > 0 && estimatedDays > 0 && (
          <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>
              {itemizedDays} days use itemized food cost; {estimatedDays} day
              {estimatedDays === 1 ? "" : "s"} use an estimate. Historical food-cost ratio: {
                foodCostRatio ? `${(Number(foodCostRatio) * 100).toFixed(1)}%` : "benchmark"
              } ({foodCostRatioSource === "historical_weighted" ? "historical weighted" : "benchmark"}; {foodCostSampleDays} costed sample days). {completePlatformDays} day
              {completePlatformDays === 1 ? " has" : "s have"} both Grab and LINE MAN coverage.
            </span>
          </div>
        )}

        {/* Table */}
        <div className="bg-[#131522] border border-white/5 rounded-3xl overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin" /> Loading daily P&L…
            </div>
          ) : error ? (
            <div className="py-16 text-center text-rose-400">{error}</div>
          ) : !rows || rows.length === 0 ? (
            <div className="py-16 text-center text-slate-400">
              No settlement data for the selected window.
            </div>
          ) : (
            <>
            <table className="hidden md:table w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 border-b border-white/10">
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3 text-right">Gross</th>
                  <th className="px-5 py-3 text-right">Deductions</th>
                  <th className="px-5 py-3 text-right">Net Payout</th>
                  <th className="px-5 py-3 text-right">Food Cost</th>
                  <th className="px-5 py-3 text-right">Net Profit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.date} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="px-5 py-2.5 text-slate-200 font-medium">
                      {fmtDate(r.date)}
                      <span className={`ml-2 text-[10px] ${r.cogs_source === "itemized" ? "text-emerald-400" : "text-amber-400"}`}>
                        {cogsLabel(r.cogs_source)}
                      </span>
                    </td>
                    <td className="px-5 py-2.5 text-right text-slate-200">{formatTHB(num(r.gross_sales))}</td>
                    <td className="px-5 py-2.5 text-right text-rose-300">-{formatTHB(num(r.deductions))}</td>
                    <td className="px-5 py-2.5 text-right text-sky-300">{formatTHB(num(r.net_sale))}</td>
                    <td className="px-5 py-2.5 text-right text-amber-300">
                      <span title={r.cogs_source === "itemized" ? "Itemized actual food cost" : "Historical estimate; not an accounting actual"}>
                        {r.cogs_source === "itemized" ? `-${formatTHB(num(r.cogs))}` : `≈ -${formatTHB(num(r.cogs))}`}
                      </span>
                    </td>
                    <td className={`px-5 py-2.5 text-right font-bold ${num(r.net_profit) >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                      <span title={r.cogs_source === "itemized" ? "Calculated from itemized food cost" : "Estimated net profit"}>
                        {r.cogs_source === "itemized" ? formatTHB(num(r.net_profit)) : `≈ ${formatTHB(num(r.net_profit))}`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/10 bg-white/[0.02]">
                  <td className="px-5 py-3 font-bold text-slate-200">Total</td>
                  <td className="px-5 py-3 text-right font-bold text-slate-200">{formatTHB(totals.gross)}</td>
                  <td className="px-5 py-3 text-right font-bold text-rose-300">-{formatTHB(totals.ded)}</td>
                  <td className="px-5 py-3 text-right font-bold text-sky-300">{formatTHB(totals.net)}</td>
                  <td className="px-5 py-3 text-right font-bold text-amber-300">{estimatedDays > 0 ? `≈ -${formatTHB(totals.cogs)}` : `-${formatTHB(totals.cogs)}`}</td>
                  <td className={`px-5 py-3 text-right font-bold ${totals.profit >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                    {estimatedDays > 0 ? `≈ ${formatTHB(totals.profit)}` : formatTHB(totals.profit)}
                  </td>
                </tr>
              </tfoot>
            </table>

              {/* MOBILE CARD VIEW (md:hidden) — one card per day, matching the table */}
              <div className="md:hidden p-3 space-y-3">
                {rows.map((r) => (
                  <div
                    key={r.date}
                    className="rounded-2xl border border-white/5 bg-white/[0.03] p-3"
                  >
                    <div className="font-bold text-slate-200 text-sm mb-2">
                      {fmtDate(r.date)}
                      <span className={`ml-2 text-[10px] ${r.cogs_source === "itemized" ? "text-emerald-400" : "text-amber-400"}`}>
                        {cogsLabel(r.cogs_source)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                        <div className="text-[10px] text-slate-400">Gross</div>
                        <div className="text-sm font-bold text-slate-200">
                          {formatTHB(num(r.gross_sales))}
                        </div>
                      </div>
                      <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                        <div className="text-[10px] text-slate-400">Net Payout</div>
                        <div className="text-sm font-bold text-sky-300">
                          {formatTHB(num(r.net_sale))}
                        </div>
                      </div>
                      <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                        <div className="text-[10px] text-slate-400">Deductions</div>
                        <div className="text-sm font-bold text-rose-300">
                          -{formatTHB(num(r.deductions))}
                        </div>
                      </div>
                      <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                        <div className="text-[10px] text-slate-400">Food Cost</div>
                        <div className="text-sm font-bold text-amber-300">
                          {r.cogs_source === "itemized" ? `-${formatTHB(num(r.cogs))}` : `≈ -${formatTHB(num(r.cogs))}`}
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-between items-center mt-2">
                      <span className="text-[10px] text-slate-400">Net Profit</span>
                      <span
                        className={`text-sm font-bold ${
                          num(r.net_profit) >= 0
                            ? "text-emerald-300"
                            : "text-rose-300"
                        }`}
                      >
                        {r.cogs_source === "itemized" ? formatTHB(num(r.net_profit)) : `≈ ${formatTHB(num(r.net_profit))}`}
                      </span>
                    </div>
                  </div>
                ))}

                {/* Total card (mirrors the tfoot) */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                  <div className="font-bold text-slate-200 text-sm mb-2">Total</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                      <div className="text-[10px] text-slate-400">Gross</div>
                      <div className="text-sm font-bold text-slate-200">
                        {formatTHB(totals.gross)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                      <div className="text-[10px] text-slate-400">Net Payout</div>
                      <div className="text-sm font-bold text-sky-300">
                        {formatTHB(totals.net)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                      <div className="text-[10px] text-slate-400">Deductions</div>
                      <div className="text-sm font-bold text-rose-300">
                        -{formatTHB(totals.ded)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                      <div className="text-[10px] text-slate-400">Food Cost</div>
                      <div className="text-sm font-bold text-amber-300">
                        {estimatedDays > 0 ? `≈ -${formatTHB(totals.cogs)}` : `-${formatTHB(totals.cogs)}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-between items-center mt-2">
                    <span className="text-[10px] text-slate-400">Net Profit</span>
                    <span
                      className={`text-sm font-bold ${
                        totals.profit >= 0 ? "text-emerald-300" : "text-rose-300"
                      }`}
                    >
                        {estimatedDays > 0 ? `≈ ${formatTHB(totals.profit)}` : formatTHB(totals.profit)}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="mt-4 flex items-center gap-1.5 text-[11px] text-slate-500">
          <CalendarDays className="w-3.5 h-3.5" />
          <span>
            Showing {fmtDate(appliedStart)} – {fmtDate(appliedEnd)}
            {brandId ? ` · ${brands.find((b) => b.id === brandId)?.name || "Store"}` : ""} · Net
            Profit = Net Payout − Food Cost; ≈ values are estimates.
          </span>
        </div>
      </div>
    </div>
  );
}
