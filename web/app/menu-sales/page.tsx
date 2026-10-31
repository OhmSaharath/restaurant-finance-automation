"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  ChefHat,
  FileUp,
  Info,
  Loader2,
  Receipt,
  Sparkles,
  Upload,
  X,
  AlertTriangle,
} from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { formatTHB } from "@/lib/utils";

/* =============================================================================
   Menu Sales -> Itemized COGS (Phase 2 frontend)
   ------------------------------------------------------------
   Upload a per-item menu sales report (Grab CSV or LINE MAN xlsx), preview the
   item-to-menu matching done by the FastAPI backend, then ingest. COGS per sold
   item is computed by the backend as (unit_cost x quantity); items that do not
   match an existing menu item are created with NO cost (never fabricated) so the
   owner can fill unit costs on the /bom Recipe & BOM page afterwards.

   Tenant isolation is handled entirely server-side by the
   /api/menu-sales/{scan,ingest} proxy routes — they resolve `brand_id` from the
   authenticated session and the browser never sends a brand_id. This page only
   needs the RLS-scoped `createClient()` for the link-to-branch reads below.
   ============================================================================= */

type Platform = "Grab" | "LINE MAN";

type MatchStatus =
  | "EXACT"
  | "CONTAINS"
  | "SKELETON"
  | "FUZZY"
  | "UNMATCHED"
  | string;

interface ScanRow {
  raw_item_name: string;
  quantity: number | string;
  item_gross: number | string | null;
  matched_menu_item_id: string | null;
  matched_item_name: string | null;
  match_status: MatchStatus;
}

interface ScanFileResult {
  filename: string;
  status: "ok" | "error";
  detected_dates: string[];
  rows: ScanRow[];
  row_count: number;
  matched_count: number;
  unmatched_count: number;
  error?: string | null;
}

interface ScanResult {
  status: string;
  platform: Platform;
  detected_dates: string[];
  detected_branches: string[];
  rows: ScanRow[];
  row_count: number;
  matched_count: number;
  unmatched_count: number;
  ok_count?: number;
  failed_count?: number;
  files?: ScanFileResult[];
}

interface IngestRow {
  raw_item_name: string;
  menu_item_id: string | null;
  cogs: number | string | null;
  match_status?: MatchStatus;
}

interface IngestFileResult {
  filename: string;
  status: "ok" | "error";
  report_dates: string[];
  ingested_rows: number;
  matched_rows: number;
  created_rows: number;
  cogs_total: number | string | null;
  error?: string | null;
}

interface IngestResult {
  status: string;
  platform: Platform;
  report_dates: string[];
  ingest_date: string | null;
  branch_id: string | null;
  ingested_rows: number;
  matched_rows: number;
  created_rows: number;
  cogs_total: number | string | null;
  costed_rows: number;
  rows: IngestRow[];
  total_ingested_rows?: number;
  total_matched_rows?: number;
  total_created_rows?: number;
  total_cogs?: number | string | null;
  ok_count?: number;
  failed_count?: number;
  files?: IngestFileResult[];
}

const STATUS_STYLES: Record<string, string> = {
  EXACT: "bg-emerald-500/15 border-emerald-500/30 text-emerald-300",
  CONTAINS: "bg-teal-500/15 border-teal-500/30 text-teal-300",
  SKELETON: "bg-cyan-500/15 border-cyan-500/30 text-cyan-300",
  FUZZY: "bg-amber-500/15 border-amber-500/30 text-amber-300",
  UNMATCHED: "bg-red-500/15 border-red-500/30 text-red-300",
};
const DEFAULT_STATUS_STYLE =
  "bg-white/5 border-white/10 text-slate-300";

function statusStyle(status: MatchStatus): string {
  return STATUS_STYLES[String(status).toUpperCase()] || DEFAULT_STATUS_STYLE;
}

