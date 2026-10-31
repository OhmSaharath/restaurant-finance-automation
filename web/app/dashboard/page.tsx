"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  DollarSign,
  Receipt,
  Wallet,
  TrendingUp,
  X,
  UploadCloud,
  CheckCircle,
  Inbox,
  RefreshCw,
  Calendar,
} from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { KpiCard } from "@/components/KpiCard";
import { RevenueChart } from "@/components/RevenueChart";
import { DeductionBreakdown } from "@/components/DeductionBreakdown";
import { CogsGauge } from "@/components/CogsGauge";
import dynamic from "next/dynamic";
import { getLiveDashboardData, DashboardData } from "@/lib/data";
import { createClient } from "@/lib/supabase/client";

const BranchCardDeck = dynamic(
  () => import("@/components/BranchCardDeck").then((mod) => mod.BranchCardDeck),
  { ssr: false, loading: () => <div className="h-72 bg-white/5 rounded-3xl animate-pulse" /> }
);
const LocationMap = dynamic(
  () => import("@/components/ui/expand-map").then((mod) => mod.LocationMap),
  { ssr: false, loading: () => <div className="h-72 bg-white/5 rounded-3xl animate-pulse" /> }
);

interface OverviewResult {
  success: boolean;
  brand_id: string;
  range: { start_date: string; end_date: string };
  report_count: number;
  total_gross: number;
  total_deductions: number;
  total_net_payout: number;
  total_orders: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [overview, setOverview] = useState<OverviewResult | null>(null);
  const [noOverviewData, setNoOverviewData] = useState(false);
  const [activeBranchIndex, setActiveBranchIndex] = useState(0);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [uploadPlatform, setUploadPlatform] = useState<"Grab" | "LINE MAN">("Grab");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDateLoading, setIsDateLoading] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);

  // ---- Dynamic date range: defaults to the current month (navigable to history) ----
  // Standard JS (no date-fns). start = first day of month, end = today.
  const toISODate = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const nowD = new Date();
  const [startDate, setStartDate] = useState(
    toISODate(new Date(nowD.getFullYear(), nowD.getMonth(), 1))
  );
  const [endDate, setEndDate] = useState(
    // Keep the default window identical to Daily P&L: month start through today.
    toISODate(nowD)
  );
  const [appliedStart, setAppliedStart] = useState(startDate);
  const [appliedEnd, setAppliedEnd] = useState(endDate);

  useEffect(() => {
    let isMounted = true;

    const checkAuthAndSync = async (applyStart: string, applyEnd: string) => {
      try {
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();

        if (!session) {
          if (isMounted) {
            router.push("/login");
          }
          return;
        }

        // Live tenant-isolated aggregation from the FastAPI/PostgREST layer.
        // Hard single source of truth: NO mocked numbers are rendered when the
        // tenant has zero settlement records for the window.
        const ovRes = await fetch(
          `/api/analytics/overview?start_date=${applyStart}&end_date=${applyEnd}`
        );
        const ovJson = await ovRes.json();

        if (isMounted && ovJson.success) {
          setOverview(ovJson);
          if (!ovJson.report_count) {
            setNoOverviewData(true);
          }
        }

        // Full live dashboard payload (totals, daily-by-platform chart,
        // deduction decomposition, per-branch liquidity, itemized COGS) from
        // the tenant-isolated /api/analytics/dashboard + branches routes.
        // Returns null — never mock data — when there are no settlements for
        // the window (report_count 0) or on failure, which drives the explicit
        // empty state below instead of any fabricated figure.
        const live = await getLiveDashboardData(applyStart, applyEnd);
        if (isMounted && live) {
          setData(live);
        }
      } catch (err) {
        console.warn("Auth & overview fallback:", err);
      } finally {
        if (isMounted) {
          setIsLoading(false);
          setIsDateLoading(false);
        }
      }
    };

    checkAuthAndSync(appliedStart, appliedEnd);

    return () => {
      isMounted = false;
    };
  }, [router, appliedStart, appliedEnd, dataVersion]);

  const applyDateRange = () => {
    if (startDate > endDate) return;
    setAppliedStart(startDate);
    setAppliedEnd(endDate);
    setIsDateLoading(true);
    setActiveBranchIndex(0);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadStatus("uploading");
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("platform", uploadPlatform);
      const res = await fetch("/api/integrations/settlement/upload", { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message || body?.error || "Settlement ingestion failed.");
      setUploadStatus("success");
      setNoOverviewData(false);
      setDataVersion((value) => value + 1);
    } catch (err: any) {
      setUploadStatus("error");
      setUploadError(err?.message || "Settlement ingestion failed.");
    }
  };

  const brandName =
    (data && data.brandName) || "Workspace";
  const activeBranch = (data?.branches || [])[activeBranchIndex] || (data?.branches || [])[0];

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-xs font-semibold text-slate-400">Securing workspace session...</p>
        </div>
      </div>
    );
  }

  // ---- Empty state: no settlement records for the selected window ----
  // Do NOT render mocked statistics, charts, or hardcoded branch metrics.
  if (noOverviewData || !data) {
    return (
      <div className="min-h-screen flex bg-[#050505] text-slate-100 subtle-mesh-bg">
        <Sidebar brandName={brandName} />
        <main className="flex-1 w-full md:ml-64 px-4 md:px-8 py-6">
          <Header
            brandName={brandName}
            settlementPeriod={
              overview?.range
                ? `${overview.range.start_date} to ${overview.range.end_date}`
                : "No settlements yet"
            }
            onUploadClick={() => setIsUploadModalOpen(true)}
          />
          <section className="flex flex-col items-center justify-center p-12 border border-zinc-800 rounded-2xl bg-zinc-950 text-center max-w-3xl mx-auto">
            <Inbox className="w-12 h-12 text-zinc-600 mb-4" />
            <h3 className="text-lg font-semibold text-zinc-200">No Settlement Data Found</h3>
            <p className="text-sm text-zinc-500 max-w-sm mt-1 mb-6">
              No delivery platform settlements have been synced for this period.
            </p>
            <Link
              href="/reconciliation"
              className="inline-flex items-center gap-2 py-2.5 px-5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-sm font-semibold shadow-md hover:brightness-110 active:scale-95"
            >
              <RefreshCw className="w-4 h-4" />
              Sync Settlement
            </Link>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-[#050505] text-slate-100 subtle-mesh-bg">
      {/* Left Navigation Sidebar */}
      <Sidebar brandName={brandName} />

      {/* Main Content Area */}
      <main className="flex-1 w-full md:ml-64 px-4 md:px-8 py-6">
        {/* Header Bar */}
        <Header
          brandName={`${brandName}`}
          settlementPeriod={data.settlementPeriod}
          onUploadClick={() => setIsUploadModalOpen(true)}
        />

        {/* Dynamic Date-Range Picker — drives the Card Deck + KPIs reactively */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-300">
            <Calendar className="w-3.5 h-3.5 text-emerald-400" />
            <label className="text-[10px] text-slate-400 uppercase tracking-wider">From</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="bg-transparent text-white focus:outline-none text-xs"
            />
            <span className="text-slate-500">to</span>
            <label className="text-[10px] text-slate-400 uppercase tracking-wider">To</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="bg-transparent text-white focus:outline-none text-xs"
            />
          </div>
          <button
            onClick={applyDateRange}
            disabled={isDateLoading}
            aria-label="Apply date range"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-semibold hover:bg-emerald-500/20 transition-all active:scale-95"
          >
            {isDateLoading ? (
              <span className="w-3.5 h-3.5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Apply Range
          </button>
          <span className="text-[10px] text-slate-500">
            {appliedStart} → {appliedEnd} · {data.branches.length} active branch(es)
          </span>
        </div>

        {/* 4 Top KPI Cards — live aggregated figures from /api/analytics/overview */}
        {overview && overview.report_count > 0 ? (
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            <KpiCard
              titleEn="Total Gross"
              titleTh="ยอดขายรวมทุกช่องทาง"
              amount={overview.total_gross}
              deltaPercent={0}
              deltaIsPositiveGood={true}
              subtitle={`${overview.total_orders} total orders`}
              sparklineColor="#6366f1"
              iconBg="bg-indigo-50 text-indigo-600"
              icon={<DollarSign className="w-5 h-5" />}
            />
            <KpiCard
              titleEn="Total Deductions"
              titleTh="ยอดหัก GP / Ads / VAT"
              amount={overview.total_deductions}
              deltaPercent={0}
              deltaIsPositiveGood={false}
              subtitle={`${overview.report_count} settlement report(s)`}
              sparklineColor="#a855f7"
              iconBg="bg-purple-50 text-purple-600"
              icon={<Receipt className="w-5 h-5" />}
            />
            <KpiCard
              titleEn="Net Delivery Payout"
              titleTh="ยอดเงินโอนเข้าบัญชีสุทธิ"
              amount={overview.total_net_payout}
              deltaPercent={0}
              deltaIsPositiveGood={true}
              subtitle="Reconciled to Bank"
              sparklineColor="#10b981"
              iconBg="bg-emerald-50 text-emerald-600"
              icon={<Wallet className="w-5 h-5" />}
            />
            <KpiCard
              titleEn="Total Orders"
              titleTh="จำนวนคำสั่งซื้อรวม"
              amount={overview.total_orders}
              format="count"
              deltaPercent={0}
              deltaIsPositiveGood={true}
              subtitle={`${overview.range.start_date} → ${overview.range.end_date}`}
              sparklineColor="#0ea5e9"
              iconBg="bg-sky-50 text-sky-600"
              icon={<TrendingUp className="w-5 h-5" />}
            />
          </section>
        ) : null}

        {/* Center: 3D Coverflow Physical Card Carousel & Expandable Location Map */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8 items-stretch">
          <div className="lg:col-span-2">
            <BranchCardDeck
              branches={data.branches}
              activeBranchIndex={activeBranchIndex}
              onSelectBranchIndex={setActiveBranchIndex}
            />
          </div>

          <div className="lg:col-span-1 flex flex-col">
            <LocationMap
              location={activeBranch?.name}
              coordinates={activeBranch?.coordinates}
              branchCode={activeBranch?.code}
              platforms={[activeBranch?.dominantPlatform]}
              className="h-full min-h-[280px]"
            />
          </div>
        </section>

        {/* Analytics Visualizations Grid */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          {/* Platform Revenue Volume Chart */}
          <div className="lg:col-span-2">
            <RevenueChart data={data.dailyChartData} />
          </div>

          {/* COGS & Food Cost Ratio Gauge */}
          <div className="lg:col-span-1">
            <CogsGauge
              currentCogsPct={data.foodCostPct}
              benchmarkPct={35.0}
              totalCogsAmount={data.totalCogs}
              realNetProfit={data.realNetProfit}
            />
          </div>
        </section>

        {/* Platform Fee & Deduction Decomposition */}
        <section className="mb-8">
          <DeductionBreakdown data={data.deductions} grossSales={data.grossSales} />
        </section>
      </main>

      {/* Upload Settlement Modal */}
      {isUploadModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="glass-card rounded-3xl p-8 max-w-lg w-full border border-white relative shadow-2xl animate-in fade-in zoom-in-95">
            <button
              onClick={() => {
                setIsUploadModalOpen(false);
                setUploadStatus("idle");
                setUploadError(null);
              }}
              className="absolute right-5 top-5 p-2 text-slate-400 hover:text-slate-700 rounded-xl"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                <UploadCloud className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Upload Delivery Settlement
                </h3>
                <p className="text-xs text-slate-500">
                  Supports Grab PDF/CSV and LINE MAN CSV/XLSX files
                </p>
              </div>
            </div>

            {uploadStatus === "idle" && (
              <label className="block mb-4 text-xs text-slate-600">
                Platform
                <select
                  value={uploadPlatform}
                  onChange={(e) => setUploadPlatform(e.target.value as "Grab" | "LINE MAN")}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                >
                  <option value="Grab">Grab</option>
                  <option value="LINE MAN">LINE MAN</option>
                </select>
              </label>
            )}

            {uploadStatus === "idle" && (
              <div className="border-2 border-dashed border-slate-200 hover:border-indigo-400 rounded-2xl p-8 text-center transition-colors cursor-pointer relative bg-slate-50/50">
                <input
                  type="file"
                  accept={uploadPlatform === "Grab" ? ".csv,.pdf" : ".csv,.xlsx"}
                  onChange={handleFileUpload}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
                <UploadCloud className="w-8 h-8 text-indigo-500 mx-auto mb-2" />
                <p className="text-xs font-semibold text-slate-700">
                  Click or drag settlement export file here
                </p>
                <p className="text-[11px] text-slate-400 mt-1">
                  Automatic branch resolution & idempotent upsert
                </p>
              </div>
            )}

            {uploadStatus === "uploading" && (
              <div className="p-8 text-center">
                <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                <p className="text-xs font-semibold text-slate-700">
                  Parsing settlement rows & calculating COGS...
                </p>
              </div>
            )}

            {uploadStatus === "error" && (
              <div className="p-6 text-center bg-red-50 rounded-2xl border border-red-100">
                <p className="text-sm font-bold text-red-900">Settlement ingestion failed</p>
                <p className="text-xs text-red-700 mt-1">{uploadError || "Please check the file and try again."}</p>
                <button
                  onClick={() => { setUploadStatus("idle"); setUploadError(null); }}
                  className="mt-4 py-2 px-4 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-semibold"
                >
                  Choose another file
                </button>
              </div>
            )}

            {uploadStatus === "success" && (
              <div className="p-6 text-center bg-emerald-50/60 rounded-2xl border border-emerald-100">
                <CheckCircle className="w-10 h-10 text-emerald-600 mx-auto mb-2" />
                <h4 className="text-sm font-bold text-emerald-900">
                  Ingestion Successfully Completed
                </h4>
                <p className="text-xs text-emerald-700 mt-1">
                  Settlement records reconciled to branches under {brandName}.
                </p>
                <button
                  onClick={() => {
                    setIsUploadModalOpen(false);
                    setUploadStatus("idle");
                  }}
                  className="mt-4 py-2 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold"
                >
                  Return to Dashboard
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
