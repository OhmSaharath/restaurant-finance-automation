"use client";

import React, { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import {
  CheckCircle,
  Calendar,
  Wallet,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Mail,
  PlugZap,
} from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { formatTHB, parseFinancialDetails } from "@/lib/utils";
import { FinancialBreakdownDrawer } from "@/components/FinancialBreakdownDrawer";
import GlassmorphismCta from "@/components/ui/glassmorphism-cta";

interface SettlementRow {
  id: number | string;
  reportDate: string;
  branchId: string;
  branchCode: string;
  branchName: string;
  brandId: string;
  brandName?: string;
  platform: "LINE MAN" | "Grab" | "Shopee Food" | "Robinhood";
  orderCount: number;
  grossSales: number;
  deductions: number;
  netSale: number;
  reconciliationStatus: "MATCHED" | "RECONCILED";
  details?: any;
}

/** Tenant Thai (U+0E00-U+0E7F) UI copy — written only as \\uXXXX escapes because
 * raw Thai/Bengali literals are mojibaked by the edit channel. These are the
 * exact glyphs specified in the reconciliation brief (all Thai block). */
const TXT = {
  // Title + subtitle drill-down
  title:
    "\u0e15\u0e23\u0e27\u0e08\u0e2a\u0e2d\u0e1a\u0e22\u0e2d\u0e14\u0e02\u0e32\u0e22\u0e23\u0e32\u0e22\u0e27\u0e31\u0e19 (\u0e01\u0e23\u0e30\u0e17\u0e1a\u0e22\u0e2d\u0e14)",
  hdrDrill: "\u0e40\u0e08\u0e32\u0e30\u0e25\u0e36\u0e01",
  hdrDay: "\u0e27\u0e31\u0e19",
  hdrApp: "\u0e41\u0e2d\u0e1e",
  hdrBranch: "\u0e2a\u0e32\u0e02\u0e32",
  // Summary cards
  sumGross: "\u0e22\u0e2d\u0e14\u0e02\u0e32\u0e22\u0e23\u0e27\u0e21",
  sumDeductions:
    "\u0e04\u0e48\u0e32\u0e18\u0e23\u0e23\u0e21\u0e40\u0e19\u0e35\u0e22\u0e21\u0e23\u0e27\u0e21",
  sumNet: "\u0e22\u0e2d\u0e14\u0e23\u0e31\u0e1a\u0e08\u0e23\u0e34\u0e07",
  sumOrders: "\u0e08\u0e33\u0e19\u0e27\u0e19\u0e2d\u0e2d\u0e40\u0e14\u0e2d\u0e23\u0e4c",
  // Table headers
  thDate: "\u0e27\u0e31\u0e19\u0e17\u0e35\u0e48",
  thBranch: "\u0e2a\u0e32\u0e02\u0e32",
  thPlatform: "\u0e41\u0e2d\u0e1e",
  thOrders: "\u0e2d\u0e2d\u0e40\u0e14\u0e2d\u0e23\u0e4c",
  thGross: "\u0e22\u0e2d\u0e14\u0e02\u0e32\u0e22\u0e23\u0e27\u0e21",
  thDeductions:
    "\u0e04\u0e48\u0e32\u0e18\u0e23\u0e23\u0e21\u0e40\u0e19\u0e35\u0e22\u0e21",
  thNet: "\u0e22\u0e2d\u0e14\u0e23\u0e31\u0e1a\u0e08\u0e23\u0e34\u0e07",
  thStatus: "\u0e2a\u0e16\u0e32\u0e19\u0e30",
  // Status
  matched: "\u0e15\u0e23\u0e07\u0e01\u0e31\u0e19",
  // Filter labels
  allBrands: "\u0e17\u0e38\u0e01\u0e23\u0e49\u0e32\u0e19",
  allBranches: "\u0e17\u0e38\u0e01\u0e2a\u0e32\u0e02\u0e32",
  allPlatforms: "\u0e17\u0e38\u0e01\u0e41\u0e2d\u0e1e",
  // Sync button
  sync: "\u0e14\u0e36\u0e07\u0e2d\u0e35\u0e40\u0e21\u0e25\u0e22\u0e2d\u0e14\u0e02\u0e32\u0e22\u0e25\u0e48\u0e32\u0e2a\u0e38\u0e14",
  // Loading / empty
  loading:
    "\u0e01\u0e33\u0e25\u0e31\u0e07\u0e42\u0e2b\u0e25\u0e14\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25...",
  empty:
    "\u0e44\u0e21\u0e48\u0e1e\u0e1a\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\u0e43\u0e19\u0e0a\u0e48\u0e27\u0e07\u0e17\u0e35\u0e48\u0e40\u0e25\u0e37\u0e2d\u0e01",
};

export default function ReconciliationPage() {
  const [settlements, setSettlements] = useState<SettlementRow[]>([]);

  // Live tenant branches (from the tenant-scoped route) populate the branch filter.
  const [branches, setBranches] = useState<
    { branch_id: string; branch_code: string; branch_name: string }[]
  >([]);

  // ---- Dynamic default date range: current month (navigable to history) ----
  // Standard JS (no date-fns needed). Defaults to start-of-month .. today.
  // Users can still navigate backwards (e.g. June) — no fromDate cap.
  const toISODate = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const nowD = new Date();
  const firstOfMonth = new Date(nowD.getFullYear(), nowD.getMonth(), 1);
  // Keep the default window identical to Overview and Daily P&L: month start through today.
  const lastOfMonth = nowD;
  const [startDate, setStartDate] = useState(toISODate(firstOfMonth));
  const [endDate, setEndDate] = useState(toISODate(lastOfMonth));
  const [platformFilter, setPlatformFilter] = useState("ALL");
  const [brandFilter, setBrandFilter] = useState("ALL");
  const [branchFilter, setBranchFilter] = useState("ALL");
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Gmail ingestion sync trigger (with configurable date-range modal)
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncToast, setSyncToast] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0); // bump to force a fresh reconciliation fetch
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null);
  const [syncRangeType, setSyncRangeType] = useState<"days" | "custom">("days");
  const [syncDays, setSyncDays] = useState(7);
  const [syncStart, setSyncStart] = useState("2026-01-01");
  const [syncEnd, setSyncEnd] = useState("2026-12-31");

  // Hierarchical drill-down expand state
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [expandedPlatforms, setExpandedPlatforms] = useState<Set<string>>(new Set());
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(new Set());

  // Fetch the tenant's real branches ONCE (tenant-scoped route; brand_id is
  // always resolved server-side from ctx.brandId — never trusted from a client).
  useEffect(() => {
    let isMounted = true;
    fetch("/api/analytics/branches")
      .then((res) => res.json())
      .then((json) => {
        if (isMounted && json.success && Array.isArray(json.branches)) {
          setBranches(json.branches);
        }
      })
      .catch(() => {
        /* branch list is optional — the "All branches" default still works */
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const fetchLiveReconciliation = async () => {
      try {
        setIsLoading(true);
        setErrorMessage(null);
        const res = await fetch("/api/reconciliation");
        const json = await res.json();

        if (json.success && json.data && isMounted) {
          const mapped: SettlementRow[] = json.data.map((r: any) => {
            // Per-row financial rounding helper (2dp) — eliminates floating-point drift.
            const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

            const platform = r.platform || "LINE MAN";
            const rawDetails =
              typeof r.details === "string" ? r.details : r.details || {};
            const parsed = parseFinancialDetails(platform, rawDetails);
            // Financial Precision: JSONB positive deductions must never be
            // coerced to 0.00. Prefer the JSONB breakdown total when present;
            // fall back to the DB column only when JSONB holds no deductions.
            const dbDeductionsNum = parseFloat(r.deductions ?? "0");
            const jsonbDeductions = Number.isFinite(parsed.deductions.total)
              ? parsed.deductions.total
              : 0;
            const deductionsRaw =
              jsonbDeductions > 0 ? jsonbDeductions : dbDeductionsNum;

            const grossSales = round2(
              Number.isFinite(parseFloat(r.gross_sales)) ? parseFloat(r.gross_sales) : 0
            );
            const deductions = round2(
              Number.isFinite(deductionsRaw) ? deductionsRaw : 0
            );
            // Strict financial balance: net is DERIVED from gross − deductions and never
            // read from the raw net_sale column, which may be stale/unadjusted when the
            // JSONB deductions breakdown overrides the column.
            const netSale = round2(grossSales - deductions);

            // Parse JSONB details defensively — a single corrupted payload must not
            // crash the entire table.
            let detailObj: any = {};
            if (typeof rawDetails === "string") {
              try {
                detailObj = JSON.parse(rawDetails);
              } catch {
                detailObj = {};
              }
            } else {
              detailObj = rawDetails;
            }

            return {
              id: r.id,
              reportDate: r.report_date,
              branchId: String(r.branches?.id || ""),
              branchCode: r.branches?.branch_code || "—",
              branchName: r.branches?.branch_name || r.shop_name_raw || "—",
              brandId: String(r.branches?.brand_id || ""),
              brandName: r.branches?.brands?.name || "—",
              platform,
              orderCount: parseInt(r.order_count || "0", 10),
              grossSales,
              deductions,
              netSale,
              reconciliationStatus: "MATCHED",
              details: detailObj,
            };
          });
          setSettlements(mapped);
          setErrorMessage(null);
        } else if (isMounted) {
          setErrorMessage(json.error || "Failed to load reconciliation records");
        }
      } catch (err: any) {
        if (isMounted) {
          setErrorMessage(err.message || String(err));
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    fetchLiveReconciliation();
    return () => {
      isMounted = false;
    };
  }, [dataVersion]);

  const filtered = settlements.filter((r) => {
    const matchDate =
      (!startDate || r.reportDate >= startDate) && (!endDate || r.reportDate <= endDate);
    const matchPlatform = platformFilter === "ALL" || r.platform === platformFilter;
    // Branch filter matches on the REAL branch_id (from the tenant-scoped route),
    // not the legacy hardcoded branch_code.
    const matchBranch = branchFilter === "ALL" || r.branchId === branchFilter;
    const matchBrand = brandFilter === "ALL" || r.brandId === brandFilter;
    return matchDate && matchPlatform && matchBrand && matchBranch;
  });

  // Brand options derived from the loaded settlements (unique store + name).
  const brandOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of settlements) {
      if (r.brandId && !seen.has(r.brandId)) seen.set(r.brandId, r.brandName || r.brandId);
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [settlements]);

  // ---- Live summary cards derived from the selected date range ----
  // Sum gross_sales / deductions / net_sale / order_count from the filtered rows.
  const summary = filtered.reduce(
    (acc, r) => {
      acc.gross += r.grossSales;
      acc.deductions += r.deductions;
      acc.net += r.netSale;
      acc.orders += r.orderCount;
      return acc;
    },
    { gross: 0, deductions: 0, net: 0, orders: 0 }
  );
  const round2sum = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
  const summaryGross = round2sum(summary.gross);
  const summaryDeductions = round2sum(summary.deductions);
  const summaryNet = round2sum(summary.net);

  // Hierarchical aggregation: report_date -> platform -> branches
  const grouped = useMemo(() => {
    const dateMap = new Map<
      string,
      {
        gross: number;
        ded: number;
        net: number;
        orders: number;
        platforms: Map<
          string,
          { gross: number; ded: number; net: number; orders: number; branches: SettlementRow[] }
        >;
      }
    >();

    for (const r of filtered) {
      let d = dateMap.get(r.reportDate);
      if (!d) {
        d = { gross: 0, ded: 0, net: 0, orders: 0, platforms: new Map() };
        dateMap.set(r.reportDate, d);
      }
      // Round every aggregation to 2dp so summed floats never drift.
      d.gross = Math.round((d.gross + r.grossSales) * 100) / 100;
      d.ded = Math.round((d.ded + r.deductions) * 100) / 100;
      d.net = Math.round((d.net + r.netSale) * 100) / 100;
      d.orders += r.orderCount;

      let pf = d.platforms.get(r.platform);
      if (!pf) {
        pf = { gross: 0, ded: 0, net: 0, orders: 0, branches: [] };
        d.platforms.set(r.platform, pf);
      }
      pf.gross = Math.round((pf.gross + r.grossSales) * 100) / 100;
      pf.ded = Math.round((pf.ded + r.deductions) * 100) / 100;
      pf.net = Math.round((pf.net + r.netSale) * 100) / 100;
      pf.orders += r.orderCount;
      pf.branches.push(r);
    }

    return Array.from(dateMap.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  const toggleDate = (date: string) =>
    setExpandedDates((prev) => {
      const s = new Set(prev);
      s.has(date) ? s.delete(date) : s.add(date);
      return s;
    });

  const togglePlatform = (key: string) =>
    setExpandedPlatforms((prev) => {
      const s = new Set(prev);
      s.has(key) ? s.delete(key) : s.add(key);
      return s;
    });

  const toggleBranch = (key: string) =>
    setExpandedBranches((prev) => {
      const s = new Set(prev);
      s.has(key) ? s.delete(key) : s.add(key);
      return s;
    });

  // Fresh Gmail connection check via the RLS-scoped status endpoint.
  // Returns json.connected; returns false on any fetch/parse error so an
  // unreachable check degrades to prompting the user to connect.
  const checkGmailStatus = async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/integrations/google/status");
      const json = await res.json();
      const connected = json && json.connected === true;
      setGmailConnected(connected);
      return connected;
    } catch {
      setGmailConnected(false);
      return false;
    }
  };

  // Pre-warm the connection state on mount (non-blocking UI).
  useEffect(() => {
    checkGmailStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open the date-range confirmation modal — but only if Gmail is connected.
  // If not connected, route to the "Connect Gmail" modal instead.
  const openSyncModal = async () => {
    setSyncToast(null);
    const ok = await checkGmailStatus();
    if (ok) setSyncModalOpen(true);
    else setConnectModalOpen(true);
  };

  // Execute the sync with the chosen range; posts a JSON body to the backend.
  // Warning threshold: any range spanning more than 90 days is "historical".
  const syncIsHistorical = () => {
    if (syncRangeType === "days") return syncDays > 90;
    const startMs = Date.parse(syncStart);
    const endMs = Date.parse(syncEnd);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return false;
    return (endMs - startMs) / 86_400_000 + 1 > 90;
  };

  const runSync = async () => {
    setIsSyncing(true);
    setSyncToast(null);
    setSyncModalOpen(false);
    const body = syncRangeType === "custom"
      ? { rangeType: "custom", startDate: syncStart, endDate: syncEnd }
      : { rangeType: "days", days: syncDays };
    try {
      const res = await fetch("/api/integrations/google/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (res.ok) {
        setSyncToast("Data synced successfully from Gmail");
        setDataVersion((v) => v + 1); // force refetch of reconciliation data
      } else if (res.status === 429) {
        setSyncToast(`⚠ Rate limit reached: ${json.message || "max 5 syncs/hour"}`);
      } else {
        setSyncToast(`⛔ Sync failed: ${json.message || json.error || "unknown error"}`);
      }
    } catch (err: any) {
      setSyncToast(`⛔ Sync failed: ${err.message}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const PlatformBadge = ({ platform, small = false }: { platform: string; small?: boolean }) => (
    <span
      className={`inline-flex items-center rounded-full font-bold border ${
        small ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10px]"
      } ${
        platform === "LINE MAN"
          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
          : "bg-green-500/10 text-green-400 border-green-500/30"
      }`}
    >
      {platform}
    </span>
  );

  return (
    <div className="min-h-screen flex bg-[#050505] text-slate-100 subtle-mesh-bg">
      <Sidebar />

      <main className="flex-1 w-full md:ml-64 px-4 md:px-8 py-6">
        <Header />

        <div className="mb-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link
                href="/dashboard"
                className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
              >
                <ChevronRight className="w-3.5 h-3.5" />
                <span>Back to Overview</span>
              </Link>
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight">
              {TXT.title}
            </h1>
            <p className="text-xs text-slate-400">
              {TXT.hdrDrill}: <span className="text-emerald-400">{TXT.hdrDay}</span>{" "}
              → <span className="text-emerald-400">{TXT.hdrApp}</span> (Grab/LINE MAN){" "}
              → <span className="text-emerald-400">{TXT.hdrBranch}</span>
            </p>
          </div>

          {/* Filters Bar: Date Range, Platform, Branch */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-xl px-2.5 py-1 text-xs">
              <Calendar className="w-3.5 h-3.5 text-emerald-400" />
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="bg-transparent text-white focus:outline-none text-xs"
              />
              <span className="text-slate-500">to</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="bg-transparent text-white focus:outline-none text-xs"
              />
            </div>

            <GlassmorphismCta
              label={TXT.sync}
              icon={<RefreshCw />}
              onClick={openSyncModal}
              isLoading={isSyncing}
            />

            <select
              value={platformFilter}
              onChange={(e) => setPlatformFilter(e.target.value)}
              className="px-3 py-1.5 bg-[#12141a] border border-white/10 rounded-xl text-xs font-semibold text-slate-200 focus:outline-none"
            >
              <option value="ALL">{TXT.allPlatforms}</option>
              <option value="LINE MAN">LINE MAN</option>
              <option value="Grab">Grab</option>
            </select>

            <select
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
              className="px-3 py-1.5 bg-[#12141a] border border-white/10 rounded-xl text-xs font-semibold text-slate-200 focus:outline-none"
            >
              <option value="ALL">{TXT.allBrands}</option>
              {brandOptions.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>

            <select
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              className="px-3 py-1.5 bg-[#12141a] border border-white/10 rounded-xl text-xs font-semibold text-slate-200 focus:outline-none"
            >
              <option value="ALL">{TXT.allBranches}</option>
              {branches.map((b) => (
                <option key={b.branch_id} value={b.branch_id}>
                  {b.branch_name || b.branch_code}
                </option>
              ))}
            </select>
          </div>
        </div>

        {errorMessage && (
          <div className="mb-6 p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
            Error loading live data: {errorMessage}
          </div>
        )}

        {syncToast && (
          <div className="fixed bottom-6 right-6 z-50 px-4 py-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-semibold shadow-2xl max-w-sm">
            {syncToast}
          </div>
        )}

        {/* Live Summary Cards (dynamic to the selected date range) */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-[11px] font-semibold text-slate-400 tracking-wide">{TXT.sumGross}</p>
            <p className="text-xl font-bold text-white mt-1">{formatTHB(summaryGross)}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-[11px] font-semibold text-slate-400 tracking-wide">{TXT.sumDeductions}</p>
            <p className="text-xl font-bold text-purple-300 mt-1">{formatTHB(summaryDeductions)}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-[11px] font-semibold text-slate-400 tracking-wide">{TXT.sumNet}</p>
            <p className="text-xl font-bold text-emerald-400 mt-1">{formatTHB(summaryNet)}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-[11px] font-semibold text-slate-400 tracking-wide">{TXT.sumOrders}</p>
            <p className="text-xl font-bold text-sky-400 mt-1">{summary.orders.toLocaleString()}</p>
          </div>
        </section>

        {/* Configurable Date-Range Sync Modal */}
        {syncModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="dark-glass rounded-3xl border border-white/20 shadow-2xl p-6 w-full max-w-md">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-emerald-400" />
                <span>Sync Settlement Emails</span>
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Pull Grab / LINE MAN settlement emails from the connected Gmail account into reconciliation.
              </p>

              <div className="mt-4 space-y-2">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="syncRange"
                    checked={syncRangeType === "days"}
                    onChange={() => setSyncRangeType("days")}
                    className="accent-emerald-500 mt-0.5"
                  />
                  <div>
                    <span className="text-sm font-semibold text-white block">Last {syncDays} Days</span>
                    <span className="text-[10px] text-slate-500">Rolling window ending today</span>
                  </div>
                </label>

                <div className="flex flex-wrap gap-1.5 mt-1">
                  {[7, 30, 90, 180].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => { setSyncRangeType("days"); setSyncDays(d); }}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                        syncRangeType === "days" && syncDays === d
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                          : "bg-white/5 text-slate-300 border border-white/10 hover:bg-white/10"
                      }`}
                    >
                      {d === 7 ? "Last 7 Days" : d === 30 ? "Last 30 Days (1 Month)" : d === 90 ? "Last 90 Days (3 Months)" : "Last 180 Days (6 Months)"}
                    </button>
                  ))}
                </div>

                <label className="flex items-start gap-3 cursor-pointer mt-2">
                  <input
                    type="radio"
                    name="syncRange"
                    checked={syncRangeType === "custom"}
                    onChange={() => setSyncRangeType("custom")}
                    className="accent-emerald-500 mt-0.5"
                  />
                  <div>
                    <span className="text-sm font-semibold text-white block">Custom Date Range</span>
                    <span className="text-[10px] text-slate-500">Pick an explicit start &amp; end date</span>
                  </div>
                </label>

                {syncRangeType === "custom" && (
                  <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3 py-2 mt-1 text-xs">
                    <input
                      type="date"
                      value={syncStart}
                      onChange={(e) => setSyncStart(e.target.value)}
                      className="bg-transparent text-white focus:outline-none text-xs"
                    />
                    <span className="text-slate-500">to</span>
                    <input
                      type="date"
                      value={syncEnd}
                      onChange={(e) => setSyncEnd(e.target.value)}
                      className="bg-transparent text-white focus:outline-none text-xs"
                    />
                  </div>
                )}
              </div>

              {/* Historical sync warning (>90 days) */}
              {syncIsHistorical() && (
                <div className="mt-4 p-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[11px] flex items-center gap-2">
                  <span className="text-base">⚠</span>
                  <span>
                    Historical sync may take up to 30-60 seconds depending on Gmail attachment sizes.
                  </span>
                </div>
              )}

              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSyncModalOpen(false)}
                  disabled={isSyncing}
                  className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-semibold border border-white/10"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={runSync}
                  disabled={isSyncing}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-2 active:scale-95"
                >
                  {isSyncing ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Syncing...</span>
                    </>
                  ) : (
                    <span>Start Sync</span>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Connect Gmail Gate Modal — shown when the tenant has not yet granted
            gmail.readonly consent. Syncing settlement emails requires a connected
            Gmail account, so we block the date-range flow until one exists. */}
        {connectModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="dark-glass rounded-3xl border border-white/20 shadow-2xl p-6 w-full max-w-md">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <PlugZap className="w-4 h-4 text-emerald-400" />
                <span>Connect Gmail First</span>
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                To pull your Grab / LINE MAN settlement emails, connect the Gmail
                account that receives them. You&apos;ll be asked to grant read-only
                access to your Gmail.
              </p>

              <div className="mt-4 p-3 rounded-2xl bg-sky-500/10 border border-sky-500/30 text-sky-300 text-[11px] flex items-start gap-2">
                <Mail className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  Google will redirect you to authorize a{" "}
                  <span className="font-semibold">gmail.readonly</span> scope. After
                  connecting, return here to sync your settlement emails.
                </span>
              </div>

              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConnectModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-semibold border border-white/10"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    window.location.href = "/api/integrations/google/connect";
                  }}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-2 active:scale-95"
                >
                  <Mail className="w-3.5 h-3.5" />
                  <span>Connect Gmail</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Hierarchical Settlement Table */}
        <div className="dark-glass rounded-3xl border border-white/10 overflow-hidden shadow-2xl">
          <div className="hidden md:block overflow-x-auto max-h-[600px]">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-white/5 sticky top-0 z-10 border-b border-white/10 text-slate-400 font-bold tracking-wider text-[10px]">
                <tr>
                  <th className="py-3 px-4 w-8"></th>
                  <th className="py-3 px-4">{TXT.thDate}</th>
                  <th className="py-3 px-4">{TXT.thBranch}</th>
                  <th className="py-3 px-4">{TXT.thPlatform}</th>
                  <th className="py-3 px-4 text-right">{TXT.thOrders}</th>
                  <th className="py-3 px-4 text-right">{TXT.thGross}</th>
                  <th className="py-3 px-4 text-right">{TXT.thDeductions}</th>
                  <th className="py-3 px-4 text-right">{TXT.thNet}</th>
                  <th className="py-3 px-4 text-center">{TXT.thStatus}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10 font-medium text-slate-300">
                {isLoading ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-slate-400">
                      <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                      <span>{TXT.loading}</span>
                    </td>
                  </tr>
                ) : grouped.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-slate-400">
                      {TXT.empty} (
                      {settlements.length} total loaded)
                    </td>
                  </tr>
                ) : (
                  grouped.map(([date, d]) => {
                    const dateExpanded = expandedDates.has(date);
                    const platforms = Array.from(d.platforms.entries()).sort((a, b) =>
                      a[0].localeCompare(b[0])
                    );

                    return (
                      <React.Fragment key={date}>
                        {/* ─── LEVEL 1: Date Row ─── */}
                        <tr
                          onClick={() => toggleDate(date)}
                          className="hover:bg-emerald-500/5 transition-colors cursor-pointer bg-white/[0.02]"
                        >
                          <td className="py-3 px-4 text-slate-400">
                            {dateExpanded ? (
                              <ChevronDown className="w-4 h-4 text-emerald-400" />
                            ) : (
                              <ChevronRight className="w-4 h-4 text-slate-500" />
                            )}
                          </td>
                          <td className="py-3 px-4">
                            <span className="font-bold text-white font-mono">{date}</span>
                          </td>
                          <td className="py-3 px-4">
                            <span className="text-slate-300">
                              {platforms.reduce((n, [, p]) => n + p.branches.length, 0)}{" "}
                              branches · {platforms.length} platforms
                            </span>
                          </td>
                          <td className="py-3 px-4 text-slate-400">{TXT.allPlatforms}</td>
                          <td className="py-3 px-4 text-right font-mono text-slate-200">
                            {d.orders}
                          </td>
                          <td className="py-3 px-4 text-right text-white font-bold">
                            {formatTHB(d.gross)}
                          </td>
                          <td className="py-3 px-4 text-right text-rose-400">
                            -{formatTHB(d.ded)}
                          </td>
                          <td className="py-3 px-4 text-right font-bold text-emerald-400">
                            {formatTHB(d.net)}
                          </td>
                          <td className="py-3 px-4 text-center">
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                              <CheckCircle className="w-3 h-3" />
                              <span>{TXT.matched}</span>
                            </span>
                          </td>
                        </tr>

                        {dateExpanded &&
                          platforms.map(([platform, pf]) => {
                            const pfKey = `${date}|${platform}`;
                            const pfExpanded = expandedPlatforms.has(pfKey);

                            return (
                              <React.Fragment key={pfKey}>
                                {/* ─── LEVEL 2: Platform Subtotal Row ─── */}
                                <tr
                                  onClick={() => togglePlatform(pfKey)}
                                  className="hover:bg-white/5 transition cursor-pointer bg-[#0d1015]"
                                >
                                  <td className="py-2.5 px-4 pl-10 text-slate-400">
                                    {pfExpanded ? (
                                      <ChevronDown className="w-4 h-4 text-slate-300" />
                                    ) : (
                                      <ChevronRight className="w-4 h-4 text-slate-500" />
                                    )}
                                  </td>
                                  <td className="py-2.5 px-4"></td>
                                  <td className="py-2.5 px-4 text-[10px] text-slate-500">
                                    <span className="flex items-center gap-1">
                                      <Wallet className="w-3 h-3" />
                                      {pf.branches.length} branch(es)
                                    </span>
                                  </td>
                                  <td className="py-2.5 px-4">
                                    <PlatformBadge platform={platform} />
                                  </td>
                                  <td className="py-2.5 px-4 text-right font-mono text-slate-300">
                                    {pf.orders}
                                  </td>
                                  <td className="py-2.5 px-4 text-right text-slate-200">
                                    {formatTHB(pf.gross)}
                                  </td>
                                  <td className="py-2.5 px-4 text-right text-rose-400">
                                    -{formatTHB(pf.ded)}
                                  </td>
                                  <td className="py-2.5 px-4 text-right font-semibold text-emerald-400">
                                    {formatTHB(pf.net)}
                                  </td>
                                  <td className="py-2.5 px-4 text-center text-[10px] text-slate-500">
                                    {TXT.matched}
                                  </td>
                                </tr>

                                {pfExpanded &&
                                  pf.branches.map((row) => {
                                    const bKey = `${date}|${platform}|${row.branchCode}`;
                                    const bExpanded = expandedBranches.has(bKey);

                                    return (
                                      <React.Fragment key={bKey}>
                                        {/* ─── LEVEL 3: Branch / Slip Row ─── */}
                                        <tr
                                          onClick={() => toggleBranch(bKey)}
                                          className={`hover:bg-white/5 transition cursor-pointer ${
                                            bExpanded ? "bg-black/40" : "bg-black/20"
                                          }`}
                                        >
                                          <td className="py-3 px-4 pl-16 text-slate-400">
                                            {bExpanded ? (
                                              <ChevronDown className="w-4 h-4 text-slate-300" />
                                            ) : (
                                              <ChevronRight className="w-4 h-4 text-slate-500" />
                                            )}
                                          </td>
                                          <td className="py-3 px-4"></td>
                                          <td className="py-3 px-4">
                                            <span className="font-semibold text-white block">
                                              {row.branchCode}
                                            </span>
                                            {row.branchCode === "—" ? (
                                              <span className="text-[10px] text-amber-400">
                                                ⚠ Missing branch mapping
                                              </span>
                                            ) : (
                                              <span className="text-[10px] text-emerald-400">
                                                {row.brandName} · {row.branchName}
                                              </span>
                                            )}
                                          </td>
                                          <td className="py-3 px-4">
                                            <PlatformBadge platform={row.platform} small />
                                          </td>
                                          <td className="py-3 px-4 text-right font-mono text-slate-300">
                                            {row.orderCount}
                                          </td>
                                          <td className="py-3 px-4 text-right text-slate-200">
                                            {formatTHB(row.grossSales)}
                                          </td>
                                          <td className="py-3 px-4 text-right text-rose-400">
                                            -{formatTHB(row.deductions)}
                                          </td>
                                          <td className="py-3 px-4 text-right font-semibold text-emerald-400">
                                            {formatTHB(row.netSale)}
                                          </td>
                                          <td className="py-3 px-4 text-center">
                                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                                              <CheckCircle className="w-3 h-3" />
                                              <span>{row.reconciliationStatus}</span>
                                            </span>
                                          </td>
                                        </tr>

                                        {/* ─── Financial Breakdown Drawer (parsed JSONB) ─── */}
                                        {bExpanded && (
                                          <tr className="bg-black/30 border-t border-b border-white/10">
                                            <td colSpan={9} className="p-5">
                                              <FinancialBreakdownDrawer
                                                platform={row.platform}
                                                details={row.details}
                                                grossSales={row.grossSales}
                                              />
                                            </td>
                                          </tr>
                                        )}
                                      </React.Fragment>
                                    );
                                  })}
                              </React.Fragment>
                            );
                          })}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* ── MOBILE CARD VIEW (md:hidden) — mirrors the hierarchical drill-down ── */}
          <div className="md:hidden p-3 space-y-3">
            {isLoading ? (
              <div className="py-12 text-center text-slate-400">
                <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                <span>{TXT.loading}</span>
              </div>
            ) : grouped.length === 0 ? (
              <div className="py-12 text-center text-slate-400">
                {TXT.empty} ({settlements.length} total loaded)
              </div>
            ) : (
              grouped.map(([date, d]) => {
                const dateExpanded = expandedDates.has(date);
                const platforms = Array.from(d.platforms.entries()).sort((a, b) =>
                  a[0].localeCompare(b[0])
                );
                const branchCount = platforms.reduce(
                  (n, [, p]) => n + p.branches.length,
                  0
                );

                return (
                  <div
                    key={date}
                    className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden"
                  >
                    {/* ─── LEVEL 1: Date Card ─── */}
                    <button
                      type="button"
                      onClick={() => toggleDate(date)}
                      className="w-full p-3 text-left flex items-start justify-between gap-2 bg-white/[0.02]"
                    >
                      <div>
                        <div className="font-bold font-mono text-white text-sm">
                          {date}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          {branchCount} branches · {platforms.length} platforms
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                          <CheckCircle className="w-3 h-3" />
                          <span>{TXT.matched}</span>
                        </span>
                        {dateExpanded ? (
                          <ChevronDown className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-slate-500" />
                        )}
                      </div>
                    </button>

                    <div className="px-3 pb-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                          <div className="text-[10px] text-slate-400">{TXT.thGross}</div>
                          <div className="text-sm font-bold text-white">
                            {formatTHB(d.gross)}
                          </div>
                        </div>
                        <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                          <div className="text-[10px] text-slate-400">{TXT.thNet}</div>
                          <div className="text-sm font-bold text-emerald-400">
                            {formatTHB(d.net)}
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mt-2 text-[11px] text-slate-400">
                        <div>
                          {TXT.thOrders}{" "}
                          <span className="float-right font-mono text-slate-200">
                            {d.orders}
                          </span>
                        </div>
                        <div>
                          {TXT.thDeductions}{" "}
                          <span className="float-right font-mono text-rose-400">
                            -{formatTHB(d.ded)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* ─── LEVEL 2: Platform Cards (when date expanded) ─── */}
                    {dateExpanded && (
                      <div className="px-3 pb-3 pl-4 border-l-2 border-white/10 space-y-2">
                        {platforms.map(([platform, pf]) => {
                          const pfKey = `${date}|${platform}`;
                          const pfExpanded = expandedPlatforms.has(pfKey);

                          return (
                            <div
                              key={pfKey}
                              className="rounded-2xl border border-white/10 bg-[#0d1015] overflow-hidden"
                            >
                              <button
                                type="button"
                                onClick={() => togglePlatform(pfKey)}
                                className="w-full p-3 text-left flex items-center justify-between gap-2"
                              >
                                <div className="flex items-center gap-2">
                                  <PlatformBadge platform={platform} />
                                  <span className="text-[11px] text-slate-400">
                                    {pf.branches.length} branch(es)
                                  </span>
                                </div>
                                {pfExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
                                )}
                              </button>

                              <div className="px-3 pb-3">
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                                    <div className="text-[10px] text-slate-400">{TXT.thGross}</div>
                                    <div className="text-sm font-bold text-slate-200">
                                      {formatTHB(pf.gross)}
                                    </div>
                                  </div>
                                  <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                                    <div className="text-[10px] text-slate-400">{TXT.thNet}</div>
                                    <div className="text-sm font-bold text-emerald-400">
                                      {formatTHB(pf.net)}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex justify-between text-[11px] text-slate-400 mt-2">
                                  <span>
                                    {TXT.thOrders}{" "}
                                    <span className="font-mono text-slate-200">
                                      {pf.orders}
                                    </span>
                                  </span>
                                  <span>
                                    {TXT.thDeductions}{" "}
                                    <span className="font-mono text-rose-400">
                                      -{formatTHB(pf.ded)}
                                    </span>
                                  </span>
                                </div>
                              </div>

                              {/* ─── LEVEL 3: Branch Cards (when platform expanded) ─── */}
                              {pfExpanded && (
                                <div className="px-3 pb-3 pl-4 border-l-2 border-white/10 space-y-2">
                                  {pf.branches.map((row) => {
                                    const bKey = `${date}|${platform}|${row.branchCode}`;
                                    const bExpanded = expandedBranches.has(bKey);

                                    return (
                                      <div
                                        key={bKey}
                                        className="rounded-2xl border border-white/10 bg-black/20 overflow-hidden"
                                      >
                                        <button
                                          type="button"
                                          onClick={() => toggleBranch(bKey)}
                                          className="w-full p-3 text-left flex items-start justify-between gap-2"
                                        >
                                          <div>
                                            <div className="font-semibold text-white text-sm">
                                              {row.branchCode}
                                            </div>
                                            {row.branchCode === "—" ? (
                                              <span className="text-[10px] text-amber-400">
                                                ⚠ Missing branch mapping
                                              </span>
                                            ) : (
                                              <span className="text-[10px] text-emerald-400">
                                                {row.brandName} · {row.branchName}
                                              </span>
                                            )}
                                          </div>
                                          <div className="flex items-center gap-2 shrink-0">
                                            <PlatformBadge platform={row.platform} small />
                                            {bExpanded ? (
                                              <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
                                            ) : (
                                              <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
                                            )}
                                          </div>
                                        </button>

                                        <div className="px-3 pb-3">
                                          <div className="grid grid-cols-2 gap-2">
                                            <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                                              <div className="text-[10px] text-slate-400">{TXT.thGross}</div>
                                              <div className="text-sm font-bold text-slate-200">
                                                {formatTHB(row.grossSales)}
                                              </div>
                                            </div>
                                            <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                                              <div className="text-[10px] text-slate-400">{TXT.thNet}</div>
                                              <div className="text-sm font-bold text-emerald-400">
                                                {formatTHB(row.netSale)}
                                              </div>
                                            </div>
                                          </div>
                                          <div className="flex justify-between text-[11px] text-slate-400 mt-2">
                                            <span>
                                              {TXT.thOrders}{" "}
                                              <span className="font-mono text-slate-200">
                                                {row.orderCount}
                                              </span>
                                            </span>
                                            <span>
                                              {TXT.thDeductions}{" "}
                                              <span className="font-mono text-rose-400">
                                                -{formatTHB(row.deductions)}
                                              </span>
                                            </span>
                                          </div>
                                          {bExpanded && (
                                            <div className="mt-2 border-t border-white/10 pt-2">
                                              <FinancialBreakdownDrawer
                                                platform={row.platform}
                                                details={row.details}
                                                grossSales={row.grossSales}
                                              />
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