export default function MenuSalesPage() {
  const [platform, setPlatform] = useState<Platform>("Grab");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);

  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null);

  const [successNote, setSuccessNote] = useState<string | null>(null);

  // Auto-dismiss the success note after a few seconds.
  useEffect(() => {
    if (!successNote) return;
    const t = window.setTimeout(() => setSuccessNote(null), 5000);
    return () => window.clearTimeout(t);
  }, [successNote]);

  const acceptFor = (_p: Platform) => ".csv,.xlsx,.xls";
  const dropHint = (p: Platform) =>
    p === "Grab"
      ? "Drop one or more Grab menu sales CSV(s) here, or click to browse"
      : "Drop one or more LINE MAN .xlsx here, or click to browse (single-day files only; a range file is rejected per-file)";

  /** "3 of 5 files processed; 2 rejected — <first reason>" (null when all ok). */
  function partialSummary(
    total: number,
    ok: number,
    files?: { error?: string | null }[]
  ): string | null {
    if (!files || files.length === 0 || total <= 1) return null;
    const failed = total - ok;
    if (failed <= 0) return null;
    const firstErr = files.find((f) => f.error);
    return `${ok} of ${total} files processed; ${failed} rejected${
      firstErr ? ` \u2014 ${firstErr.error}` : ""
    }.`;
  }

  /** Surface a clear, human message from a proxy/FastAPI error response. */
  function extractApiError(body: any, status: number, fallback: string): string {
    if (!body || typeof body !== "object") return fallback;
    const detail = body?.detail;
    if (typeof detail === "string" && detail.trim() !== "") return detail;
    // FastAPI HTTPException with a dict detail -> { error, message }.
    if (detail && typeof detail === "object") {
      const msg = detail.message ?? detail.msg ?? detail.error;
      if (typeof msg === "string" && msg.trim() !== "") return msg;
    }
    if (typeof body?.message === "string" && body.message.trim() !== "") {
      return body.message;
    }
    if (typeof body?.error === "string" && body.error.trim() !== "") {
      return body.error;
    }
    if (Array.isArray(detail) && detail.length > 0) {
      // FastAPI 422 validation detail is an array of {loc, msg}.
      const msg = detail[0]?.msg;
      if (typeof msg === "string") return msg;
    }
    return status === 422 ? "Could not parse this file." : fallback;
  }

  /** Detect the LINE MAN date-RANGE rejection and render it as a clear banner. */
  function isLineManRangeReject(body: any): boolean {
    if (platform !== "LINE MAN") return false;
    const hay = JSON.stringify(body ?? {});
    return /MULTI_?DATE|MULTI_DATE_FILE|range|single[- ]day|daily file|multiple date/i.test(hay);
  }

  const handleFilesSelect = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((f): f is File => !!f);
    if (!files.length) return;
    setSelectedFiles(files);
    setScanError(null);
    setIngestError(null);
    setIngestResult(null);
    setSuccessNote(null);
    setScanResult(null);

    const fd = new FormData();
    for (const f of files) fd.append("files", f, f.name);
    fd.append("platform", platform);
    setScanLoading(true);
    try {
      const res = await fetch("/api/menu-sales/scan", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (isLineManRangeReject(body)) {
          setScanError(
            "One or more LINE MAN files cover a date RANGE (multiple days). Please download single-day files and upload those — the system never averages or fabricates per-day figures."
          );
        } else {
          setScanError(extractApiError(body, res.status, "Could not scan the file(s)."));
        }
        return;
      }
      setScanResult(body as ScanResult);
    } catch (err: any) {
      setScanError(err?.message || "Could not scan the file(s).");
    } finally {
      setScanLoading(false);
    }
  };

  const handleIngest = async () => {
    if (!selectedFiles.length || !scanResult) return;
    setIngesting(true);
    setIngestError(null);
    setIngestResult(null);
    setSuccessNote(null);

    const fd = new FormData();
    for (const f of selectedFiles) fd.append("files", f, f.name);
    fd.append("platform", platform);
    try {
      const res = await fetch("/api/menu-sales/ingest", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (isLineManRangeReject(body)) {
          setIngestError(
            "One or more LINE MAN files cover a date RANGE (multiple days). Please download single-day files and upload those — the system never averages or fabricates per-day figures."
          );
        } else {
          setIngestError(
            extractApiError(body, res.status, "Could not ingest the file(s).")
          );
        }
        return;
      }
      const res2 = body as IngestResult;
      setIngestResult(res2);
      const created = res2.total_created_rows ?? res2.created_rows ?? 0;
      const ingested = res2.total_ingested_rows ?? res2.ingested_rows ?? 0;
      const matched = res2.total_matched_rows ?? res2.matched_rows ?? 0;
      const failed = res2.failed_count ?? 0;
      const msg =
        created > 0
          ? `Ingested ${ingested} row(s): ${matched} matched, ${created} created. ${created} new item(s) have NO cost — add them on the BOM page.`
          : `Ingested ${ingested} row(s): ${matched} matched, cross-checked.`;
      setSuccessNote(
        failed > 0 ? `${msg} ${failed} file(s) were rejected — see details below.` : msg
      );
    } catch (err: any) {
      setIngestError(err?.message || "Could not ingest the file(s).");
    } finally {
      setIngesting(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-[#050505] text-slate-100 subtle-mesh-bg">
      <Sidebar />
      <main className="flex-1 w-full md:ml-64 px-4 md:px-8 py-6">
        <Header />

        <div className="mb-6 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link
                href="/dashboard"
                className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Dashboard</span>
              </Link>
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <Receipt className="w-6 h-6 text-emerald-400" />
              <span>Menu Sales to COGS</span>
            </h1>
            <p className="text-xs text-slate-400 max-w-2xl">
              Upload a per-item menu sales report (Grab CSV or LINE MAN{" "}
              .xlsx). The system matches each sold item to your menu, snapshots
              the unit cost, and computes itemized{" "}
              <span className="text-emerald-400">COGS = cost × quantity</span>.
              Unmatched items are created with{" "}
              <span className="text-emerald-400">no cost</span> — enter their
              unit cost on the Recipe &amp; BOM page so future uploads compute
              COGS automatically.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/bom"
              className="py-2.5 px-4 bg-white/5 hover:bg-white/10 text-slate-200 rounded-2xl text-xs font-semibold border border-white/10 shadow-sm flex items-center gap-1.5 transition-all"
            >
              <ChefHat className="w-4 h-4 text-emerald-400" />
              <span>Enter Item Costs</span>
            </Link>
          </div>
        </div>

        {/* Toast / error surfaces */}
        {successNote && (
          <div
            className="mb-4 dark-glass rounded-2xl p-3 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2"
            role="status"
          >
            <Check className="w-4 h-4 shrink-0" />
            <span>{successNote}</span>
          </div>
        )}

        {(scanError || ingestError) && (
          <div
            className="mb-4 dark-glass rounded-2xl p-3 border border-red-500/30 text-red-300 text-xs flex items-center gap-2"
            role="alert"
          >
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{scanError || ingestError}</span>
          </div>
        )}

        {/* Platform selector */}
        <div className="dark-glass rounded-2xl border border-white/10 p-4 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-bold text-white">1 · Choose platform</span>
          </div>
          <div className="flex gap-2">
            {(["Grab", "LINE MAN"] as Platform[]).map((p) => (
              <button
                key={p}
                onClick={() => {
                  if (p !== platform) {
                    setPlatform(p);
                    setSelectedFiles([]);
                    setScanResult(null);
                    setScanError(null);
                    setIngestError(null);
                    setIngestResult(null);
                  }
                }}
                className={`flex-1 py-2.5 px-4 rounded-2xl text-xs font-semibold border transition-all ${
                  platform === p
                    ? "bg-gradient-to-r from-emerald-600 to-teal-600 text-white border-transparent shadow-lg shadow-emerald-600/20"
                    : "bg-white/5 hover:bg-white/10 text-slate-300 border-white/10"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* File drop zone */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <FileUp className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-bold text-white">
              2 · Upload sales report
            </span>
          </div>
          <label className="flex flex-col items-center justify-center gap-2 w-full border-2 border-dashed border-white/10 hover:border-emerald-500/40 rounded-2xl py-8 cursor-pointer transition-colors bg-white/[0.02]">
            <input
              type="file"
              multiple
              accept={acceptFor(platform)}
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) handleFilesSelect(e.target.files);
                e.target.value = "";
              }}
            />
            <Upload className="w-6 h-6 text-emerald-400" />
            <span className="text-xs text-slate-300">{dropHint(platform)}</span>
            {selectedFiles.length > 0 && (
              <ul className="text-[10px] text-emerald-400 flex flex-col items-center gap-0.5 max-w-full">
                {selectedFiles.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-1 max-w-full">
                    <FileUp className="w-3 h-3 shrink-0" />
                    <span className="truncate">{f.name}</span>
                  </li>
                ))}
              </ul>
            )}
            {scanLoading && (
              <span className="text-[10px] text-emerald-400 flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Scanning &amp; matching…
              </span>
            )}
          </label>
        </div>

        {/* Scan preview */}
        {scanResult && !scanLoading && (
          <>
            {(scanResult.failed_count ?? 0) > 0 && (
              <div
                className="mb-4 dark-glass rounded-2xl p-3 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2"
                role="status"
              >
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>
                  {(() => {
                    const total =
                      (scanResult.ok_count ?? 0) + (scanResult.failed_count ?? 0);
                    return (
                      partialSummary(total, scanResult.ok_count ?? 0, scanResult.files) ||
                      `${(scanResult.failed_count ?? 0)} of ${total} file(s) rejected.`
                    );
                  })()}{" "}
                  The preview below shows only the files that scanned successfully.
                </span>
              </div>
            )}
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <Info className="w-4 h-4 text-emerald-400" />
                <span className="text-sm font-bold text-white">
                  3 · Preview match results
                </span>
              </div>
              <div className="dark-glass rounded-3xl border border-white/10 overflow-hidden">
                <div className="px-4 py-3 flex flex-wrap gap-2 items-center">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">Detected dates</span>
                  {(scanResult.detected_dates || []).length > 0 ? (
                    (scanResult.detected_dates as string[]).map((d) => (
                      <span
                        key={`date-${d}`}
                        className="font-mono text-[10px] px-2 py-0.5 rounded bg-white/5 text-emerald-300 border border-emerald-500/20"
                      >
                        {d}
                      </span>
                    ))
                  ) : (
                    <span className="text-[10px] text-slate-500">—</span>
                  )}
                  <span className="mx-2 text-slate-700">·</span>
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">Branches</span>
                  {(scanResult.detected_branches || []).length > 0 ? (
                    (scanResult.detected_branches as string[]).map((b) => (
                      <span
                        key={`branch-${b}`}
                        className="text-[10px] px-2 py-0.5 rounded bg-white/5 text-slate-300 border border-white/10"
                      >
                        {b}
                      </span>
                    ))
                  ) : (
                    <span className="text-[10px] text-slate-500">All branches</span>
                  )}
                </div>
                <div className="px-4 py-2 flex flex-wrap gap-2">
                  <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                    {scanResult.matched_count} matched
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-300 border border-red-500/20">
                    {scanResult.unmatched_count} unmatched
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-white/5 text-slate-400 border border-white/10">
                    {scanResult.row_count} rows
                  </span>
                </div>
              </div>
            </div>

            <div className="dark-glass rounded-3xl border border-white/10 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-400">
                    <th className="py-3 px-4">Item</th>
                    <th className="py-3 px-4 text-right">Qty</th>
                    <th className="py-3 px-4 text-right">Gross (THB)</th>
                    <th className="py-3 px-4">Match</th>
                    <th className="py-3 px-4">Matched Menu Item</th>
                  </tr>
                </thead>
                <tbody>
                  {(scanResult.rows || []).map((row, idx) => (
                    <tr
                      key={`row-${idx}-${row.raw_item_name}`}
                      className="border-b border-white/5 hover:bg-white/5"
                    >
                      <td className="py-2.5 px-4 text-slate-200">
                        {row.raw_item_name}
                      </td>
                      <td className="py-2.5 px-4 text-right text-slate-300">
                        {row.quantity}
                      </td>
                      <td className="py-2.5 px-4 text-right text-slate-300">
                        {row.item_gross === null || row.item_gross === undefined
                          ? "—"
                          : formatTHB(row.item_gross)}
                      </td>
                      <td className="py-2.5 px-4">
                        <span
                          className={`px-2 py-0.5 rounded text-[9px] font-semibold border ${statusStyle(
                            row.match_status
                          )}`}
                        >
                          {row.match_status || "—"}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-slate-300">
                        {row.matched_item_name || (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={handleIngest}
                disabled={ingesting || (scanResult.row_count || 0) === 0}
                className="py-2.5 px-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-2xl text-xs font-semibold shadow-lg shadow-emerald-600/20 flex items-center gap-2 transition-all active:scale-95 disabled:opacity-50"
              >
                {ingesting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                <span>
                  {ingesting
                    ? "Ingesting…"
                    : "Ingest & compute itemized COGS"}
                </span>
              </button>
              <span className="text-[10px] text-slate-500">
                Unmatched items are created with no cost. Review them on the BOM
                page afterwards.
              </span>
            </div>
          </>
        )}

        {/* Ingest result */}
        {ingestResult && (
          <div className="mb-4 dark-glass rounded-3xl border border-white/10 overflow-hidden">
            <div className="px-4 py-3 flex items-center gap-2">
              <Info className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-bold text-white">
                Ingest summary
              </span>
            </div>
            <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <div className="rounded-2xl bg-white/5 border border-white/10 p-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Ingested rows</p>
                <p className="text-lg font-bold text-white">{ingestResult.total_ingested_rows ?? ingestResult.ingested_rows}</p>
              </div>
              <div className="rounded-2xl bg-emerald-500/5 border border-emerald-500/20 p-3">
                <p className="text-[10px] uppercase tracking-wider text-emerald-400">Matched</p>
                <p className="text-lg font-bold text-emerald-300">{ingestResult.total_matched_rows ?? ingestResult.matched_rows}</p>
              </div>
              <div className="rounded-2xl bg-amber-500/5 border border-amber-500/20 p-3">
                <p className="text-[10px] uppercase tracking-wider text-amber-400">Created (no cost)</p>
                <p className="text-lg font-bold text-amber-300">{ingestResult.total_created_rows ?? ingestResult.created_rows}</p>
              </div>
              <div className="rounded-2xl bg-emerald-500/5 border border-emerald-500/20 p-3">
                <p className="text-[10px] uppercase tracking-wider text-emerald-400">Costed rows</p>
                <p className="text-lg font-bold text-emerald-300">{ingestResult.costed_rows}</p>
              </div>
              <div className="rounded-2xl bg-white/5 border border-white/10 p-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Total COGS</p>
                <p className="text-lg font-bold text-emerald-300">
                  {formatTHB(ingestResult.total_cogs ?? ingestResult.cogs_total)}
                </p>
              </div>
            </div>
            {ingestResult.files && ingestResult.files.length > 0 && (
              <div className="mt-2 border-t border-white/10 px-4 py-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">
                  Per-file results
                </p>
                <div className="flex flex-col gap-2">
                  {ingestResult.files.map((fr, i) => (
                    <div
                      key={`file-${fr.filename}-${i}`}
                      className={`rounded-2xl border p-3 ${
                        fr.status === "error"
                          ? "bg-red-500/5 border-red-500/20"
                          : "bg-white/5 border-white/10"
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`px-2 py-0.5 rounded text-[9px] font-semibold border ${
                            fr.status === "error"
                              ? "bg-red-500/15 border-red-500/30 text-red-300"
                              : "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
                          }`}
                        >
                          {fr.status === "error" ? "REJECTED" : "OK"}
                        </span>
                        <span className="flex-1 text-xs text-slate-200 truncate">
                          {fr.filename}
                        </span>
                        {fr.status === "error" ? (
                          <span className="text-[10px] text-red-300 max-w-[55%]">
                            {fr.error || "Could not parse this file."}
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-400">
                            {fr.report_dates.join(", ")} · {fr.ingested_rows} rows ·{" "}
                            {fr.matched_rows} matched · {fr.created_rows} created ·{" "}
                            {formatTHB(fr.cogs_total)} COGS
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-2 border-t border-white/10 px-4 py-2.5 text-[10px] text-slate-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>
                {(() => {
                  const created = ingestResult.total_created_rows ?? ingestResult.created_rows ?? 0;
                  const matched = ingestResult.total_matched_rows ?? ingestResult.matched_rows ?? 0;
                  const failed = ingestResult.failed_count ?? 0;
                  return failed > 0
                    ? `${failed} file(s) were rejected and wrote nothing — see details above.`
                    : created > 0
                      ? `${created} item(s) were created with NO cost — they contribute nothing to COGS until you enter a unit cost on the Recipe & BOM page.`
                      : `All ${matched} row(s) carried a known cost and now contribute to COGS.`;
                })()}
              </span>
              <Link
                href="/bom"
                className="text-emerald-400 hover:text-emerald-300 underline"
              >
                Go to BOM
              </Link>
            </div>
          </div>
        )}

        <p className="mt-4 text-[10px] text-slate-500">
          COGS is computed server-side as cost × quantity with NUMERIC(12,2)
          precision; rows without a known cost never fabricate a figure. Data is
          tenant-isolated — brand is resolved server-side, never from the
          browser.
        </p>
      </main>
    </div>
  );
}
