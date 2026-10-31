"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, CheckCircle, FileSpreadsheet, Inbox, Loader2 } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { formatTHB } from "@/lib/utils";

interface AuditRow {
  id: string | number;
  report_date?: string;
  order_count?: number | string | null;
  gross_sales?: number | string | null;
  deductions?: number | string | null;
  net_sale?: number | string | null;
  branches?: { branch_name?: string | null; brands?: { name?: string | null } | null } | null;
}

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/reconciliation", { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.success || !Array.isArray(body.data)) {
          throw new Error(body?.error || "Could not load audit records.");
        }
        if (active) setRows(body.data as AuditRow[]);
      })
      .catch((err: any) => {
        if (active) setError(err?.message || "Could not load audit records.");
      });
    return () => {
      active = false;
    };
  }, []);

  const summary = useMemo(() => {
    const source = rows || [];
    let orders = 0;
    let gross = 0;
    let deductions = 0;
    let mismatches = 0;
    for (const row of source) {
      orders += numberOrNull(row.order_count) || 0;
      const rowGross = numberOrNull(row.gross_sales);
      const rowDeductions = numberOrNull(row.deductions);
      const rowNet = numberOrNull(row.net_sale);
      if (rowGross !== null) gross += rowGross;
      if (rowDeductions !== null) deductions += rowDeductions;
      if (rowGross !== null && rowDeductions !== null && rowNet !== null) {
        if (Math.abs(rowGross - rowDeductions - rowNet) > 0.01) mismatches += 1;
      }
    }
    return { reports: source.length, orders, gross, deductions, mismatches };
  }, [rows]);

  return (
    <div className="min-h-screen flex bg-[#050505] text-slate-100 subtle-mesh-bg">
      <Sidebar />
      <main className="flex-1 w-full md:ml-64 px-4 md:px-8 py-6">
        <Header settlementPeriod="Live audit records" />

        <div className="mb-6">
          <Link href="/dashboard" className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 mb-2">
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Dashboard</span>
          </Link>
          <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <FileSpreadsheet className="w-6 h-6 text-emerald-400" />
            <span>Audit &amp; Settlement Logs</span>
          </h1>
          <p className="text-xs text-slate-400">
            Live reconciliation checks from the current tenant scope. No seeded or assumed figures are shown.
          </p>
        </div>

        {error && (
          <div className="dark-glass rounded-2xl p-4 border border-red-500/30 text-red-300 text-sm flex items-center gap-2" role="alert">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {rows === null && !error ? (
          <div className="dark-glass rounded-3xl p-12 border border-white/10 text-center text-slate-400">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-emerald-400" />
            Loading live audit records…
          </div>
        ) : rows && rows.length === 0 ? (
          <div className="dark-glass rounded-3xl p-12 border border-white/10 text-center space-y-3">
            <Inbox className="w-12 h-12 text-slate-600 mx-auto" />
            <h2 className="text-lg font-bold text-white">No audit records yet</h2>
            <p className="text-sm text-slate-400">Sync a settlement report to create the first audit record.</p>
          </div>
        ) : rows ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              <div className="dark-glass rounded-2xl p-4 border border-white/10">
                <p className="text-xs text-slate-400">Settlement reports</p>
                <p className="text-2xl font-bold text-white mt-1">{summary.reports.toLocaleString()}</p>
              </div>
              <div className="dark-glass rounded-2xl p-4 border border-white/10">
                <p className="text-xs text-slate-400">Orders</p>
                <p className="text-2xl font-bold text-white mt-1">{summary.orders.toLocaleString()}</p>
              </div>
              <div className="dark-glass rounded-2xl p-4 border border-white/10">
                <p className="text-xs text-slate-400">Gross sales</p>
                <p className="text-2xl font-bold text-white mt-1">{formatTHB(summary.gross)}</p>
              </div>
              <div className={`dark-glass rounded-2xl p-4 border ${summary.mismatches ? "border-amber-500/30" : "border-emerald-500/30"}`}>
                <p className="text-xs text-slate-400">Balance checks</p>
                <p className={`text-2xl font-bold mt-1 ${summary.mismatches ? "text-amber-300" : "text-emerald-300"}`}>
                  {summary.mismatches ? `${summary.mismatches} issue(s)` : "Passed"}
                </p>
              </div>
            </div>

            <div className="dark-glass rounded-3xl border border-white/10 overflow-hidden">
              <div className="px-5 py-4 border-b border-white/10 flex items-center gap-2">
                {summary.mismatches ? <AlertTriangle className="w-4 h-4 text-amber-300" /> : <CheckCircle className="w-4 h-4 text-emerald-400" />}
                <span className="text-sm font-semibold text-white">{summary.mismatches ? "Review balance exceptions" : "All loaded rows balance"}</span>
              </div>
              <div className="max-h-[520px] overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-[#11141b] text-slate-400">
                    <tr>
                      <th className="text-left px-5 py-3">Date</th>
                      <th className="text-left px-5 py-3">Brand / branch</th>
                      <th className="text-right px-5 py-3">Gross</th>
                      <th className="text-right px-5 py-3">Deductions</th>
                      <th className="text-right px-5 py-3">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 200).map((row) => {
                      const gross = numberOrNull(row.gross_sales);
                      const deductions = numberOrNull(row.deductions);
                      const net = numberOrNull(row.net_sale);
                      const mismatch = gross !== null && deductions !== null && net !== null && Math.abs(gross - deductions - net) > 0.01;
                      return (
                        <tr key={String(row.id)} className="border-t border-white/5">
                          <td className="px-5 py-3 text-slate-300">{row.report_date || "—"}</td>
                          <td className="px-5 py-3 text-slate-300">{row.branches?.brands?.name || "—"} / {row.branches?.branch_name || "—"}</td>
                          <td className="px-5 py-3 text-right text-slate-200">{gross === null ? "—" : formatTHB(gross)}</td>
                          <td className="px-5 py-3 text-right text-rose-300">{deductions === null ? "—" : `-${formatTHB(deductions)}`}</td>
                          <td className={`px-5 py-3 text-right ${mismatch ? "text-amber-300" : "text-emerald-300"}`}>{net === null ? "—" : formatTHB(net)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
